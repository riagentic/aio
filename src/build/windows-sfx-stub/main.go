// aio Windows SFX stub — thin PE that carries a compressed AppDir after
// itself, extracts once to %LOCALAPPDATA%, then launches the inner app
// offline.
//
// This is a PREBUILT binary, committed at
// ../prebuilt/aio-windows-sfx-stub-amd64.exe, so building the one-click `.exe`
// needs no Go toolchain. Rebuild it ONLY when this source changes:
//
//   GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
//     go build -ldflags="-s -w -H windowsgui" \
//     -o ../prebuilt/aio-windows-sfx-stub-amd64.exe .
//
// The payload is a zstd-compressed tar of the AppDir, packed in Deno
// (`packAppDirTarZstd` in ../../build-windows-exe.ts), ~20% smaller than the
// old deflate zip and faster to decompress. "zip" is still accepted for
// artifacts packed before the change.
//
// Trailer layout (end of file):
//   [payload bytes]
//   [JSON header]
//   [u32 LE header length]
//   [u64 LE payload length]
//   [8 magic "AIOSFX02"]
//
//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

func main() {
	if err := run(); err != nil {
		showError(err.Error())
		os.Exit(1)
	}
}

func run() error {
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate self: %w", err)
	}
	self, err = filepath.Abs(self)
	if err != nil {
		return err
	}

	f, err := os.Open(self)
	if err != nil {
		return err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return err
	}
	size := st.Size()
	if size < 8+8+4 {
		return fmt.Errorf("SFX too small (%d bytes) — not an aio Windows installer", size)
	}

	mag := make([]byte, 8)
	if _, err := f.ReadAt(mag, size-8); err != nil {
		return err
	}
	if string(mag) != magic {
		return fmt.Errorf("not an aio SFX (missing %s trailer)", magic)
	}

	var payloadLen uint64
	var hdrLen uint32
	if err := binary.Read(io.NewSectionReader(f, size-8-8, 8), binary.LittleEndian, &payloadLen); err != nil {
		return err
	}
	if err := binary.Read(io.NewSectionReader(f, size-8-8-4, 4), binary.LittleEndian, &hdrLen); err != nil {
		return err
	}
	if payloadLen == 0 || hdrLen == 0 || hdrLen > 1<<20 {
		return fmt.Errorf("corrupt SFX trailer (payloadLen=%d hdrLen=%d)", payloadLen, hdrLen)
	}
	hdrOff := size - 8 - 8 - 4 - int64(hdrLen)
	payloadOff := hdrOff - int64(payloadLen)
	if payloadOff < 0 || hdrOff < 0 {
		return fmt.Errorf("corrupt SFX sizes")
	}

	hdrBytes := make([]byte, hdrLen)
	if _, err := f.ReadAt(hdrBytes, hdrOff); err != nil {
		return err
	}
	var hdr header
	if err := json.Unmarshal(hdrBytes, &hdr); err != nil {
		return fmt.Errorf("SFX header: %w", err)
	}
	if hdr.Binary == "" || hdr.SHA256 == "" || hdr.Arch == "" {
		return fmt.Errorf("SFX header incomplete")
	}
	if hdr.Format == "" {
		hdr.Format = "zip" // pre-AIOSFX02 headers carried a zip
	}

	payload := io.NewSectionReader(f, payloadOff, int64(payloadLen))
	h := sha256.New()
	if _, err := io.Copy(h, payload); err != nil {
		return fmt.Errorf("hash payload: %w", err)
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, hdr.SHA256) {
		return fmt.Errorf("payload checksum mismatch (want %s got %s)", hdr.SHA256, got)
	}

	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	installDir := filepath.Join(base, "aio-sfx", hdr.Binary, "win-"+hdr.Arch)
	stampPath := filepath.Join(installDir, ".aio-sfx-stamp")
	inner := filepath.Join(installDir, hdr.Binary+".exe")
	electron := filepath.Join(installDir, "electron", "electron.exe")

	needExtract := true
	if prev, err := os.ReadFile(stampPath); err == nil &&
		strings.EqualFold(strings.TrimSpace(string(prev)), hdr.SHA256) {
		if fileExists(inner) && fileExists(electron) {
			needExtract = false
		}
	}

	if needExtract {
		stage := installDir + ".incoming"
		_ = os.RemoveAll(stage)
		if err := os.MkdirAll(stage, 0o755); err != nil {
			return err
		}
		payload.Seek(0, io.SeekStart)
		var exErr error
		switch hdr.Format {
		case "tar.zstd":
			exErr = extractTarZstd(payload, stage)
		case "zip":
			exErr = extractZip(payload, int64(payloadLen), stage)
		default:
			exErr = fmt.Errorf("unknown payload format %q", hdr.Format)
		}
		if exErr != nil {
			_ = os.RemoveAll(stage)
			return fmt.Errorf("extract: %w", exErr)
		}
		// Replace install dir atomically-ish: remove old, rename stage.
		_ = os.RemoveAll(installDir)
		if err := os.Rename(stage, installDir); err != nil {
			// Cross-volume fallback
			if err2 := copyDir(stage, installDir); err2 != nil {
				_ = os.RemoveAll(stage)
				return fmt.Errorf("install: %w / %v", err, err2)
			}
			_ = os.RemoveAll(stage)
		}
		if err := os.WriteFile(stampPath, []byte(hdr.SHA256+"\n"), 0o644); err != nil {
			return err
		}
	}

	if !fileExists(inner) {
		return fmt.Errorf("inner app missing: %s", inner)
	}

	cmd := exec.Command(inner, os.Args[1:]...)
	cmd.Dir = installDir
	cmd.Env = append(os.Environ(),
		"ELECTRON_PATH="+electron,
	)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// Start without Wait: the stub exits; the GUI child keeps running.
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch %s: %w", inner, err)
	}
	return nil
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode())
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}

func showError(msg string) {
	fmt.Fprintf(os.Stderr, "aio SFX: %s\n", msg)
	// MessageBoxW so a double-click failure is visible without a console.
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	title, _ := syscall.UTF16PtrFromString("aio installer")
	text, _ := syscall.UTF16PtrFromString(msg)
	proc.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10) // MB_ICONERROR
}
