package ipc

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
)

type Message struct {
	Type  string          `json:"type"`
	MsgID string          `json:"msg_id"`
	Ref   string          `json:"ref,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

func GenerateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func Frame(m Message) []byte {
	if m.MsgID == "" {
		m.MsgID = GenerateID()
	}
	b, _ := json.Marshal(m)
	return append(b, '\n')
}
