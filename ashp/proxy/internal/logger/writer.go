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

type Writer struct {
	dir string
	key []byte
	mu  sync.Mutex
	fh  *os.File
	pos int64
	cur string
}

func NewWriter(dir string, key []byte) (*Writer, error) {
	return &Writer{dir: dir, key: key}, nil
}

func (w *Writer) Write(payload []byte) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

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

func (w *Writer) currentPath() string {
	now := time.Now().UTC()
	return filepath.Join(now.Format("2006/01/02"), now.Format("15")+".log.enc")
}

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

func deriveKey(master []byte, offset int64) []byte {
	info := []byte(fmt.Sprintf("ashp-log-record:%d", offset))
	r := hkdf.New(sha256.New, master, nil, info)
	key := make([]byte, 32)
	io.ReadFull(r, key)
	return key
}

func (w *Writer) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.fh != nil {
		w.fh.Close()
	}
}
