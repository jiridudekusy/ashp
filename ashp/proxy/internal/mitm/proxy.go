package mitm

import (
	"crypto/tls"
	"net"
	"net/http"

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

	// Set up MITM for CONNECT
	gp.OnRequest().HandleConnect(goproxy.FuncHttpsHandler(
		func(host string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
			return &goproxy.ConnectAction{
				Action: goproxy.ConnectMitm,
				TLSConfig: func(host string, ctx *goproxy.ProxyCtx) (*tls.Config, error) {
					cert, err := ca.SignHost(cfg.CA.Leaf, cfg.CA.PrivateKey, host)
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
		agentID, ok := p.auth.Authenticate(req)
		if !ok {
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 407, "Proxy Authentication Required")
		}
		req.Header.Del("Proxy-Authorization")

		fullURL := req.URL.String()
		rule := p.evaluator.Match(fullURL, req.Method)

		if rule != nil && rule.Action == "deny" {
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by proxy rule")
		}

		behavior := p.defaultBehavior
		if rule != nil && rule.Action == "allow" {
			ctx.UserData = map[string]interface{}{"agent_id": agentID, "rule": rule}
			return req, nil
		}
		if rule != nil && rule.DefaultBehavior != "" {
			behavior = rule.DefaultBehavior
		}

		switch behavior {
		case "deny":
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy")
		case "hold":
			if p.holdRequest != nil {
				holdMsg := ipc.Message{Type: "approval.needed"}
				approved := p.holdRequest(holdMsg)
				if approved {
					ctx.UserData = map[string]interface{}{"agent_id": agentID, "rule": rule}
					return req, nil
				}
				return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 504, "Request denied or timed out awaiting approval")
			}
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy (hold not available)")
		case "queue":
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy (queued for review)")
		default:
			return req, goproxy.NewResponse(req, goproxy.ContentTypeText, 403, "Forbidden by default policy")
		}
	})

	return p
}

func (p *Proxy) Start(addr string) net.Listener {
	ln, _ := net.Listen("tcp", addr)
	p.ln = ln
	go http.Serve(ln, p.gp)
	return ln
}

func (p *Proxy) Stop() {
	if p.ln != nil {
		p.ln.Close()
	}
	if p.logWriter != nil {
		p.logWriter.Close()
	}
}
