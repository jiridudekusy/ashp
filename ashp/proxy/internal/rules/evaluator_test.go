package rules

import "testing"

func TestEvaluator(t *testing.T) {
	e := NewEvaluator()
	e.Load([]Rule{
		{ID: 1, URLPattern: `^https://api\.github\.com/.*$`, Methods: []string{"GET", "POST"},
			Action: "allow", Priority: 100, Enabled: true},
		{ID: 2, URLPattern: `.*`, Methods: nil,
			Action: "deny", Priority: 0, Enabled: true},
		{ID: 3, URLPattern: `^https://disabled\.com/.*$`, Methods: nil,
			Action: "allow", Priority: 200, Enabled: false},
	})

	tests := []struct {
		url, method string
		wantID      int
		wantAction  string
	}{
		{"https://api.github.com/repos", "GET", 1, "allow"},
		{"https://api.github.com/repos", "DELETE", 2, "deny"},
		{"https://evil.com/hack", "GET", 2, "deny"},
		{"https://disabled.com/path", "GET", 2, "deny"},
	}

	for _, tt := range tests {
		match := e.Match("__all__", tt.url, tt.method)
		if match == nil {
			t.Fatalf("no match for %s %s", tt.method, tt.url)
		}
		if match.ID != tt.wantID {
			t.Errorf("%s %s: got rule %d, want %d", tt.method, tt.url, match.ID, tt.wantID)
		}
		if match.Action != tt.wantAction {
			t.Errorf("%s %s: got %s, want %s", tt.method, tt.url, match.Action, tt.wantAction)
		}
	}
}

func TestEvaluatorNoMatch(t *testing.T) {
	e := NewEvaluator()
	e.Load([]Rule{
		{ID: 1, URLPattern: `^https://specific\.com/$`, Methods: []string{"GET"},
			Action: "allow", Priority: 100, Enabled: true},
	})
	if m := e.Match("__all__", "https://other.com/", "GET"); m != nil {
		t.Fatalf("expected nil, got rule %d", m.ID)
	}
}

func TestEvaluatorReload(t *testing.T) {
	e := NewEvaluator()
	e.Load([]Rule{{ID: 1, URLPattern: `.*`, Methods: nil, Action: "deny", Priority: 0, Enabled: true}})
	if m := e.Match("__all__", "https://a.com/", "GET"); m.Action != "deny" {
		t.Fatal("expected deny")
	}

	e.Load([]Rule{{ID: 2, URLPattern: `.*`, Methods: nil, Action: "allow", Priority: 0, Enabled: true}})
	if m := e.Match("__all__", "https://a.com/", "GET"); m.Action != "allow" {
		t.Fatal("expected allow after reload")
	}
}
