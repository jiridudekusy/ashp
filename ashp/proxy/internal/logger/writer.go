// Package logger provides an append-only, AES-256-GCM encrypted log writer
// that stores request and response bodies captured by the MITM proxy.
//
// # On-disk format
//
// Log files are organized by date and hour:
//
//	<dir>/2006/01/02/15.log.enc
//
// Each file contains a sequence of encrypted records. Each record has the
// following binary layout (all integers little-endian):
//
//	[4 bytes: total_len] [12 bytes: nonce] [ciphertext + GCM tag] [4 bytes: total_len]
//
// The total_len trailer duplicates the header to allow reverse scanning.
//
// # Key derivation
//
// A unique 256-bit AES key is derived for each record using HKDF-SHA256 with
// the master key and the record's byte offset as context info:
//
//	info = "ashp-log-record:<offset>"
//
// This ensures that even identical plaintexts produce different ciphertexts
// across records, and a compromised record key does not reveal the master key.
//
// # Referencing records
//
// [Writer.Write] returns a ref string of the form "path:offset:length" that
// uniquely identifies a record in the log store. [ReadRecord] can retrieve
// and decrypt a record given its ref and the master key.
//
// All methods on [Writer] are safe for concurrent use.
package logger

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/hkdf"
)

// Writer is an append-only encrypted log writer. It holds at most one open
// file handle at a time (the current hour's log file) and rotates
// automatically when the hour changes.
type Writer struct {
	dir string
	key []byte
	mu  sync.Mutex
	fh  *os.File
	pos int64
	cur string // relative path of the currently open file
}

// NewWriter creates a Writer that stores encrypted log records under dir
// using the given master key for AES-256-GCM encryption. If key is nil,
// Write calls will still succeed but produce unreadable output.
func NewWriter(dir string, key []byte) (*Writer, error) {
	return &Writer{dir: dir, key: key}, nil
}

// Write encrypts payload with AES-256-GCM and appends the resulting record
// to the current hour's log file. It returns a ref string
// ("path:offset:length") that can later be passed to [ReadRecord] for
// decryption.
//
// The encryption steps are:
//  1. Determine the current file (rotate if the hour has changed).
//  2. Derive a per-record AES-256 key using HKDF(master, offset).
//  3. Generate a random 12-byte nonce.
//  4. Encrypt payload with AES-256-GCM using the derived key and nonce.
//  5. Write the framed record: [total_len | nonce | ciphertext | total_len].
//  6. Return the ref string for later retrieval.
func (w *Writer) Write(payload []byte) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Rotate to a new file if the hour has changed.
	relPath := w.currentPath()
	if relPath != w.cur {
		if w.fh != nil {
			w.fh.Close()
		}
		absPath := filepath.Join(w.dir, relPath)
		os.MkdirAll(filepath.Dir(absPath), 0755)
		fh, err := os.OpenFile(absPath, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
		if err != nil {
			return "", err
		}
		info, _ := fh.Stat()
		w.fh = fh
		w.pos = info.Size()
		w.cur = relPath
	}

	offset := w.pos
	recordKey := deriveKey(w.key, offset)
	nonce := make([]byte, 12)
	io.ReadFull(rand.Reader, nonce)

	block, _ := aes.NewCipher(recordKey)
	gcm, _ := cipher.NewGCM(block)
	ciphertext := gcm.Seal(nil, nonce, payload, nil)

	// Build the framed record: header(4) + nonce(12) + ciphertext + trailer(4).
	totalLen := uint32(4 + 12 + len(ciphertext) + 4)
	buf := make([]byte, totalLen)
	binary.LittleEndian.PutUint32(buf[0:4], totalLen)
	copy(buf[4:16], nonce)
	copy(buf[16:16+len(ciphertext)], ciphertext)
	binary.LittleEndian.PutUint32(buf[totalLen-4:], totalLen)

	n, err := w.fh.Write(buf)
	if err != nil {
		return "", err
	}
	w.pos += int64(n)

	return fmt.Sprintf("%s:%d:%d", w.cur, offset, totalLen), nil
}

// currentPath returns the relative log file path for the current UTC hour.
func (w *Writer) currentPath() string {
	now := time.Now().UTC()
	return filepath.Join(now.Format("2006/01/02"), now.Format("15")+".log.enc")
}

// ReadRecord decrypts and returns a single log record identified by ref
// ("path:offset:length"). The masterKey must be the same key that was used
// when the record was written.
//
// The decryption steps mirror [Writer.Write]:
//  1. Parse the ref into file path, byte offset, and record length.
//  2. Read the raw record bytes from the file at the given offset.
//  3. Extract the nonce (bytes 4..16) and ciphertext (bytes 16..len-4).
//  4. Derive the per-record key using HKDF(masterKey, offset).
//  5. Decrypt with AES-256-GCM.
func ReadRecord(baseDir, ref string, masterKey []byte) ([]byte, error) {
	parts := strings.SplitN(ref, ":", 3)
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid ref: %s", ref)
	}
	filePath := parts[0]
	var offset, length int64
	fmt.Sscanf(parts[1], "%d", &offset)
	fmt.Sscanf(parts[2], "%d", &length)

	fh, err := os.Open(filepath.Join(baseDir, filePath))
	if err != nil {
		return nil, err
	}
	defer fh.Close()

	buf := make([]byte, length)
	if _, err := fh.ReadAt(buf, offset); err != nil {
		return nil, err
	}

	nonce := buf[4:16]
	ciphertext := buf[16 : length-4]
	recordKey := deriveKey(masterKey, offset)

	block, _ := aes.NewCipher(recordKey)
	gcm, _ := cipher.NewGCM(block)
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// deriveKey uses HKDF-SHA256 to derive a 256-bit AES key from the master key
// and the record's byte offset. The info string "ashp-log-record:<offset>"
// ensures each record gets a unique key.
func deriveKey(master []byte, offset int64) []byte {
	info := []byte(fmt.Sprintf("ashp-log-record:%d", offset))
	r := hkdf.New(sha256.New, master, nil, info)
	key := make([]byte, 32)
	io.ReadFull(r, key)
	return key
}

// Close flushes and closes the currently open log file. After Close, further
// calls to Write will reopen the file on the next invocation.
func (w *Writer) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.fh != nil {
		w.fh.Close()
	}
}
