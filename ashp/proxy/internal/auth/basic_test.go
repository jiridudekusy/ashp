package auth

import (
	"encoding/base64"
	"net/http"
	"testing"
)

func TestParseProxyAuth(t *testing.T) {
	tokens := map[string]string{"agent1": "secret123"}
	h := NewHandler(tokens)

	val := "Basic " + base64.StdEncoding.EncodeToString([]byte("agent1:secret123"))
	req, _ := http.NewRequest("GET", "http://example.com", nil)
	req.Header.Set("Proxy-Authorization", val)
	agentID, ok := h.Authenticate(req)
	if !ok {
		t.Fatal("expected auth success")
	}
	if agentID != "agent1" {
		t.Fatalf("got %s", agentID)
	}
}

func TestRejectsWrongPassword(t *testing.T) {
	h := NewHandler(map[string]string{"agent1": "secret123"})
	val := "Basic " + base64.StdEncoding.EncodeToString([]byte("agent1:wrong"))
	req, _ := http.NewRequest("GET", "http://example.com", nil)
	req.Header.Set("Proxy-Authorization", val)
	_, ok := h.Authenticate(req)
	if ok {
		t.Fatal("expected auth failure")
	}
}

func TestRejectsMissingHeader(t *testing.T) {
	h := NewHandler(map[string]string{"agent1": "secret123"})
	req, _ := http.NewRequest("GET", "http://example.com", nil)
	_, ok := h.Authenticate(req)
	if ok {
		t.Fatal("expected auth failure")
	}
}

func TestRejectsUnknownUser(t *testing.T) {
	h := NewHandler(map[string]string{"agent1": "secret123"})
	val := "Basic " + base64.StdEncoding.EncodeToString([]byte("unknown:secret123"))
	req, _ := http.NewRequest("GET", "http://example.com", nil)
	req.Header.Set("Proxy-Authorization", val)
	_, ok := h.Authenticate(req)
	if ok {
		t.Fatal("expected auth failure")
	}
}
