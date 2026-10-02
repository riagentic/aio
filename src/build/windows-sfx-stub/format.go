// Shared SFX format for the Windows stub and its Deno packer
// (`appendSfxPayload` in ../build-windows-exe.ts). Built for the host too, so
// `go test` covers the trailer parser on any machine.
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// Magic trailer both ends agree on. Bumped from AIOSFX01 (a bare zip payload,
// no outer compression) to AIOSFX02 (a zstd-compressed tar, ~15% smaller and
// faster to extract). Keep in sync with src/build/build-windows-exe.ts — a
// Deno test compares the two and the committed PE.
const magic = "AIOSFX02"

type header struct {
	SHA256 string `json:"sha256"`
	Binary string `json:"binary"`
	Arch   string `json:"arch"`
	// Format of the payload that follows the stub: "tar.zstd" (the default) or
	// "zip" (the historical payload, still extractable so a mixed fleet keeps
	// working).
	Format string `json:"format"`
}

// Trailer layout (logical end of file):
//
//	[payload bytes]
//	[JSON header]
//	[u32 LE header length]
//	[u64 LE payload length]
//	[8 magic "AIOSFX02"]
const trailerFixed = 4 + 8 + len(magic)

// readTrailer locates and parses the SFX trailer of an exe of `size` bytes.
func readTrailer(f io.ReaderAt, size int64) (hdr header, payloadOff, payloadLen int64, err error) {
	end, err := trailerEnd(f, size)
	if err != nil {
		return hdr, 0, 0, err
	}
	fixed := make([]byte, trailerFixed)
	if _, err := f.ReadAt(fixed, end-int64(trailerFixed)); err != nil {
		return hdr, 0, 0, err
	}
	hdrLen := int64(binary.LittleEndian.Uint32(fixed[0:4]))
	rawLen := binary.LittleEndian.Uint64(fixed[4:12])
	hdrOff := end - int64(trailerFixed) - hdrLen
	if rawLen == 0 || hdrLen == 0 || hdrLen > 1<<20 || hdrOff < 0 || rawLen > uint64(hdrOff) {
		return hdr, 0, 0, fmt.Errorf("corrupt SFX trailer (payloadLen=%d hdrLen=%d)", rawLen, hdrLen)
	}
	payloadLen = int64(rawLen)
	payloadOff = hdrOff - payloadLen
	hdrBytes := make([]byte, hdrLen)
	if _, err := f.ReadAt(hdrBytes, hdrOff); err != nil {
		return hdr, 0, 0, err
	}
	if err := json.Unmarshal(hdrBytes, &hdr); err != nil {
		return hdr, 0, 0, fmt.Errorf("SFX header: %w", err)
	}
	if hdr.Binary == "" || hdr.SHA256 == "" || hdr.Arch == "" {
		return hdr, 0, 0, fmt.Errorf("SFX header incomplete")
	}
	if hdr.Format == "" {
		hdr.Format = "zip" // pre-AIOSFX02 headers carried a zip
	}
	return hdr, payloadOff, payloadLen, nil
}

// trailerEnd is the offset just past the magic: the end of the file, or — for
// an Authenticode-signed exe — the start of the certificate table that signing
// appended (after padding the file to 8 bytes).
func trailerEnd(f io.ReaderAt, size int64) (int64, error) {
	if size < int64(trailerFixed) {
		return 0, fmt.Errorf("SFX too small (%d bytes) — not an aio Windows installer", size)
	}
	if magicAt(f, size-int64(len(magic))) {
		return size, nil
	}
	if cert := certTableOffset(f, size); cert > 0 {
		for pad := int64(0); pad < 8; pad++ {
			end := cert - pad
			if end >= int64(trailerFixed) && magicAt(f, end-int64(len(magic))) {
				return end, nil
			}
		}
	}
	return 0, fmt.Errorf("not an aio SFX (missing %s trailer)", magic)
}

func magicAt(f io.ReaderAt, off int64) bool {
	b := make([]byte, len(magic))
	_, err := f.ReadAt(b, off)
	return err == nil && string(b) == magic
}

// certTableOffset reads the PE security directory
// (IMAGE_DIRECTORY_ENTRY_SECURITY) — the one data directory whose address is a
// FILE offset. 0 when the file is unsigned or not a PE.
func certTableOffset(f io.ReaderAt, size int64) int64 {
	u32 := func(off int64) (uint32, bool) {
		b := make([]byte, 4)
		if _, err := f.ReadAt(b, off); err != nil {
			return 0, false
		}
		return binary.LittleEndian.Uint32(b), true
	}
	lfanew, ok := u32(0x3c)
	if !ok {
		return 0
	}
	pe := int64(lfanew)
	if sig, ok := u32(pe); !ok || sig != 0x00004550 { // "PE\0\0"
		return 0
	}
	opt := pe + 4 + 20 // past the signature and the COFF file header
	optMagic, ok := u32(opt)
	if !ok {
		return 0
	}
	var dirs int64
	switch optMagic & 0xffff {
	case 0x20b: // PE32+
		dirs = opt + 112
	case 0x10b: // PE32
		dirs = opt + 96
	default:
		return 0
	}
	const security = 4
	if n, ok := u32(dirs - 4); !ok || n <= security {
		return 0
	}
	off, ok1 := u32(dirs + security*8)
	length, ok2 := u32(dirs + security*8 + 4)
	if !ok1 || !ok2 || off == 0 || length == 0 || int64(off) > size {
		return 0
	}
	return int64(off)
}
