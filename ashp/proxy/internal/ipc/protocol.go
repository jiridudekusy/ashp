package ipc

import "encoding/json"

type Message struct {
	Type  string          `json:"type"`
	MsgID string          `json:"msg_id"`
	Ref   string          `json:"ref,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

func Frame(m Message) []byte {
	b, _ := json.Marshal(m)
	return append(b, '\n')
}
