package mitm

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jdk/ashp/proxy/internal/ca"
	"github.com/jdk/ashp/proxy/internal/ipc"
)

// TransparentPort defines a port for transparent proxy listening.
type TransparentPort struct {
	Port int
	TLS  bool
}

// upstreamResolver bypasses dnsmasq catch-all by resolving via Docker DNS.
var upstreamResolver = &net.Resolver{
	PreferGo: true,
	Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
		return net.Dial("udp", "127.0.0.11:53")
	},
}

// upstreamTransport uses the upstream resolver to bypass local DNS overrides
// when forwarding transparent proxy requests to their real destinations.
var upstreamTransport = &http.Transport{
	DialContext: (&net.Dialer{
		Resolver: upstreamResolver,
		Timeout:  30 * time.Second,
	}).DialContext,
	TLSHandshakeTimeout: 10 * time.Second,
}

// extractSNI peeks at the TLS ClientHello on conn and returns the SNI
// server name. The returned net.Conn is a buffered wrapper that replays
// the peeked bytes so the caller can pass it to tls.Server unchanged.
func extractSNI(conn net.Conn) (string, net.Conn, error) {
	br := bufio.NewReader(conn)

	// TLS record header: 1 byte type + 2 bytes version + 2 bytes length
	hdr, err := br.Peek(5)
	if err != nil {
		return "", nil, fmt.Errorf("peek TLS header: %w", err)
	}
	if hdr[0] != 0x16 { // ContentType handshake
		return "", nil, fmt.Errorf("not a TLS handshake (type=%d)", hdr[0])
	}
	recordLen := int(hdr[3])<<8 | int(hdr[4])

	// Peek full record
	record, err := br.Peek(5 + recordLen)
	if err != nil {
		return "", nil, fmt.Errorf("peek TLS record: %w", err)
	}

	sni := parseSNIFromClientHello(record[5:])
	if sni == "" {
		return "", nil, fmt.Errorf("no SNI found in ClientHello")
	}

	wrapped := &bufferedConn{Reader: br, Conn: conn}
	return sni, wrapped, nil
}

// parseSNIFromClientHello extracts the server_name from a TLS ClientHello
// handshake message body. Returns empty string if not found.
func parseSNIFromClientHello(data []byte) string {
	if len(data) < 42 {
		return ""
	}
	if data[0] != 0x01 { // ClientHello
		return ""
	}
	// Handshake: type(1) + length(3) + version(2) + random(32) = 38
	pos := 38

	// Session ID
	if pos >= len(data) {
		return ""
	}
	sidLen := int(data[pos])
	pos += 1 + sidLen

	// Cipher suites
	if pos+2 > len(data) {
		return ""
	}
	csLen := int(data[pos])<<8 | int(data[pos+1])
	pos += 2 + csLen

	// Compression methods
	if pos >= len(data) {
		return ""
	}
	cmLen := int(data[pos])
	pos += 1 + cmLen

	// Extensions
	if pos+2 > len(data) {
		return ""
	}
	extLen := int(data[pos])<<8 | int(data[pos+1])
	pos += 2
	end := pos + extLen

	for pos+4 <= end && pos+4 <= len(data) {
		extType := int(data[pos])<<8 | int(data[pos+1])
		extDataLen := int(data[pos+2])<<8 | int(data[pos+3])
		pos += 4
		if extType == 0x0000 { // server_name
			if pos+5 <= len(data) && pos+5 <= pos+extDataLen {
				nameLen := int(data[pos+3])<<8 | int(data[pos+4])
				if pos+5+nameLen <= len(data) {
					return string(data[pos+5 : pos+5+nameLen])
				}
			}
			return ""
		}
		pos += extDataLen
	}
	return ""
}

// bufferedConn wraps a net.Conn with a bufio.Reader so that peeked
// bytes from SNI extraction are replayed during the TLS handshake.
type bufferedConn struct {
	io.Reader
	net.Conn
}

func (c *bufferedConn) Read(b []byte) (int, error) {
	return c.Reader.Read(b)
}

// startTransparentListeners launches a listener for each configured
// transparent port. TLS ports use raw TCP accept + SNI extraction + MITM;
// plain ports use an http.Server for standard HTTP handling.
func (p *Proxy) startTransparentListeners(listenAddr string, ports []TransparentPort) error {
	for _, port := range ports {
		addr := fmt.Sprintf("%s:%d", listenAddr, port.Port)
		if port.TLS {
			if err := p.startTransparentTLS(addr); err != nil {
				return fmt.Errorf("transparent TLS on %s: %w", addr, err)
			}
		} else {
			if err := p.startTransparentHTTP(addr); err != nil {
				return fmt.Errorf("transparent HTTP on %s: %w", addr, err)
			}
		}
	}
	return nil
}

// startTransparentTLS binds a raw TCP listener for HTTPS traffic. Each
// accepted connection is handled in its own goroutine via handleTransparentTLS.
func (p *Proxy) startTransparentTLS(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	p.transparentListeners = append(p.transparentListeners, ln)
	fmt.Fprintf(os.Stderr, "Transparent HTTPS listening on %s\n", addr)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go p.handleTransparentTLS(conn)
		}
	}()
	return nil
}

// handleTransparentTLS processes a single transparent HTTPS connection:
// extracts SNI, performs MITM TLS with a dynamically signed certificate,
// reads the HTTP request, evaluates rules, and forwards or blocks.
func (p *Proxy) handleTransparentTLS(conn net.Conn) {
	defer conn.Close()

	sni, buffered, err := extractSNI(conn)
	if err != nil {
		return
	}

	// Obtain the CA cert for signing. Prefer the pre-parsed Leaf if available.
	caCert := p.ca.Leaf
	if caCert == nil {
		caCert, err = x509.ParseCertificate(p.ca.Certificate[0])
		if err != nil {
			return
		}
	}
	leafCert, err := ca.SignHost(caCert, p.ca.PrivateKey, sni)
	if err != nil {
		return
	}

	tlsConn := tls.Server(buffered, &tls.Config{
		Certificates: []tls.Certificate{leafCert},
	})
	if err := tlsConn.Handshake(); err != nil {
		return
	}
	defer tlsConn.Close()

	req, err := http.ReadRequest(bufio.NewReader(tlsConn))
	if err != nil {
		return
	}

	agentID, _ := p.auth.AuthenticateByIP(conn.RemoteAddr().String())

	// Build canonical URL: strip default HTTPS port.
	host := sni
	host = strings.TrimSuffix(host, ":443")
	fullURL := "https://" + host + req.RequestURI

	decision := p.evaluateRequest(RequestContext{
		AgentID: agentID, FullURL: fullURL, Method: req.Method, Mode: "transparent",
	})

	switch decision.Action {
	case "deny", "queue":
		p.transparentDeny(tlsConn, req, agentID, fullURL, decision)
	case "allow":
		p.transparentForwardTLS(tlsConn, req, agentID, fullURL, sni, decision)
	case "hold":
		p.transparentHoldTLS(tlsConn, req, agentID, fullURL, sni, decision)
	}
}

// startTransparentHTTP binds an HTTP server for plain-text transparent traffic.
func (p *Proxy) startTransparentHTTP(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	p.transparentListeners = append(p.transparentListeners, ln)
	fmt.Fprintf(os.Stderr, "Transparent HTTP listening on %s\n", addr)
	server := &http.Server{Handler: http.HandlerFunc(p.handleTransparentHTTP)}
	go server.Serve(ln)
	return nil
}

// handleTransparentHTTP processes a single transparent plain-HTTP request.
func (p *Proxy) handleTransparentHTTP(w http.ResponseWriter, req *http.Request) {
	host := req.Host
	if host == "" {
		http.Error(w, "Missing Host header", http.StatusBadRequest)
		return
	}
	agentID, _ := p.auth.AuthenticateByIP(req.RemoteAddr)

	// Strip default HTTP port for canonical URL.
	cleanHost := strings.TrimSuffix(host, ":80")
	fullURL := "http://" + cleanHost + req.RequestURI

	decision := p.evaluateRequest(RequestContext{
		AgentID: agentID, FullURL: fullURL, Method: req.Method, Mode: "transparent",
	})

	switch decision.Action {
	case "deny", "queue":
		p.sendIPC("request.blocked", map[string]interface{}{
			"agent_id": agentID, "url": fullURL, "method": req.Method,
			"decision": decision.Action, "mode": "transparent",
		})
		http.Error(w, "Blocked by ASHP", http.StatusForbidden)
	case "allow":
		p.transparentForwardHTTP(w, req, agentID, fullURL, host, decision)
	case "hold":
		p.transparentHoldHTTP(w, req, agentID, fullURL, host, decision)
	}
}

// transparentDeny writes a 403 response to the MITM'd TLS connection and
// sends a request.blocked IPC message.
func (p *Proxy) transparentDeny(tlsConn *tls.Conn, req *http.Request, agentID, fullURL string, decision RequestDecision) {
	p.sendIPC("request.blocked", map[string]interface{}{
		"agent_id": agentID, "url": fullURL, "method": req.Method,
		"decision": decision.Action, "mode": "transparent",
	})
	resp := &http.Response{
		StatusCode: http.StatusForbidden,
		ProtoMajor: 1, ProtoMinor: 1,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("Blocked by ASHP")),
	}
	resp.Header.Set("Content-Type", "text/plain")
	resp.Write(tlsConn)
}

// transparentForwardTLS forwards a transparent HTTPS request to its real
// destination, optionally capturing request/response bodies per rule policy.
func (p *Proxy) transparentForwardTLS(tlsConn *tls.Conn, req *http.Request, agentID, fullURL, sni string, decision RequestDecision) {
	rule := decision.Rule

	// Capture request body if the rule requires it.
	var reqBodyRef string
	if rule != nil && rule.LogRequestBody != "" && rule.LogRequestBody != "none" {
		ref, origData := p.captureBody(req.Body, rule.LogRequestBody)
		reqBodyRef = ref
		if origData != nil {
			req.Body = io.NopCloser(bytes.NewReader(origData))
			req.ContentLength = int64(len(origData))
		}
	}

	// Build the outbound request.
	outURL := "https://" + sni + req.RequestURI
	outReq, err := http.NewRequest(req.Method, outURL, req.Body)
	if err != nil {
		return
	}
	outReq.Header = req.Header.Clone()
	outReq.ContentLength = req.ContentLength

	resp, err := upstreamTransport.RoundTrip(outReq)
	if err != nil {
		return
	}
	defer resp.Body.Close()

	// Capture response body if the rule requires it.
	var respBodyRef string
	if rule != nil && rule.LogResponseBody != "" && rule.LogResponseBody != "none" {
		ref, origData := p.captureBody(resp.Body, rule.LogResponseBody)
		respBodyRef = ref
		if origData != nil {
			resp.Body = io.NopCloser(bytes.NewReader(origData))
			resp.ContentLength = int64(len(origData))
		}
	}

	// Write the response back to the client.
	resp.Write(tlsConn)

	// Send IPC log.
	ipcData := map[string]interface{}{
		"agent_id":        agentID,
		"url":             fullURL,
		"method":          req.Method,
		"decision":        "allowed",
		"mode":            "transparent",
		"response_status": resp.StatusCode,
		"status_code":     resp.StatusCode,
	}
	if reqBodyRef != "" {
		ipcData["request_body_ref"] = reqBodyRef
	}
	if respBodyRef != "" {
		ipcData["response_body_ref"] = respBodyRef
	}
	if rule != nil {
		ipcData["rule_id"] = rule.ID
	}
	p.sendIPC("request.logged", ipcData)
}

// transparentForwardHTTP forwards a transparent plain-HTTP request to its
// real destination.
func (p *Proxy) transparentForwardHTTP(w http.ResponseWriter, req *http.Request, agentID, fullURL, host string, decision RequestDecision) {
	rule := decision.Rule

	// Capture request body if the rule requires it.
	var reqBodyRef string
	if rule != nil && rule.LogRequestBody != "" && rule.LogRequestBody != "none" {
		ref, origData := p.captureBody(req.Body, rule.LogRequestBody)
		reqBodyRef = ref
		if origData != nil {
			req.Body = io.NopCloser(bytes.NewReader(origData))
			req.ContentLength = int64(len(origData))
		}
	}

	// Build the outbound request.
	outURL := "http://" + host + req.RequestURI
	outReq, err := http.NewRequest(req.Method, outURL, req.Body)
	if err != nil {
		http.Error(w, "Internal error", http.StatusBadGateway)
		return
	}
	outReq.Header = req.Header.Clone()
	outReq.ContentLength = req.ContentLength

	resp, err := upstreamTransport.RoundTrip(outReq)
	if err != nil {
		http.Error(w, "Upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Capture response body if the rule requires it.
	var respBodyRef string
	if rule != nil && rule.LogResponseBody != "" && rule.LogResponseBody != "none" {
		ref, origData := p.captureBody(resp.Body, rule.LogResponseBody)
		respBodyRef = ref
		if origData != nil {
			resp.Body = io.NopCloser(bytes.NewReader(origData))
			resp.ContentLength = int64(len(origData))
		}
	}

	// Copy response headers and write the status.
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)

	// Send IPC log.
	ipcData := map[string]interface{}{
		"agent_id":        agentID,
		"url":             fullURL,
		"method":          req.Method,
		"decision":        "allowed",
		"mode":            "transparent",
		"response_status": resp.StatusCode,
		"status_code":     resp.StatusCode,
	}
	if reqBodyRef != "" {
		ipcData["request_body_ref"] = reqBodyRef
	}
	if respBodyRef != "" {
		ipcData["response_body_ref"] = respBodyRef
	}
	if rule != nil {
		ipcData["rule_id"] = rule.ID
	}
	p.sendIPC("request.logged", ipcData)
}

// transparentHoldTLS sends an approval.needed IPC message, blocks waiting for
// a resolution, and then forwards or denies the TLS request.
func (p *Proxy) transparentHoldTLS(tlsConn *tls.Conn, req *http.Request, agentID, fullURL, sni string, decision RequestDecision) {
	if p.holdRequest == nil {
		p.transparentDeny(tlsConn, req, agentID, fullURL, decision)
		return
	}

	holdData := map[string]interface{}{
		"agent_id":          agentID,
		"url":               fullURL,
		"method":            req.Method,
		"decision":          "held",
		"mode":              "transparent",
		"suggested_pattern": suggestPattern(fullURL),
		"suggested_methods": []string{req.Method},
	}
	raw, _ := json.Marshal(holdData)
	holdMsg := ipc.Message{Type: "approval.needed", MsgID: ipc.GenerateID(), Data: raw}

	approved := p.holdRequest(holdMsg)
	if approved {
		p.transparentForwardTLS(tlsConn, req, agentID, fullURL, sni, decision)
	} else {
		p.sendIPC("request.blocked", map[string]interface{}{
			"agent_id": agentID, "url": fullURL, "method": req.Method,
			"decision": "denied", "reason": "hold_denied", "mode": "transparent",
		})
		resp := &http.Response{
			StatusCode: http.StatusGatewayTimeout,
			ProtoMajor: 1, ProtoMinor: 1,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("Request denied or timed out awaiting approval")),
		}
		resp.Header.Set("Content-Type", "text/plain")
		resp.Write(tlsConn)
	}
}

// transparentHoldHTTP sends an approval.needed IPC message, blocks waiting for
// a resolution, and then forwards or denies the plain-HTTP request.
func (p *Proxy) transparentHoldHTTP(w http.ResponseWriter, req *http.Request, agentID, fullURL, host string, decision RequestDecision) {
	if p.holdRequest == nil {
		p.sendIPC("request.blocked", map[string]interface{}{
			"agent_id": agentID, "url": fullURL, "method": req.Method,
			"decision": "denied", "reason": "default_deny", "mode": "transparent",
		})
		http.Error(w, "Blocked by ASHP", http.StatusForbidden)
		return
	}

	holdData := map[string]interface{}{
		"agent_id":          agentID,
		"url":               fullURL,
		"method":            req.Method,
		"decision":          "held",
		"mode":              "transparent",
		"suggested_pattern": suggestPattern(fullURL),
		"suggested_methods": []string{req.Method},
	}
	raw, _ := json.Marshal(holdData)
	holdMsg := ipc.Message{Type: "approval.needed", MsgID: ipc.GenerateID(), Data: raw}

	approved := p.holdRequest(holdMsg)
	if approved {
		p.transparentForwardHTTP(w, req, agentID, fullURL, host, decision)
	} else {
		p.sendIPC("request.blocked", map[string]interface{}{
			"agent_id": agentID, "url": fullURL, "method": req.Method,
			"decision": "denied", "reason": "hold_denied", "mode": "transparent",
		})
		http.Error(w, "Request denied or timed out awaiting approval", http.StatusGatewayTimeout)
	}
}
