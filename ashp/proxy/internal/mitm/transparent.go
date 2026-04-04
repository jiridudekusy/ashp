package mitm

import (
	"bufio"
	"fmt"
	"io"
	"net"
)

// extractSNI peeks at the TLS ClientHello on conn and returns the SNI
// server name. The returned net.Conn is a buffered wrapper that replays
// the peeked bytes so the caller can pass it to tls.Server unchanged.
func extractSNI(conn net.Conn) (string, net.Conn, error) {
	br := bufio.NewReader(conn)

	// TLS record header: 1 byte type + 2 bytes version + 2 bytes length
	hdr, err := br.Peek(5)
	if err != nil {
		return "", nil, fmt.Errorf("peek TLS header: %w", err)
	}
	if hdr[0] != 0x16 { // ContentType handshake
		return "", nil, fmt.Errorf("not a TLS handshake (type=%d)", hdr[0])
	}
	recordLen := int(hdr[3])<<8 | int(hdr[4])

	// Peek full record
	record, err := br.Peek(5 + recordLen)
	if err != nil {
		return "", nil, fmt.Errorf("peek TLS record: %w", err)
	}

	sni := parseSNIFromClientHello(record[5:])
	if sni == "" {
		return "", nil, fmt.Errorf("no SNI found in ClientHello")
	}

	wrapped := &bufferedConn{Reader: br, Conn: conn}
	return sni, wrapped, nil
}

// parseSNIFromClientHello extracts the server_name from a TLS ClientHello
// handshake message body. Returns empty string if not found.
func parseSNIFromClientHello(data []byte) string {
	if len(data) < 42 {
		return ""
	}
	if data[0] != 0x01 { // ClientHello
		return ""
	}
	// Handshake: type(1) + length(3) + version(2) + random(32) = 38
	pos := 38

	// Session ID
	if pos >= len(data) {
		return ""
	}
	sidLen := int(data[pos])
	pos += 1 + sidLen

	// Cipher suites
	if pos+2 > len(data) {
		return ""
	}
	csLen := int(data[pos])<<8 | int(data[pos+1])
	pos += 2 + csLen

	// Compression methods
	if pos >= len(data) {
		return ""
	}
	cmLen := int(data[pos])
	pos += 1 + cmLen

	// Extensions
	if pos+2 > len(data) {
		return ""
	}
	extLen := int(data[pos])<<8 | int(data[pos+1])
	pos += 2
	end := pos + extLen

	for pos+4 <= end && pos+4 <= len(data) {
		extType := int(data[pos])<<8 | int(data[pos+1])
		extDataLen := int(data[pos+2])<<8 | int(data[pos+3])
		pos += 4
		if extType == 0x0000 { // server_name
			if pos+5 <= len(data) && pos+5 <= pos+extDataLen {
				nameLen := int(data[pos+3])<<8 | int(data[pos+4])
				if pos+5+nameLen <= len(data) {
					return string(data[pos+5 : pos+5+nameLen])
				}
			}
			return ""
		}
		pos += extDataLen
	}
	return ""
}

// bufferedConn wraps a net.Conn with a bufio.Reader so that peeked
// bytes from SNI extraction are replayed during the TLS handshake.
type bufferedConn struct {
	io.Reader
	net.Conn
}

func (c *bufferedConn) Read(b []byte) (int, error) {
	return c.Reader.Read(b)
}
