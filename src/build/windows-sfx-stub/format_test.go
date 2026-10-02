package main

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

// fakePE is a minimal PE32+ header: enough for certTableOffset to find the
// data directories. Returns the bytes and the offset of the security entry.
func fakePE() ([]byte, int) {
	const lfanew = 0x80
	b := make([]byte, 0x200)
	copy(b, "MZ")
	binary.LittleEndian.PutUint32(b[0x3c:], lfanew)
	copy(b[lfanew:], "PE\x00\x00")
	opt := lfanew + 4 + 20
	binary.LittleEndian.PutUint16(b[opt:], 0x20b)
	binary.LittleEndian.PutUint32(b[opt+108:], 16) // NumberOfRvaAndSizes
	return b, opt + 112 + 4*8
}

// withTrailer appends payload + trailer the way appendSfxPayload does.
func withTrailer(stub []byte, payload, hdr string) []byte {
	out := append([]byte{}, stub...)
	out = append(out, payload...)
	out = append(out, hdr...)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(hdr)))
	out = binary.LittleEndian.AppendUint64(out, uint64(len(payload)))
	return append(out, magic...)
}

// sign appends an Authenticode-shaped certificate table: the file padded to 8
// bytes, the table after it, and the security directory pointing at it.
func sign(exe []byte, secEntry int) []byte {
	out := append([]byte{}, exe...)
	for len(out)%8 != 0 {
		out = append(out, 0)
	}
	cert := bytes.Repeat([]byte{0xC5}, 4096)
	binary.LittleEndian.PutUint32(out[secEntry:], uint32(len(out)))
	binary.LittleEndian.PutUint32(out[secEntry+4:], uint32(len(cert)))
	return append(out, cert...)
}

const testHdr = `{"sha256":"ab","binary":"myapp","arch":"x64","format":"tar.zstd"}`

func TestReadTrailerUnsigned(t *testing.T) {
	stub, _ := fakePE()
	exe := withTrailer(stub, "PAYLOAD", testHdr)
	hdr, off, n, err := readTrailer(bytes.NewReader(exe), int64(len(exe)))
	if err != nil {
		t.Fatal(err)
	}
	if hdr.Binary != "myapp" || hdr.Format != "tar.zstd" || string(exe[off:off+n]) != "PAYLOAD" {
		t.Fatalf("hdr=%+v payload=%q", hdr, exe[off:off+n])
	}
}

// An Authenticode signature appends the certificate table AFTER the trailer,
// so the magic is no longer at EOF. Every padding 0..7 must be found.
func TestReadTrailerSigned(t *testing.T) {
	for pad := 0; pad < 8; pad++ {
		stub, sec := fakePE()
		payload := "PAYLOAD" + strings.Repeat("x", pad)
		exe := sign(withTrailer(stub, payload, testHdr), sec)
		if string(exe[len(exe)-len(magic):]) == magic {
			t.Fatal("fixture: the magic must not be at EOF")
		}
		hdr, off, n, err := readTrailer(bytes.NewReader(exe), int64(len(exe)))
		if err != nil {
			t.Fatalf("payload %d bytes: %v", len(payload), err)
		}
		if hdr.SHA256 != "ab" || string(exe[off:off+n]) != payload {
			t.Fatalf("payload %d bytes: hdr=%+v got %q", len(payload), hdr, exe[off:off+n])
		}
	}
}

func TestReadTrailerRefusesGarbage(t *testing.T) {
	stub, _ := fakePE()
	// Bytes appended with no security directory: not a signature, not ours.
	exe := append(withTrailer(stub, "PAYLOAD", testHdr), bytes.Repeat([]byte{0}, 4096)...)
	if _, _, _, err := readTrailer(bytes.NewReader(exe), int64(len(exe))); err == nil {
		t.Fatal("a trailer that is neither at EOF nor before the cert table must be refused")
	}
	// A payload length larger than the file.
	bad := withTrailer(stub, "P", testHdr)
	binary.LittleEndian.PutUint64(bad[len(bad)-16:], 1<<40)
	if _, _, _, err := readTrailer(bytes.NewReader(bad), int64(len(bad))); err == nil {
		t.Fatal("an oversized payload length must be refused")
	}
}
