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

type Config struct {
	CA              tls.Certificate
	Evaluator       *rules.Evaluator
	Auth            *auth.Handler
	LogDir          string
	LogKey          []byte
	IPC             *ipc.Client
	DefaultBehavior string
	HoldRequest     func(msg ipc.Message) (approved bool)
}

type Proxy struct {
	gp              *goproxy.ProxyHttpServer
	evaluator       *rules.Evaluator
	auth            *auth.Handler
	logWriter       *logger.Writer
	ipc             *ipc.Client
	ln              net.Listener
	defaultBehavior string
	holdRequest     func(msg ipc.Message) (approved bool)
}

func New(cfg Config) *Proxy {
	gp := goproxy.NewProxyHttpServer()
	lw, _ := logger.NewWriter(cfg.LogDir, cfg.LogKey)

	p := &Proxy{
		gp: gp, evaluator: cfg.Evaluator, auth: cfg.Auth,
		logWriter: lw, ipc: cfg.IPC,
		defaultBehavior: cfg.DefaultBehavior,
		holdRequest:     cfg.HoldRequest,
	}

	// Set up MITM for CONNECT — authenticate at CONNECT time and store agentID
	gp.OnRequest().HandleConnect(goproxy.FuncHttpsHandler(
		func(host string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
			// Authenticate on CONNECT request (has Proxy-Authorization)
			agentID, ok := p.auth.Authenticate(ctx.Req)
			if !ok {
				return goproxy.RejectConnect, host
			}
			ctx.UserData = agentID // carry agentID through to MITM'd requests
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

	// Request handler
	gp.OnRequest().DoFunc(func(req *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
		// For MITM'd HTTPS requests, agentID was set during CONNECT
		var agentID string
		if id, ok := ctx.UserData.(string); ok {
			agentID = id
		} else {
			// Plain HTTP request — authenticate from header
			var authed bool
			agentID, authed = p.auth.Authenticate(req)
			if !authed {
				return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 407, "Proxy Authentication Required")
			}
		}
		req.Header.Del("Proxy-Authorization")

		// Build the full URL for rule matching
		// goproxy sets req.URL with full scheme+host for CONNECT'd requests
		fullURL := req.URL.String()
		// If URL is relative (path-only), reconstruct from Host header
		if req.URL.Scheme == "" {
			scheme := "https"
			if req.TLS == nil {
				scheme = "http"
			}
			host := req.Host
			// Strip default ports so rules can match without specifying ports
			host = strings.TrimSuffix(host, ":443")
			host = strings.TrimSuffix(host, ":80")
			fullURL = scheme + "://" + host + req.URL.RequestURI()
		} else {
			// Strip default ports from absolute URLs too
			hostname := req.URL.Hostname()
			port := req.URL.Port()
			if (req.URL.Scheme == "https" && port == "443") || (req.URL.Scheme == "http" && port == "80") {
				fullURL = req.URL.Scheme + "://" + hostname + req.URL.RequestURI()
			}
		}
		rule := p.evaluator.Match(fullURL, req.Method)

		if rule != nil && rule.Action == "deny" {
			// Capture request body for denied requests if rule says to log it
			var reqBodyRef string
			if rule.LogRequestBody != "" && rule.LogRequestBody != "none" {
				ref, _ := p.captureBody(req.Body, rule.LogRequestBody)
				reqBodyRef = ref
			}
			ipcData := map[string]interface{}{
				"agent_id": agentID, "url": fullURL, "method": req.Method, "decision": "denied", "reason": "rule_deny",
			}
			if reqBodyRef != "" {
				ipcData["request_body_ref"] = reqBodyRef
			}
			p.sendIPC("request.blocked", ipcData)
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by proxy rule")
		}

		behavior := p.defaultBehavior
		if rule != nil && rule.Action == "allow" {
			// Capture request body for allowed requests
			var reqBodyRef string
			if rule.LogRequestBody != "" && rule.LogRequestBody != "none" {
				ref, origData := p.captureBody(req.Body, rule.LogRequestBody)
				reqBodyRef = ref
				// Restore body for forwarding
				if origData != nil {
					req.Body = io.NopCloser(bytes.NewReader(origData))
					req.ContentLength = int64(len(origData))
				}
			}
			ctx.UserData = map[string]interface{}{
				"agent_id": agentID, "url": fullURL,
				"request_body_ref": reqBodyRef,
				"log_response_body": rule.LogResponseBody,
			}
			return req, nil
		}
		if rule != nil && rule.DefaultBehavior != "" {
			behavior = rule.DefaultBehavior
		}

		switch behavior {
		case "deny":
			p.sendIPC("request.blocked", map[string]interface{}{
				"agent_id": agentID, "url": fullURL, "method": req.Method, "decision": "denied", "reason": "default_deny",
			})
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy")
		case "hold":
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

	// Response handler — send request.logged for allowed requests
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

			// Capture response body
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
			p.sendIPC("request.logged", ipcData)
		}
		return resp
	})

	return p
}

func (p *Proxy) Start(addr string) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	p.ln = ln
	go http.Serve(ln, p.gp)
	return ln, nil
}

func (p *Proxy) sendIPC(msgType string, data map[string]interface{}) {
	if p.ipc == nil {
		return
	}
	raw, _ := json.Marshal(data)
	p.ipc.Send(ipc.Message{Type: msgType, Data: raw})
}

// suggestPattern generates a regex pattern from a URL (scheme + host + path prefix)
func suggestPattern(fullURL string) string {
	// Extract scheme://host/path and create a pattern
	re := regexp.MustCompile(`^(https?://[^/]+)(/[^?#]*)?`)
	m := re.FindStringSubmatch(fullURL)
	if len(m) < 2 {
		return regexp.QuoteMeta(fullURL)
	}
	host := regexp.QuoteMeta(m[1])
	return "^" + host + "/.*$"
}

// captureBody reads a body according to the logging policy and writes it to the encrypted log.
// Returns the ref string or empty string if not logged.
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

func (p *Proxy) Stop() {
	if p.ln != nil {
		p.ln.Close()
	}
	if p.logWriter != nil {
		p.logWriter.Close()
	}
}
