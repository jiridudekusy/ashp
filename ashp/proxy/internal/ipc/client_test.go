package ipc

import (
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestClientConnectsAndReceives(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "test.sock")
	ln, _ := net.Listen("unix", sock)
	defer ln.Close()

	msgs := make(chan Message, 10)
	c := NewClient(sock, WithOnMessage(func(m Message) { msgs <- m }))
	go c.Connect()
	defer c.Close()

	conn, _ := ln.Accept()
	conn.Write([]byte(`{"type":"rules.reload","msg_id":"abc"}` + "\n"))

	select {
	case m := <-msgs:
		if m.Type != "rules.reload" {
			t.Fatalf("got %s", m.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout")
	}
}

func TestClientSendsMessage(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "test.sock")
	ln, _ := net.Listen("unix", sock)
	defer ln.Close()

	c := NewClient(sock)
	go c.Connect()
	defer c.Close()

	conn, _ := ln.Accept()
	c.Send(Message{Type: "request.logged", MsgID: "123"})

	buf := make([]byte, 4096)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _ := conn.Read(buf)
	var m Message
	json.Unmarshal(buf[:n-1], &m)
	if m.Type != "request.logged" {
		t.Fatalf("got %s", m.Type)
	}
}

func TestClientReconnects(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "test.sock")
	ln, _ := net.Listen("unix", sock)

	reconnects := make(chan struct{}, 10)
	c := NewClient(sock,
		WithOnReconnect(func() { reconnects <- struct{}{} }),
		WithBackoff(10*time.Millisecond, 50*time.Millisecond),
	)
	go c.Connect()
	defer c.Close()

	conn, _ := ln.Accept()
	conn.Close()

	select {
	case <-reconnects:
	case <-time.After(2 * time.Second):
		t.Fatal("no reconnect")
	}
}

func TestClientBuffersOnDisconnect(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "test.sock")
	c := NewClient(sock, WithBufferSize(5))

	for i := 0; i < 3; i++ {
		c.Send(Message{Type: "buffered", MsgID: string(rune('a' + i))})
	}

	ln, _ := net.Listen("unix", sock)
	defer ln.Close()
	go c.Connect()
	defer c.Close()

	conn, _ := ln.Accept()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 65536)
	n, _ := conn.Read(buf)
	lines := 0
	for _, b := range buf[:n] {
		if b == '\n' {
			lines++
		}
	}
	if lines != 3 {
		t.Fatalf("expected 3 buffered messages, got %d", lines)
	}
}
