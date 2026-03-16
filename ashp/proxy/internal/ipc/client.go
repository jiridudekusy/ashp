package ipc

import (
	"bufio"
	"encoding/json"
	"net"
	"sync"
	"time"
)

type ClientOption func(*Client)

func WithOnMessage(fn func(Message)) ClientOption { return func(c *Client) { c.onMessage = fn } }
func WithOnReconnect(fn func()) ClientOption      { return func(c *Client) { c.reconnectFn = fn } }
func WithBackoff(min, max time.Duration) ClientOption {
	return func(c *Client) { c.minBackoff = min; c.maxBackoff = max }
}
func WithBufferSize(n int) ClientOption { return func(c *Client) { c.bufSize = n } }

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

		c.readLoop(conn)
	}
}

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
	c.mu.Lock()
	c.conn = nil
	c.mu.Unlock()
}

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

func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.conn != nil {
		c.conn.Close()
	}
}
