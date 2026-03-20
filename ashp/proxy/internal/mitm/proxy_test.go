package mitm

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/jdk/ashp/proxy/internal/auth"
	calib "github.com/jdk/ashp/proxy/internal/ca"
	"github.com/jdk/ashp/proxy/internal/rules"
	"golang.org/x/crypto/bcrypt"
)

func setupProxy(t *testing.T) (*Proxy, string) {
	dir := t.TempDir()
	calib.GenerateCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))
	ca, _ := calib.LoadCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))

	eval := rules.NewEvaluator()
	authH := auth.NewHandler()
	hash, _ := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.DefaultCost)
	authH.Reload([]auth.Agent{
		{Name: "agent1", TokenHash: string(hash), Enabled: true},
	})
	logKey := bytes.Repeat([]byte{0xab}, 32)

	p := New(Config{
		CA:        ca,
		Evaluator: eval,
		Auth:      authH,
		LogDir:    filepath.Join(dir, "logs"),
		LogKey:    logKey,
	})
	ln, err := p.Start("127.0.0.1:0")
	if err != nil { t.Fatal(err) }
	return p, "http://" + ln.Addr().String()
}

func TestAllowedRequest(t *testing.T) {
	p, proxyURL := setupProxy(t)
	defer p.Stop()

	p.evaluator.Load([]rules.Rule{
		{ID: 1, URLPattern: `.*`, Methods: nil, Action: "allow", Priority: 0, Enabled: true},
	})

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("hello"))
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
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "hello" {
		t.Fatalf("got %s", body)
	}
}

func TestDeniedRequest(t *testing.T) {
	p, proxyURL := setupProxy(t)
	defer p.Stop()

	p.evaluator.Load([]rules.Rule{
		{ID: 1, URLPattern: `.*`, Methods: nil, Action: "deny", Priority: 0, Enabled: true},
	})

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("request should not reach target")
	}))
	defer target.Close()

	client := &http.Client{Transport: &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) { return url.Parse(proxyURL) },
	}}
	req, _ := http.NewRequest("GET", target.URL+"/blocked", nil)
	req.Header.Set("Proxy-Authorization", "Basic YWdlbnQxOnNlY3JldA==")
	resp, _ := client.Do(req)
	if resp.StatusCode != 403 {
		t.Fatalf("got status %d", resp.StatusCode)
	}
}

func TestAuthRequired(t *testing.T) {
	p, proxyURL := setupProxy(t)
	defer p.Stop()

	client := &http.Client{Transport: &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) { return url.Parse(proxyURL) },
	}}
	req, _ := http.NewRequest("GET", "http://example.com/", nil)
	resp, _ := client.Do(req)
	if resp.StatusCode != 407 {
		t.Fatalf("expected 407, got %d", resp.StatusCode)
	}
}
