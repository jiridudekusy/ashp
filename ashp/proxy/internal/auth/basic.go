// Package auth provides HTTP Basic Authentication for proxy agents.
//
// Each agent is identified by a name and authenticated against a bcrypt-hashed
// token. To avoid the cost of bcrypt comparison on every request, successful
// and failed authentication results are cached for a configurable TTL using a
// SHA-256 hash of name:token as the cache key.
//
// All methods on [Handler] are safe for concurrent use.
package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Agent represents a registered proxy agent with a name, bcrypt token hash,
// and an enabled flag. Disabled agents are rejected even if credentials match.
type Agent struct {
	Name      string `json:"name"`
	TokenHash string `json:"token_hash"`
	Enabled   bool   `json:"enabled"`
}

// cacheEntry stores a bcrypt comparison result with an expiry timestamp.
type cacheEntry struct {
	ok      bool
	expires time.Time
}

// Handler authenticates incoming proxy requests using HTTP Basic
// Authentication (Proxy-Authorization header). It maintains an in-memory
// agent registry and a time-bounded bcrypt result cache. It also supports
// transparent proxy mode via source-IP-based authentication.
type Handler struct {
	mu     sync.RWMutex
	agents map[string]Agent // name -> Agent
	cache  map[string]cacheEntry
	ttl    time.Duration
	ipMap  map[string]string // IP → agent name for transparent proxy
}

// NewHandler returns a Handler with an empty agent set and a 60-second
// bcrypt cache TTL.
func NewHandler() *Handler {
	return &Handler{
		agents: make(map[string]Agent),
		cache:  make(map[string]cacheEntry),
		ttl:    60 * time.Second,
		ipMap:  make(map[string]string),
	}
}

// Reload atomically replaces the agent registry with the given slice and
// clears the bcrypt cache. This is called when an agents.reload IPC message
// arrives.
func (h *Handler) Reload(agents []Agent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.agents = make(map[string]Agent, len(agents))
	for _, a := range agents {
		h.agents[a.Name] = a
	}
	h.cache = make(map[string]cacheEntry) // clear cache on reload
}

// Authenticate extracts Basic credentials from the Proxy-Authorization header,
// looks up the agent by name, and verifies the token against the stored bcrypt
// hash (with caching). Returns the agent name and true on success, or empty
// string and false on failure.
//
// The authentication flow is:
//  1. Parse the Proxy-Authorization header (must be "Basic <base64>").
//  2. Decode to "name:token".
//  3. Look up the agent by name; reject if missing or disabled.
//  4. Check the SHA-256(name:token) cache; return cached result if not expired.
//  5. Fall back to bcrypt.CompareHashAndPassword, then cache the result.
func (h *Handler) Authenticate(req *http.Request) (string, bool) {
	header := req.Header.Get("Proxy-Authorization")
	if header == "" {
		return "", false
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || parts[0] != "Basic" {
		return "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", false
	}
	pair := strings.SplitN(string(decoded), ":", 2)
	if len(pair) != 2 {
		return "", false
	}
	name, token := pair[0], pair[1]

	h.mu.RLock()
	agent, exists := h.agents[name]
	h.mu.RUnlock()

	if !exists || !agent.Enabled {
		return "", false
	}

	// Check cache to avoid expensive bcrypt on every request.
	cacheKey := cacheKeyFor(name, token)
	h.mu.RLock()
	entry, cached := h.cache[cacheKey]
	h.mu.RUnlock()

	if cached && time.Now().Before(entry.expires) {
		if entry.ok {
			return name, true
		}
		return "", false
	}

	// Bcrypt compare (expensive; ~100ms per call).
	err = bcrypt.CompareHashAndPassword([]byte(agent.TokenHash), []byte(token))
	ok := err == nil

	h.mu.Lock()
	h.cache[cacheKey] = cacheEntry{ok: ok, expires: time.Now().Add(h.ttl)}
	h.mu.Unlock()

	if ok {
		return name, true
	}
	return "", false
}

// ReloadIPMap atomically replaces the IP-to-agent mapping used by
// transparent proxy mode for source-IP-based authentication.
func (h *Handler) ReloadIPMap(mapping map[string]string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ipMap = mapping
}

// AuthenticateByIP looks up the agent name associated with the given
// remote address (ip:port format). Returns the agent name and true if
// found, or empty string and false otherwise.
func (h *Handler) AuthenticateByIP(remoteAddr string) (string, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	name, ok := h.ipMap[host]
	return name, ok
}

// cacheKeyFor returns a hex-encoded SHA-256 hash of "name:token", used as a
// constant-size cache key that avoids storing plaintext credentials in memory.
func cacheKeyFor(name, token string) string {
	sum := sha256.Sum256([]byte(name + ":" + token))
	return hex.EncodeToString(sum[:])
}
