// Package main implements the ashp-proxy CLI, the entry point for the ASHP
// (Agent-Sandboxed HTTP Proxy) forward proxy. It parses command-line flags,
// initializes the CA, authentication handler, rule evaluator, IPC client, and
// MITM proxy, then blocks until SIGTERM or SIGINT is received.
//
// The proxy operates in three default-behavior modes for requests that match
// no explicit rule:
//   - deny:  immediately reject the request (403).
//   - hold:  block the request and send an approval.needed IPC message;
//     the request is released or denied when approval.resolve arrives
//     or the hold timeout elapses.
//   - queue: reject the request but log it for later review.
//
// Configuration can be hot-reloaded at runtime via IPC messages:
// rules.reload, agents.reload, config.update, and approval.resolve.
package main

import (
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jdk/ashp/proxy/internal/auth"
	calib "github.com/jdk/ashp/proxy/internal/ca"
	"github.com/jdk/ashp/proxy/internal/ipc"
	"github.com/jdk/ashp/proxy/internal/mitm"
	"github.com/jdk/ashp/proxy/internal/rules"
)

// heldRequests maps IPC message IDs to channels used to deliver approval
// decisions back to the goroutine blocking inside holdRequestFn.
// Protected by heldRequestsMu.
var (
	heldRequests   = make(map[string]chan bool)
	heldRequestsMu sync.Mutex
	holdTimeout    = 60 * time.Second
)

func main() {
	listen := flag.String("listen", "0.0.0.0:8080", "proxy listen address")
	socket := flag.String("socket", "data/ashp.sock", "IPC socket path")
	caDir := flag.String("ca-dir", "data/ca", "CA certificate directory")
	caPass := flag.String("ca-pass", "", "CA key passphrase (or env:VAR)")
	logDir := flag.String("log-dir", "data/logs", "encrypted log directory")
	logKey := flag.String("log-key", "", "log encryption key hex (or env:VAR)")
	defaultBehavior := flag.String("default-behavior", "deny", "deny|hold|queue")
	holdTimeoutSec := flag.Int("hold-timeout", 60, "hold timeout in seconds for Mode B")
	flag.Parse()

	holdTimeout = time.Duration(*holdTimeoutSec) * time.Second

	caPassVal := resolveEnv(*caPass)
	logKeyVal := resolveEnv(*logKey)

	authHandler := auth.NewHandler()

	// Generate or load the root CA certificate. If the cert file does not
	// exist, a new ECDSA P-256 CA is created and written to caDir.
	certPath := *caDir + "/root.crt"
	keyPath := *caDir + "/root.key"
	var ca tls.Certificate
	if _, err := os.Stat(certPath); os.IsNotExist(err) {
		os.MkdirAll(*caDir, 0755)
		_, err := calib.GenerateCA(certPath, keyPath, []byte(caPassVal))
		if err != nil {
			fmt.Fprintf(os.Stderr, "CA generation failed: %v\n", err)
			os.Exit(1)
		}
	}
	ca, err := calib.LoadCA(certPath, keyPath, []byte(caPassVal))
	if err != nil {
		fmt.Fprintf(os.Stderr, "CA load failed: %v\n", err)
		os.Exit(1)
	}

	eval := rules.NewEvaluator()

	// Set up the IPC client with message handlers for hot-reloading
	// configuration. The client connects asynchronously and reconnects
	// with exponential backoff on disconnection.
	var ipcClient *ipc.Client
	ipcClient = ipc.NewClient(*socket,
		ipc.WithOnMessage(func(m ipc.Message) {
			switch m.Type {
			case "rules.reload":
				// Try per-agent map format first, fall back to flat list for
				// backwards compatibility with older control-plane versions.
				var agentMap map[string][]rules.Rule
				if err := json.Unmarshal(m.Data, &agentMap); err == nil {
					eval.LoadMap(agentMap)
				} else {
					var ruleList []rules.Rule
					json.Unmarshal(m.Data, &ruleList)
					eval.Load(ruleList)
				}
			case "agents.reload":
				// Replace the auth handler's agent set atomically.
				var agents []auth.Agent
				json.Unmarshal(m.Data, &agents)
				authHandler.Reload(agents)
			case "config.update":
				// Dynamically update default behavior and hold timeout.
				var update struct {
					DefaultBehavior string `json:"default_behavior"`
					HoldTimeoutSec  int    `json:"hold_timeout"`
				}
				if err := json.Unmarshal(m.Data, &update); err == nil {
					if update.DefaultBehavior != "" {
						*defaultBehavior = update.DefaultBehavior
					}
					if update.HoldTimeoutSec > 0 {
						holdTimeout = time.Duration(update.HoldTimeoutSec) * time.Second
					}
				}
			case "approval.resolve":
				// Deliver the approval decision to the goroutine that is
				// blocking in holdRequestFn. The m.Ref field correlates
				// the response back to the original approval.needed message.
				heldRequestsMu.Lock()
				ch, ok := heldRequests[m.Ref]
				if ok {
					delete(heldRequests, m.Ref)
				}
				heldRequestsMu.Unlock()
				if ok {
					var resolve struct {
						Action string `json:"action"`
					}
					json.Unmarshal(m.Data, &resolve)
					ch <- (resolve.Action == "approve")
				}
			}
		}),
		ipc.WithOnReconnect(func() {
			// On reconnect, re-send all pending approval requests so the
			// control plane knows about held requests that were in-flight
			// when the connection dropped.
			heldRequestsMu.Lock()
			heldMsgIDs := make([]string, 0, len(heldRequests))
			for msgID := range heldRequests {
				heldMsgIDs = append(heldMsgIDs, msgID)
			}
			heldRequestsMu.Unlock()
			for _, msgID := range heldMsgIDs {
				ipcClient.Send(ipc.Message{
					Type:  "approval.needed",
					MsgID: msgID,
				})
			}
		}),
	)
	go ipcClient.Connect()

	// holdRequestFn blocks the calling goroutine (an HTTP handler) until
	// an approval.resolve IPC message arrives or the hold timeout elapses.
	// It returns true if the request was approved, false otherwise.
	holdRequestFn := func(msg ipc.Message) bool {
		ch := make(chan bool, 1)
		heldRequestsMu.Lock()
		heldRequests[msg.MsgID] = ch
		heldRequestsMu.Unlock()

		ipcClient.Send(msg)

		select {
		case approved := <-ch:
			return approved
		case <-time.After(holdTimeout):
			heldRequestsMu.Lock()
			delete(heldRequests, msg.MsgID)
			heldRequestsMu.Unlock()
			return false
		}
	}

	p := mitm.New(mitm.Config{
		CA: ca, Evaluator: eval, Auth: authHandler,
		LogDir: *logDir, LogKey: decodeLogKey(logKeyVal),
		IPC: ipcClient, DefaultBehavior: *defaultBehavior,
		HoldRequest: holdRequestFn,
	})
	ln, err := p.Start(*listen)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to listen on %s: %v\n", *listen, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "ASHP proxy listening on %s\n", ln.Addr())

	// Block until a termination signal is received, then shut down gracefully.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	fmt.Fprintln(os.Stderr, "Shutting down...")
	p.Stop()
	ipcClient.Close()
}

// resolveEnv dereferences an "env:VAR_NAME" indirection. If val starts with
// "env:", the remainder is treated as an environment variable name and its
// value is returned. Otherwise val is returned as-is.
func resolveEnv(val string) string {
	if len(val) > 4 && val[:4] == "env:" {
		return os.Getenv(val[4:])
	}
	return val
}

// decodeLogKey interprets val as a hex-encoded AES-256 key. If val is empty,
// nil is returned (encryption disabled). If hex decoding fails, the raw bytes
// of val are used as a fallback.
func decodeLogKey(val string) []byte {
	if val == "" {
		return nil
	}
	decoded, err := hex.DecodeString(val)
	if err != nil {
		// Not hex -- use raw bytes as fallback
		return []byte(val)
	}
	return decoded
}
