// Package ipc implements a Unix domain socket IPC client that communicates
// with the ASHP control plane using newline-delimited JSON messages.
//
// The client automatically reconnects with exponential backoff when the
// connection drops, and buffers outbound messages while disconnected (up to
// a configurable limit). On reconnect, buffered messages are flushed and an
// optional reconnect callback is invoked so the caller can re-establish any
// server-side state (e.g., re-send pending approval requests).
package ipc

import (
	"bufio"
	"encoding/json"
	"net"
	"sync"
	"time"
)

// ClientOption is a functional option for configuring a [Client].
type ClientOption func(*Client)

// WithOnMessage sets the callback invoked for each inbound [Message] received
// from the control plane. The callback is called synchronously on the read
// loop goroutine; long-running work should be dispatched to a separate
// goroutine.
func WithOnMessage(fn func(Message)) ClientOption { return func(c *Client) { c.onMessage = fn } }

// WithOnReconnect sets a callback invoked after the client successfully
// reconnects (but not on the initial connection). This is useful for
// re-registering state with the server, such as pending held requests.
func WithOnReconnect(fn func()) ClientOption { return func(c *Client) { c.reconnectFn = fn } }

// WithBackoff sets the minimum and maximum backoff durations for reconnection
// attempts. The backoff doubles on each failed attempt until it reaches max.
func WithBackoff(min, max time.Duration) ClientOption {
	return func(c *Client) { c.minBackoff = min; c.maxBackoff = max }
}

// WithBufferSize sets the maximum number of outbound messages to buffer while
// the connection is down. When the buffer is full, the oldest message is
// dropped (FIFO eviction).
func WithBufferSize(n int) ClientOption { return func(c *Client) { c.bufSize = n } }

// Client is a reconnecting Unix domain socket IPC client. It is safe for
// concurrent use; Send may be called from any goroutine. Connect runs the
// connection loop and should be started in its own goroutine.
type Client struct {
	sockPath    string
	conn        net.Conn
	mu          sync.Mutex
	onMessage   func(Message)
	reconnectFn func()
	minBackoff  time.Duration
	maxBackoff  time.Duration
	bufSize     int
	buffer      []Message
	closed      bool
}

// NewClient creates a Client that will connect to the Unix socket at
// sockPath. No connection is attempted until [Client.Connect] is called.
// Use [ClientOption] functions to configure message handling, reconnect
// behavior, backoff, and buffer size.
func NewClient(sockPath string, opts ...ClientOption) *Client {
	c := &Client{
		sockPath:   sockPath,
		minBackoff: 100 * time.Millisecond,
		maxBackoff: 10 * time.Second,
		bufSize:    10000,
		onMessage:  func(Message) {},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// Connect runs the blocking connection loop. It dials the Unix socket,
// flushes any buffered messages, then enters a read loop. When the connection
// drops, it reconnects with exponential backoff. Connect returns only when
// [Client.Close] has been called.
//
// This method should be called in a dedicated goroutine:
//
//	go client.Connect()
func (c *Client) Connect() {
	backoff := c.minBackoff
	first := true
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()

		conn, err := net.Dial("unix", c.sockPath)
		if err != nil {
			time.Sleep(backoff)
			backoff *= 2
			if backoff > c.maxBackoff {
				backoff = c.maxBackoff
			}
			continue
		}

		// Connection established: flush buffered messages and reset backoff.
		c.mu.Lock()
		c.conn = conn
		for _, m := range c.buffer {
			conn.Write(Frame(m))
		}
		c.buffer = nil
		c.mu.Unlock()

		backoff = c.minBackoff
		if !first && c.reconnectFn != nil {
			c.reconnectFn()
		}
		first = false

		// readLoop blocks until the connection is closed or errors.
		c.readLoop(conn)
	}
}

// readLoop reads newline-delimited JSON messages from the connection and
// dispatches them to the onMessage callback. It returns when the connection
// is closed or an unrecoverable read error occurs.
func (c *Client) readLoop(conn net.Conn) {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		var m Message
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			continue
		}
		c.onMessage(m)
	}
	// Connection lost; clear the conn so Send will buffer.
	c.mu.Lock()
	c.conn = nil
	c.mu.Unlock()
}

// Send transmits a message to the control plane. If the connection is down,
// the message is appended to an in-memory buffer (up to bufSize). When the
// buffer overflows, the oldest message is evicted. Send is safe for
// concurrent use.
func (c *Client) Send(m Message) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != nil {
		c.conn.Write(Frame(m))
	} else {
		c.buffer = append(c.buffer, m)
		if len(c.buffer) > c.bufSize {
			c.buffer = c.buffer[1:]
		}
	}
}

// Close marks the client as closed and shuts down the underlying connection.
// After Close returns, Connect will exit its loop and Send will continue to
// buffer (though the buffer will never be flushed).
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.conn != nil {
		c.conn.Close()
	}
}
