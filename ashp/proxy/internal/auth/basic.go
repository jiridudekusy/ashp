package auth

import (
	"encoding/base64"
	"net/http"
	"strings"
)

type Handler struct {
	tokens map[string]string
}

func NewHandler(tokens map[string]string) *Handler {
	return &Handler{tokens: tokens}
}

func (h *Handler) Authenticate(req *http.Request) (agentID string, ok bool) {
	header := req.Header.Get("Proxy-Authorization")
	if header == "" {
		return "", false
	}
	if !strings.HasPrefix(header, "Basic ") {
		return "", false
	}

	decoded, err := base64.StdEncoding.DecodeString(header[6:])
	if err != nil {
		return "", false
	}

	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 {
		return "", false
	}

	user, pass := parts[0], parts[1]
	expected, exists := h.tokens[user]
	if !exists || expected != pass {
		return "", false
	}
	return user, true
}

func (h *Handler) Reload(tokens map[string]string) {
	h.tokens = tokens
}
