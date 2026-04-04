// Package mitm implements the ASHP man-in-the-middle HTTP/HTTPS proxy. It
// intercepts both plaintext HTTP and TLS-tunneled HTTPS requests, applies
// rule-based access control, and logs request/response metadata (and
// optionally bodies) to the control plane via IPC.
//
// # Request lifecycle
//
//  1. CONNECT handler: authenticates the agent via Proxy-Authorization,
//     issues a per-host TLS certificate signed by the root CA, and
//     establishes a MITM TLS session with the client.
//  2. Request handler: evaluates the request URL and method against the
//     loaded rules. Depending on the matched rule action (allow/deny) or the
//     default behavior (deny/hold/queue), the request is forwarded, blocked,
//     or held pending approval.
//  3. Response handler: for allowed requests, captures the response body
//     (per rule policy) and sends a request.logged IPC message.
//
// # Default behavior modes
//
//   - deny:  reject unmatched requests with 403.
//   - hold:  block the goroutine and send an approval.needed IPC message;
//     wait for approval.resolve or timeout, then forward or reject.
//   - queue: reject but log for later rule creation.
package mitm

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/elazarl/goproxy"
	"github.com/jdk/ashp/proxy/internal/auth"
	"github.com/jdk/ashp/proxy/internal/ca"
	"github.com/jdk/ashp/proxy/internal/ipc"
	"github.com/jdk/ashp/proxy/internal/logger"
	"github.com/jdk/ashp/proxy/internal/rules"
)

// Config holds all dependencies and settings needed to construct a [Proxy].
type Config struct {
	CA              tls.Certificate                    // Root CA cert+key for signing host certificates.
	Evaluator       *rules.Evaluator                   // Rule matching engine.
	Auth            *auth.Handler                      // Agent authentication handler.
	LogDir          string                             // Directory for encrypted log files.
	LogKey          []byte                             // AES-256 master key for log encryption (nil to disable).
	IPC             *ipc.Client                        // IPC client for control-plane communication.
	DefaultBehavior string                             // Default action for unmatched requests: "deny", "hold", or "queue".
	HoldRequest     func(msg ipc.Message) (approved bool) // Blocking callback for hold mode; returns true if approved.
}

// Proxy wraps a goproxy.ProxyHttpServer with ASHP authentication, rule
// evaluation, body logging, and IPC reporting. It is created with [New] and
// started with [Start].
type Proxy struct {
	gp              *goproxy.ProxyHttpServer
	evaluator       *rules.Evaluator
	auth            *auth.Handler
	logWriter       *logger.Writer
	ipc             *ipc.Client
	ln              net.Listener
	ca              tls.Certificate
	defaultBehavior string
	holdRequest     func(msg ipc.Message) (approved bool)
}

// RequestContext holds the information needed to evaluate a proxied request.
// Shared between the goproxy handler and transparent listeners.
type RequestContext struct {
	AgentID string
	FullURL string
	Method  string
	Mode    string // "proxy" or "transparent"
}

// RequestDecision is the result of evaluating a request against the rule engine.
type RequestDecision struct {
	Action string      // "allow", "deny", "hold", "queue"
	Rule   *rules.Rule // matched rule, or nil if default behavior was used
}

// evaluateRequest matches the request against rules and returns the decision.
// It does NOT capture bodies or send IPC — the caller handles that.
func (p *Proxy) evaluateRequest(ctx RequestContext) RequestDecision {
	rule := p.evaluator.Match(ctx.AgentID, ctx.FullURL, ctx.Method)
	if rule != nil {
		return RequestDecision{Action: rule.Action, Rule: rule}
	}
	return RequestDecision{Action: p.defaultBehavior}
}

// New constructs a fully configured Proxy. It wires up three goproxy handlers:
//
//   - CONNECT handler: authenticates the agent and sets up MITM TLS.
//   - Request handler: evaluates rules and enforces allow/deny/hold/queue.
//   - Response handler: captures response bodies and sends IPC logs for
//     allowed requests.
//
// The returned Proxy is not yet listening; call [Proxy.Start] to bind.
func New(cfg Config) *Proxy {
	gp := goproxy.NewProxyHttpServer()
	lw, _ := logger.NewWriter(cfg.LogDir, cfg.LogKey)

	p := &Proxy{
		gp: gp, evaluator: cfg.Evaluator, auth: cfg.Auth,
		logWriter: lw, ipc: cfg.IPC,
		ca:              cfg.CA,
		defaultBehavior: cfg.DefaultBehavior,
		holdRequest:     cfg.HoldRequest,
	}

	// connectReject407 is a goproxy ConnectAction that hijacks the CONNECT
	// tunnel to return a 407 Proxy Authentication Required response,
	// prompting the client to resend with Basic credentials.
	connectReject407 := &goproxy.ConnectAction{
		Action: goproxy.ConnectHijack,
		Hijack: func(req *http.Request, client net.Conn, ctx *goproxy.ProxyCtx) {
			resp := "HTTP/1.1 407 Proxy Authentication Required\r\n" +
				"Proxy-Authenticate: Basic realm=\"ASHP Proxy\"\r\n" +
				"Content-Length: 0\r\n" +
				"Connection: close\r\n\r\n"
			client.Write([]byte(resp))
			client.Close()
		},
	}

	// CONNECT handler: authenticate at tunnel establishment time, then set
	// up MITM TLS with a dynamically-signed certificate for the target host.
	// The authenticated agent ID is stored in ctx.UserData so the downstream
	// request handler can retrieve it without re-authenticating.
	gp.OnRequest().HandleConnect(goproxy.FuncHttpsHandler(
		func(host string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
			agentID, ok := p.auth.Authenticate(ctx.Req)
			if !ok {
				return connectReject407, host
			}
			ctx.UserData = agentID
			return &goproxy.ConnectAction{
				Action: goproxy.ConnectMitm,
				TLSConfig: func(host string, ctx *goproxy.ProxyCtx) (*tls.Config, error) {
					hostname, _, _ := strings.Cut(host, ":")
					cert, err := ca.SignHost(cfg.CA.Leaf, cfg.CA.PrivateKey, hostname)
					if err != nil {
						return nil, err
					}
					return &tls.Config{Certificates: []tls.Certificate{cert}}, nil
				},
			}, host
		},
	))

	// Request handler: runs for every HTTP request (both plaintext and
	// MITM'd HTTPS). Determines the agent identity, reconstructs the full
	// URL, matches rules, and enforces the configured action/behavior.
	gp.OnRequest().DoFunc(func(req *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
		// For MITM'd HTTPS requests, agentID was set during CONNECT.
		var agentID string
		if id, ok := ctx.UserData.(string); ok {
			agentID = id
		} else {
			// Plain HTTP request -- authenticate from header.
			var authed bool
			agentID, authed = p.auth.Authenticate(req)
			if !authed {
				return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 407, "Proxy Authentication Required")
			}
		}
		req.Header.Del("Proxy-Authorization")

		// Reconstruct the canonical full URL for rule matching.
		// goproxy sets req.URL with full scheme+host for CONNECT'd requests,
		// but for plain HTTP the URL may be relative (path-only).
		fullURL := req.URL.String()
		if req.URL.Scheme == "" {
			scheme := "https"
			if req.TLS == nil {
				scheme = "http"
			}
			host := req.Host
			// Strip default ports so rules can match without port suffixes.
			host = strings.TrimSuffix(host, ":443")
			host = strings.TrimSuffix(host, ":80")
			fullURL = scheme + "://" + host + req.URL.RequestURI()
		} else {
			// Strip default ports from absolute URLs too.
			hostname := req.URL.Hostname()
			port := req.URL.Port()
			if (req.URL.Scheme == "https" && port == "443") || (req.URL.Scheme == "http" && port == "80") {
				fullURL = req.URL.Scheme + "://" + hostname + req.URL.RequestURI()
			}
		}
		decision := p.evaluateRequest(RequestContext{
			AgentID: agentID, FullURL: fullURL, Method: req.Method, Mode: "proxy",
		})
		rule := decision.Rule

		// Override default behavior if the matched rule specifies one.
		action := decision.Action
		if rule != nil && rule.Action != "allow" && rule.Action != "deny" && rule.DefaultBehavior != "" {
			action = rule.DefaultBehavior
		}

		switch action {
		case "deny":
			if rule != nil {
				// Explicit deny rule: block immediately and optionally log the body.
				var reqBodyRef string
				if rule.LogRequestBody != "" && rule.LogRequestBody != "none" {
					ref, _ := p.captureBody(req.Body, rule.LogRequestBody)
					reqBodyRef = ref
				}
				ipcData := map[string]interface{}{
					"agent_id": agentID, "url": fullURL, "method": req.Method, "decision": "denied", "reason": "rule_deny",
					"rule_id": rule.ID,
				}
				if reqBodyRef != "" {
					ipcData["request_body_ref"] = reqBodyRef
				}
				p.sendIPC("request.blocked", ipcData)
				return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by proxy rule")
			}
			// Default deny: no rule matched.
			p.sendIPC("request.blocked", map[string]interface{}{
				"agent_id": agentID, "url": fullURL, "method": req.Method, "decision": "denied", "reason": "default_deny",
			})
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy")

		case "allow":
			// Explicit allow rule: capture request body, stash metadata for the
			// response handler, and forward the request upstream.
			if rule != nil {
				var reqBodyRef string
				if rule.LogRequestBody != "" && rule.LogRequestBody != "none" {
					ref, origData := p.captureBody(req.Body, rule.LogRequestBody)
					reqBodyRef = ref
					// Restore body for forwarding (captureBody consumed it).
					if origData != nil {
						req.Body = io.NopCloser(bytes.NewReader(origData))
						req.ContentLength = int64(len(origData))
					}
				}
				ctx.UserData = map[string]interface{}{
					"agent_id": agentID, "url": fullURL,
					"request_body_ref":  reqBodyRef,
					"log_response_body": rule.LogResponseBody,
					"rule_id":           rule.ID,
				}
				return req, nil
			}
			// Default allow (shouldn't normally happen, but handle gracefully).
			ctx.UserData = map[string]interface{}{"agent_id": agentID, "url": fullURL}
			return req, nil

		case "hold":
			// Block this goroutine and ask the control plane for approval.
			if p.holdRequest != nil {
				holdData := map[string]interface{}{
					"agent_id": agentID, "url": fullURL, "method": req.Method,
					"decision": "held",
					"suggested_pattern": suggestPattern(fullURL),
					"suggested_methods": []string{req.Method},
				}
				raw, _ := json.Marshal(holdData)
				holdMsg := ipc.Message{Type: "approval.needed", MsgID: ipc.GenerateID(), Data: raw}
				approved := p.holdRequest(holdMsg)
				if approved {
					ctx.UserData = map[string]interface{}{"agent_id": agentID, "url": fullURL}
					return req, nil
				}
				p.sendIPC("request.blocked", map[string]interface{}{
					"agent_id": agentID, "url": fullURL, "method": req.Method, "decision": "denied", "reason": "hold_denied",
				})
				return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 504, "Request denied or timed out awaiting approval")
			}
			p.sendIPC("request.blocked", map[string]interface{}{
				"agent_id": agentID, "url": fullURL, "method": req.Method, "decision": "denied", "reason": "default_deny",
			})
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy (hold not available)")

		case "queue":
			p.sendIPC("request.blocked", map[string]interface{}{
				"agent_id": agentID, "url": fullURL, "method": req.Method, "decision": "denied", "reason": "queued",
			})
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy (queued for review)")

		default:
			p.sendIPC("request.blocked", map[string]interface{}{
				"agent_id": agentID, "url": fullURL, "method": req.Method, "decision": "denied", "reason": "default_deny",
			})
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy")
		}
	})

	// Response handler: runs after the upstream response is received for
	// allowed requests. Captures the response body per the rule's logging
	// policy and sends a request.logged IPC message with metadata.
	gp.OnResponse().DoFunc(func(resp *http.Response, ctx *goproxy.ProxyCtx) *http.Response {
		if resp == nil {
			return resp
		}
		ud, ok := ctx.UserData.(map[string]interface{})
		if !ok {
			return resp
		}
		agentID, _ := ud["agent_id"].(string)
		reqURL, _ := ud["url"].(string)
		if agentID != "" && reqURL != "" {
			reqBodyRef, _ := ud["request_body_ref"].(string)
			logRespBody, _ := ud["log_response_body"].(string)

			// Capture response body according to the rule's logging policy.
			var respBodyRef string
			if logRespBody != "" && logRespBody != "none" && resp.Body != nil {
				ref, origData := p.captureBody(resp.Body, logRespBody)
				respBodyRef = ref
				if origData != nil {
					resp.Body = io.NopCloser(bytes.NewReader(origData))
					resp.ContentLength = int64(len(origData))
				}
			}

			ipcData := map[string]interface{}{
				"agent_id":        agentID,
				"url":             reqURL,
				"method":          ctx.Req.Method,
				"decision":        "allowed",
				"response_status": resp.StatusCode,
				"status_code":     resp.StatusCode,
			}
			if reqBodyRef != "" {
				ipcData["request_body_ref"] = reqBodyRef
			}
			if respBodyRef != "" {
				ipcData["response_body_ref"] = respBodyRef
			}
			if ruleID, ok := ud["rule_id"]; ok && ruleID != nil {
				ipcData["rule_id"] = ruleID
			}
			p.sendIPC("request.logged", ipcData)
		}
		return resp
	})

	return p
}

// Start begins serving HTTP on the given address. It returns the net.Listener
// for the caller to inspect (e.g., to log the bound address). The proxy
// serves in a background goroutine; call [Proxy.Stop] to shut down.
func (p *Proxy) Start(addr string) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	p.ln = ln
	go http.Serve(ln, p.gp)
	return ln, nil
}

// sendIPC marshals the data map to JSON and sends it as an IPC message of the
// given type. It silently does nothing if the IPC client is nil.
func (p *Proxy) sendIPC(msgType string, data map[string]interface{}) {
	if p.ipc == nil {
		return
	}
	raw, _ := json.Marshal(data)
	p.ipc.Send(ipc.Message{Type: msgType, Data: raw})
}

// suggestPattern generates a regex pattern from a URL by extracting the
// scheme and host, escaping regex metacharacters, and appending a wildcard
// path suffix. This is sent in approval.needed messages to help operators
// create rules quickly.
func suggestPattern(fullURL string) string {
	re := regexp.MustCompile(`^(https?://[^/]+)(/[^?#]*)?`)
	m := re.FindStringSubmatch(fullURL)
	if len(m) < 2 {
		return regexp.QuoteMeta(fullURL)
	}
	host := regexp.QuoteMeta(m[1])
	return "^" + host + "/.*$"
}

// captureBody reads a request or response body according to the logging
// policy and writes it to the encrypted log. The policy can be "full" (log
// entire body) or "truncate:<max_bytes>" (log up to max_bytes).
//
// Returns the log ref string (empty if not logged) and the original body
// bytes so the caller can reconstruct the body for forwarding.
func (p *Proxy) captureBody(body io.ReadCloser, policy string) (string, []byte) {
	if body == nil || p.logWriter == nil || policy == "" || policy == "none" {
		return "", nil
	}
	data, err := io.ReadAll(body)
	if err != nil || len(data) == 0 {
		return "", data
	}
	toLog := data
	if strings.HasPrefix(policy, "truncate:") {
		if maxStr := strings.TrimPrefix(policy, "truncate:"); maxStr != "" {
			if max, err := strconv.Atoi(maxStr); err == nil && len(toLog) > max {
				toLog = toLog[:max]
			}
		}
	}
	ref, err := p.logWriter.Write(toLog)
	if err != nil {
		return "", data
	}
	return ref, data
}

// Stop shuts down the proxy listener and closes the encrypted log writer.
func (p *Proxy) Stop() {
	if p.ln != nil {
		p.ln.Close()
	}
	if p.logWriter != nil {
		p.logWriter.Close()
	}
}
