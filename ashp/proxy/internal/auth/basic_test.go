package auth

import (
	"net/http"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func hashToken(t *testing.T, token string) string {
	h, err := bcrypt.GenerateFromPassword([]byte(token), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	return string(h)
}

func TestAuthenticate(t *testing.T) {
	h := NewHandler()
	h.Reload([]Agent{
		{Name: "agent1", TokenHash: hashToken(t, "secret123"), Enabled: true},
		{Name: "disabled", TokenHash: hashToken(t, "pass"), Enabled: false},
	})

	tests := []struct {
		name   string
		user   string
		pass   string
		wantOK bool
		wantID string
	}{
		{"valid", "agent1", "secret123", true, "agent1"},
		{"wrong pass", "agent1", "wrong", false, ""},
		{"unknown agent", "nope", "secret123", false, ""},
		{"disabled agent", "disabled", "pass", false, ""},
		{"no header", "", "", false, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/", nil)
			if tt.user != "" {
				req.SetBasicAuth(tt.user, tt.pass)
				// Move to Proxy-Authorization
				req.Header.Set("Proxy-Authorization", req.Header.Get("Authorization"))
				req.Header.Del("Authorization")
			}
			id, ok := h.Authenticate(req)
			if ok != tt.wantOK {
				t.Errorf("ok = %v, want %v", ok, tt.wantOK)
			}
			if id != tt.wantID {
				t.Errorf("id = %q, want %q", id, tt.wantID)
			}
		})
	}
}

func TestAuthCache(t *testing.T) {
	h := NewHandler()
	h.Reload([]Agent{
		{Name: "agent1", TokenHash: hashToken(t, "secret123"), Enabled: true},
	})

	req, _ := http.NewRequest("GET", "/", nil)
	req.SetBasicAuth("agent1", "secret123")
	req.Header.Set("Proxy-Authorization", req.Header.Get("Authorization"))
	req.Header.Del("Authorization")

	// First call — bcrypt
	_, ok := h.Authenticate(req)
	if !ok {
		t.Fatal("first auth failed")
	}

	// Second call — should hit cache (much faster)
	_, ok = h.Authenticate(req)
	if !ok {
		t.Fatal("cached auth failed")
	}
}

func TestAuthenticateByIP_Found(t *testing.T) {
	h := NewHandler()
	h.ReloadIPMap(map[string]string{
		"172.18.0.3": "agent-one",
		"172.18.0.4": "agent-two",
	})
	name, ok := h.AuthenticateByIP("172.18.0.3:54321")
	if !ok {
		t.Fatal("expected authentication to succeed")
	}
	if name != "agent-one" {
		t.Fatalf("expected agent-one, got %s", name)
	}
}

func TestAuthenticateByIP_NotFound(t *testing.T) {
	h := NewHandler()
	h.ReloadIPMap(map[string]string{"172.18.0.3": "agent-one"})
	_, ok := h.AuthenticateByIP("172.18.0.99:12345")
	if ok {
		t.Fatal("expected authentication to fail for unknown IP")
	}
}

func TestAuthenticateByIP_EmptyMap(t *testing.T) {
	h := NewHandler()
	_, ok := h.AuthenticateByIP("172.18.0.3:12345")
	if ok {
		t.Fatal("expected authentication to fail with empty map")
	}
}

func TestReloadIPMap_Replaces(t *testing.T) {
	h := NewHandler()
	h.ReloadIPMap(map[string]string{"1.2.3.4": "old"})
	h.ReloadIPMap(map[string]string{"5.6.7.8": "new"})
	_, ok := h.AuthenticateByIP("1.2.3.4:1234")
	if ok {
		t.Fatal("old mapping should be gone after reload")
	}
	name, ok := h.AuthenticateByIP("5.6.7.8:1234")
	if !ok || name != "new" {
		t.Fatal("new mapping should be active")
	}
}

func TestReloadClearsCache(t *testing.T) {
	h := NewHandler()
	h.Reload([]Agent{
		{Name: "agent1", TokenHash: hashToken(t, "secret123"), Enabled: true},
	})

	req, _ := http.NewRequest("GET", "/", nil)
	req.SetBasicAuth("agent1", "secret123")
	req.Header.Set("Proxy-Authorization", req.Header.Get("Authorization"))
	req.Header.Del("Authorization")

	h.Authenticate(req) // populate cache

	// Reload with different token
	h.Reload([]Agent{
		{Name: "agent1", TokenHash: hashToken(t, "newtoken"), Enabled: true},
	})

	// Old token should fail (cache cleared)
	_, ok := h.Authenticate(req)
	if ok {
		t.Fatal("old token should fail after reload")
	}
}
