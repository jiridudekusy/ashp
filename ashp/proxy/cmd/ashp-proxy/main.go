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

	var ipcClient *ipc.Client
	ipcClient = ipc.NewClient(*socket,
		ipc.WithOnMessage(func(m ipc.Message) {
			switch m.Type {
			case "rules.reload":
				var ruleList []rules.Rule
				json.Unmarshal(m.Data, &ruleList)
				eval.Load(ruleList)
			case "agents.reload":
				var agents []auth.Agent
				json.Unmarshal(m.Data, &agents)
				authHandler.Reload(agents)
			case "config.update":
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

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	fmt.Fprintln(os.Stderr, "Shutting down...")
	p.Stop()
	ipcClient.Close()
}

func resolveEnv(val string) string {
	if len(val) > 4 && val[:4] == "env:" {
		return os.Getenv(val[4:])
	}
	return val
}

func decodeLogKey(val string) []byte {
	if val == "" {
		return nil
	}
	decoded, err := hex.DecodeString(val)
	if err != nil {
		// Not hex — use raw bytes as fallback
		return []byte(val)
	}
	return decoded
}
