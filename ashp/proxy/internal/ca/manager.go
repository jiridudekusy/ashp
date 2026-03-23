// Package ca manages the root Certificate Authority used by the MITM proxy
// to dynamically sign TLS certificates for intercepted hosts.
//
// On first run, [GenerateCA] creates a self-signed ECDSA P-256 root CA and
// writes the certificate and passphrase-encrypted private key to disk. On
// subsequent runs, [LoadCA] reads and decrypts them. During proxying,
// [SignHost] issues short-lived (24h) leaf certificates signed by the root CA
// for each target hostname.
package ca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"time"
)

// GenerateCA creates a new self-signed ECDSA P-256 root CA certificate valid
// for 10 years. The certificate is written to certPath as PEM and the private
// key is written to keyPath encrypted with AES-256 using the given passphrase.
//
// The certificate has KeyUsageCertSign and KeyUsageCRLSign set, making it
// suitable only for signing subordinate certificates (not TLS serving).
//
// Returns the parsed *x509.Certificate on success.
func GenerateCA(certPath, keyPath string, passphrase []byte) (*x509.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "ASHP Root CA", Organization: []string{"ASHP"}},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	if err := os.WriteFile(certPath, certPEM, 0644); err != nil {
		return nil, err
	}

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	block, err := x509.EncryptPEMBlock(rand.Reader, "EC PRIVATE KEY", keyDER, passphrase, x509.PEMCipherAES256) //nolint:staticcheck
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0600); err != nil {
		return nil, err
	}

	cert, _ := x509.ParseCertificate(certDER)
	return cert, nil
}

// LoadCA reads a PEM-encoded CA certificate and its AES-256-encrypted private
// key from disk, decrypts the key with the given passphrase, and returns a
// [tls.Certificate] ready for use with [SignHost].
//
// The returned certificate's Leaf field is populated so callers can access the
// parsed *x509.Certificate without an additional parse step.
func LoadCA(certPath, keyPath string, passphrase []byte) (tls.Certificate, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return tls.Certificate{}, err
	}

	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return tls.Certificate{}, err
	}

	// Decrypt the PEM-encrypted private key using the passphrase.
	block, _ := pem.Decode(keyPEM)
	decrypted, err := x509.DecryptPEMBlock(block, passphrase) //nolint:staticcheck
	if err != nil {
		return tls.Certificate{}, err
	}

	plainBlock := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: decrypted})
	tlsCert, err := tls.X509KeyPair(certPEM, plainBlock)
	if err != nil {
		return tls.Certificate{}, err
	}
	tlsCert.Leaf, _ = x509.ParseCertificate(tlsCert.Certificate[0])
	return tlsCert, nil
}

// SignHost generates a short-lived (24-hour) ECDSA P-256 leaf certificate for
// the given hostname, signed by the provided CA certificate and key. The leaf
// certificate includes the hostname in both Subject.CommonName and DNSNames,
// and has ExtKeyUsageServerAuth set.
//
// This is called on every CONNECT request to produce a per-host certificate
// that the MITM proxy presents to the downstream client.
func SignHost(caCert *x509.Certificate, caKey interface{}, hostname string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}

	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: hostname},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{hostname},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &key.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, err
	}

	return tls.Certificate{
		Certificate: [][]byte{certDER},
		PrivateKey:  key,
	}, nil
}
