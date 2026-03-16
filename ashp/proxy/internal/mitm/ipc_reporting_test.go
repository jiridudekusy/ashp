package mitm

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jdk/ashp/proxy/internal/auth"
	calib "github.com/jdk/ashp/proxy/internal/ca"
	"github.com/jdk/ashp/proxy/internal/ipc"
	"github.com/jdk/ashp/proxy/internal/rules"
)

// ipcCapture starts a unix socket server that captures all IPC messages sent by the proxy.
type ipcCapture struct {
	socketPath string
	listener   net.Listener
	messages   []map[string]interface{}
	mu         sync.Mutex
	wg         sync.WaitGroup
}

func newIPCCapture(t *testing.T) *ipcCapture {
	dir := t.TempDir()
	sock := filepath.Join(dir, "test.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	c := &ipcCapture{socketPath: sock, listener: ln}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go c.handleConn(conn)
		}
	}()
	return c
}

func (c *ipcCapture) handleConn(conn net.Conn) {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		var m map[string]interface{}
		if err := json.Unmarshal(scanner.Bytes(), &m); err == nil {
			c.mu.Lock()
			c.messages = append(c.messages, m)
			c.mu.Unlock()
		}
	}
}

func (c *ipcCapture) waitForMessages(count int, timeout time.Duration) []map[string]interface{} {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		if len(c.messages) >= count {
			msgs := make([]map[string]interface{}, len(c.messages))
			copy(msgs, c.messages)
			c.mu.Unlock()
			return msgs
		}
		c.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.messages
}

func (c *ipcCapture) close() {
	c.listener.Close()
	c.wg.Wait()
}

func setupProxyWithIPC(t *testing.T, ipcSock string, defaultBehavior string, holdFn func(ipc.Message) bool) (*Proxy, string) {
	dir := t.TempDir()
	calib.GenerateCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))
	ca, _ := calib.LoadCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))

	eval := rules.NewEvaluator()
	authH := auth.NewHandler(map[string]string{"agent1": "secret"})
	logKey := bytes.Repeat([]byte{0xab}, 32)

	client := ipc.NewClient(ipcSock)
	go client.Connect()
	// Wait for connection
	time.Sleep(100 * time.Millisecond)

	p := New(Config{
		CA:              ca,
		Evaluator:       eval,
		Auth:            authH,
		LogDir:          filepath.Join(dir, "logs"),
		LogKey:          logKey,
		IPC:             client,
		DefaultBehavior: defaultBehavior,
		HoldRequest:     holdFn,
	})
	ln, err := p.Start("127.0.0.1:0")
	if err != nil { t.Fatal(err) }
	return p, "http://" + ln.Addr().String()
}

func TestAllowedRequestSendsIPCLogged(t *testing.T) {
	capture := newIPCCapture(t)
	defer capture.close()

	p, proxyURL := setupProxyWithIPC(t, capture.socketPath, "deny", nil)
	defer p.Stop()

	p.evaluator.Load([]rules.Rule{
		{ID: 1, URLPattern: `.*`, Methods: nil, Action: "allow", Priority: 0, Enabled: true},
	})

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("ok"))
	}))
	defer target.Close()

	client := &http.Client{Transport: &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) { return url.Parse(proxyURL) },
	}}
	req, _ := http.NewRequest("GET", target.URL+"/test", nil)
	req.Header.Set("Proxy-Authorization", "Basic YWdlbnQxOnNlY3JldA==") // agent1:secret
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(resp.Body)
	resp.Body.Close()

	msgs := capture.waitForMessages(1, 2*time.Second)
	if len(msgs) == 0 {
		t.Fatal("expected IPC message request.logged, got none")
	}

	msg := msgs[0]
	if msg["type"] != "request.logged" {
		t.Fatalf("expected type request.logged, got %v", msg["type"])
	}

	data, ok := msg["data"].(map[string]interface{})
	if !ok {
		t.Fatal("expected data field in IPC message")
	}
	if data["agent_id"] != "agent1" {
		t.Fatalf("expected agent_id=agent1, got %v", data["agent_id"])
	}
	if data["method"] != "GET" {
		t.Fatalf("expected method=GET, got %v", data["method"])
	}
	urlStr, _ := data["url"].(string)
	if urlStr == "" {
		t.Fatal("expected url in data")
	}
	statusCode, _ := data["status_code"].(float64)
	if statusCode != 200 {
		t.Fatalf("expected status_code=200, got %v", data["status_code"])
	}
}

func TestDeniedRequestSendsIPCBlocked(t *testing.T) {
	capture := newIPCCapture(t)
	defer capture.close()

	p, proxyURL := setupProxyWithIPC(t, capture.socketPath, "deny", nil)
	defer p.Stop()

	p.evaluator.Load([]rules.Rule{
		{ID: 1, URLPattern: `.*`, Methods: nil, Action: "deny", Priority: 0, Enabled: true},
	})

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("should not reach target")
	}))
	defer target.Close()

	client := &http.Client{Transport: &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) { return url.Parse(proxyURL) },
	}}
	req, _ := http.NewRequest("GET", target.URL+"/blocked", nil)
	req.Header.Set("Proxy-Authorization", "Basic YWdlbnQxOnNlY3JldA==")
	resp, _ := client.Do(req)
	io.ReadAll(resp.Body)
	resp.Body.Close()

	msgs := capture.waitForMessages(1, 2*time.Second)
	if len(msgs) == 0 {
		t.Fatal("expected IPC message request.blocked, got none")
	}

	msg := msgs[0]
	if msg["type"] != "request.blocked" {
		t.Fatalf("expected type request.blocked, got %v", msg["type"])
	}

	data, ok := msg["data"].(map[string]interface{})
	if !ok {
		t.Fatal("expected data field in IPC message")
	}
	if data["agent_id"] != "agent1" {
		t.Fatalf("expected agent_id=agent1, got %v", data["agent_id"])
	}
	if data["method"] != "GET" {
		t.Fatalf("expected method=GET, got %v", data["method"])
	}
	if data["url"] == nil || data["url"] == "" {
		t.Fatal("expected url in data")
	}
	if data["reason"] == nil || data["reason"] == "" {
		t.Fatal("expected reason in data")
	}
}

func TestHoldRequestSendsIPCApprovalNeededWithData(t *testing.T) {
	capture := newIPCCapture(t)
	defer capture.close()

	// holdFn mirrors production: sends msg via IPC, then auto-approves
	var capturedHoldMsg *ipc.Message
	var holdMu sync.Mutex
	holdFn := func(msg ipc.Message) bool {
		holdMu.Lock()
		capturedHoldMsg = &msg
		holdMu.Unlock()
		return true
	}

	p, proxyURL := setupProxyWithIPC(t, capture.socketPath, "hold", holdFn)
	defer p.Stop()

	// No rules loaded → falls through to default behavior "hold"

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("approved"))
	}))
	defer target.Close()

	// Remove old socket if exists
	os.Remove(capture.socketPath + ".old")

	client := &http.Client{Transport: &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) { return url.Parse(proxyURL) },
	}}
	req, _ := http.NewRequest("POST", target.URL+"/api/data", nil)
	req.Header.Set("Proxy-Authorization", "Basic YWdlbnQxOnNlY3JldA==")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(resp.Body)
	resp.Body.Close()

	// Verify holdFn received message with data
	holdMu.Lock()
	msg := capturedHoldMsg
	holdMu.Unlock()
	if msg == nil {
		t.Fatal("holdFn was never called")
	}
	if msg.Type != "approval.needed" {
		t.Fatalf("expected type approval.needed, got %s", msg.Type)
	}

	var data map[string]interface{}
	if err := json.Unmarshal(msg.Data, &data); err != nil {
		t.Fatalf("failed to unmarshal hold message data: %v", err)
	}
	if data["agent_id"] != "agent1" {
		t.Fatalf("expected agent_id=agent1, got %v", data["agent_id"])
	}
	if data["method"] != "POST" {
		t.Fatalf("expected method=POST, got %v", data["method"])
	}
	if data["url"] == nil || data["url"] == "" {
		t.Fatal("expected url in data")
	}
	if data["suggested_pattern"] == nil || data["suggested_pattern"] == "" {
		t.Fatal("expected suggested_pattern in data")
	}

	// Also verify request.logged was sent via IPC after approval
	msgs := capture.waitForMessages(1, 2*time.Second)
	var loggedMsg map[string]interface{}
	for _, m := range msgs {
		if m["type"] == "request.logged" {
			loggedMsg = m
		}
	}
	if loggedMsg == nil {
		t.Fatal("expected request.logged after approved hold")
	}
}
