package logger

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteAndReadRecord(t *testing.T) {
	dir := t.TempDir()
	key := bytes.Repeat([]byte{0xab}, 32)
	w, err := NewWriter(dir, key)
	if err != nil {
		t.Fatal(err)
	}

	payload := []byte(`{"method":"GET","url":"https://example.com"}`)
	ref, err := w.Write(payload)
	if err != nil {
		t.Fatal(err)
	}

	if ref == "" {
		t.Fatal("empty ref")
	}

	data, err := ReadRecord(dir, ref, key)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, payload) {
		t.Fatalf("got %s", data)
	}
}

func TestHourlyRotation(t *testing.T) {
	dir := t.TempDir()
	key := bytes.Repeat([]byte{0xab}, 32)
	w, _ := NewWriter(dir, key)

	w.Write([]byte("record1"))
	now := time.Now().UTC()
	expected := filepath.Join(dir, now.Format("2006/01/02"), now.Format("15")+".log.enc")
	if _, err := os.Stat(expected); err != nil {
		t.Fatalf("expected file %s: %v", expected, err)
	}
}

func TestRecordLengthPrefixSuffix(t *testing.T) {
	dir := t.TempDir()
	key := bytes.Repeat([]byte{0xab}, 32)
	w, _ := NewWriter(dir, key)

	w.Write([]byte("test data"))

	now := time.Now().UTC()
	path := filepath.Join(dir, now.Format("2006/01/02"), now.Format("15")+".log.enc")
	data, _ := os.ReadFile(path)
	prefix := binary.LittleEndian.Uint32(data[0:4])
	suffix := binary.LittleEndian.Uint32(data[len(data)-4:])
	if prefix != suffix {
		t.Fatalf("prefix %d != suffix %d", prefix, suffix)
	}
	if int(prefix) != len(data) {
		t.Fatalf("length %d != file size %d", prefix, len(data))
	}
}

func TestMultipleRecords(t *testing.T) {
	dir := t.TempDir()
	key := bytes.Repeat([]byte{0xab}, 32)
	w, _ := NewWriter(dir, key)

	ref1, _ := w.Write([]byte("first"))
	ref2, _ := w.Write([]byte("second"))

	d1, _ := ReadRecord(dir, ref1, key)
	d2, _ := ReadRecord(dir, ref2, key)
	if string(d1) != "first" {
		t.Fatalf("got %s", d1)
	}
	if string(d2) != "second" {
		t.Fatalf("got %s", d2)
	}
}
