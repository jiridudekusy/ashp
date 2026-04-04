package mitm

import (
	"crypto/tls"
	"net"
	"testing"
	"time"
)

func TestExtractSNI(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	done := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- ""
			return
		}
		defer conn.Close()
		sni, _, err := extractSNI(conn)
		if err != nil {
			t.Logf("extractSNI error: %v", err)
			done <- ""
			return
		}
		done <- sni
	}()

	conn, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	tlsConn := tls.Client(conn, &tls.Config{
		ServerName:         "example.com",
		InsecureSkipVerify: true,
	})
	go tlsConn.Handshake()
	time.Sleep(100 * time.Millisecond)
	tlsConn.Close()

	sni := <-done
	if sni != "example.com" {
		t.Fatalf("expected SNI 'example.com', got '%s'", sni)
	}
}

func TestExtractSNI_LongHostname(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	done := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- ""
			return
		}
		defer conn.Close()
		sni, _, err := extractSNI(conn)
		if err != nil {
			done <- ""
			return
		}
		done <- sni
	}()

	conn, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	tlsConn := tls.Client(conn, &tls.Config{
		ServerName:         "api.subdomain.example.co.uk",
		InsecureSkipVerify: true,
	})
	go tlsConn.Handshake()
	time.Sleep(100 * time.Millisecond)
	tlsConn.Close()

	sni := <-done
	if sni != "api.subdomain.example.co.uk" {
		t.Fatalf("expected long hostname, got '%s'", sni)
	}
}
