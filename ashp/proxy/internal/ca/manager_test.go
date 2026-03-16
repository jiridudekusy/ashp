package ca

import (
	"crypto/x509"
	"os"
	"path/filepath"
	"testing"
)

func TestGenerateCA(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "root.crt")
	keyPath := filepath.Join(dir, "root.key")
	passphrase := []byte("test-passphrase")

	caCert, err := GenerateCA(certPath, keyPath, passphrase)
	if err != nil {
		t.Fatal(err)
	}
	if !caCert.IsCA {
		t.Fatal("expected CA cert")
	}

	if _, err := os.Stat(certPath); err != nil {
		t.Fatal("cert file missing")
	}
	if _, err := os.Stat(keyPath); err != nil {
		t.Fatal("key file missing")
	}

	caCert2, err := LoadCA(certPath, keyPath, passphrase)
	if err != nil {
		t.Fatal(err)
	}
	if !caCert2.Leaf.Equal(caCert) {
		t.Fatal("reloaded cert mismatch")
	}
}

func TestSignHost(t *testing.T) {
	dir := t.TempDir()
	GenerateCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))
	ca, _ := LoadCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"), []byte("pass"))

	tlsCert, err := SignHost(ca.Leaf, ca.PrivateKey, "example.com")
	if err != nil {
		t.Fatal(err)
	}

	parsed, _ := x509.ParseCertificate(tlsCert.Certificate[0])
	if parsed.Subject.CommonName != "example.com" {
		t.Fatalf("CN = %s", parsed.Subject.CommonName)
	}

	pool := x509.NewCertPool()
	pool.AddCert(ca.Leaf)
	if _, err := parsed.Verify(x509.VerifyOptions{Roots: pool}); err != nil {
		t.Fatalf("cert verification failed: %v", err)
	}
}

func TestWrongPassphrase(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "ca.crt")
	keyPath := filepath.Join(dir, "ca.key")
	GenerateCA(certPath, keyPath, []byte("correct"))
	_, err := LoadCA(certPath, keyPath, []byte("wrong"))
	if err == nil {
		t.Fatal("expected error with wrong passphrase")
	}
}
