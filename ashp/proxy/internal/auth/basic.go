package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Agent struct {
	Name      string `json:"name"`
	TokenHash string `json:"token_hash"`
	Enabled   bool   `json:"enabled"`
}

type cacheEntry struct {
	ok      bool
	expires time.Time
}

type Handler struct {
	mu     sync.RWMutex
	agents map[string]Agent // name -> Agent
	cache  map[string]cacheEntry
	ttl    time.Duration
}

func NewHandler() *Handler {
	return &Handler{
		agents: make(map[string]Agent),
		cache:  make(map[string]cacheEntry),
		ttl:    60 * time.Second,
	}
}

func (h *Handler) Reload(agents []Agent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.agents = make(map[string]Agent, len(agents))
	for _, a := range agents {
		h.agents[a.Name] = a
	}
	h.cache = make(map[string]cacheEntry) // clear cache on reload
}

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

	// Check cache
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

	// Bcrypt compare
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

func cacheKeyFor(name, token string) string {
	sum := sha256.Sum256([]byte(name + ":" + token))
	return hex.EncodeToString(sum[:])
}
