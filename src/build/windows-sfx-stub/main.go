// aio Windows SFX stub — thin PE that carries a compressed AppDir after
// itself, extracts once to %LOCALAPPDATA%, then launches the inner app
// offline.
//
// This is a PREBUILT binary, committed at
// prebuilt/aio-windows-sfx-stub-amd64.exe, so building the one-click `.exe`
// needs no Go toolchain. Rebuild it ONLY when this source changes — the exact
// command, the pinned Go version and the SHA-256 to update are in README.md.
//
// The payload is a zstd-compressed tar of the AppDir, packed in Deno
// (`packAppDirTarZstd` in ../build-windows-exe.ts), ~15% smaller than the
// old deflate zip and faster to decompress. "zip" is still accepted for
// artifacts packed before the change. The trailer is described in format.go.
//
//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

// How long a launch waits for another one that is extracting. First extraction
// of a large app under an antivirus scan takes a while; past this it says so.
const lockWaitMs = 10 * 60 * 1000

func main() {
	// A Windows mutex belongs to the THREAD that waited for it, and a goroutine
	// moves between threads (it does during extraction): released from another
	// thread, the install lock stayed held until this process exited.
	runtime.LockOSThread()
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
	hdr, payloadOff, payloadLen, err := readTrailer(f, st.Size())
	if err != nil {
		return err
	}

	payload := io.NewSectionReader(f, payloadOff, payloadLen)
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
	inner := filepath.Join(installDir, hdr.Binary+".exe")
	electron := filepath.Join(installDir, "electron", "electron.exe")

	// One launch at a time checks, extracts and stamps: a second double-click
	// during the first extraction waits here, then finds the stamp and only
	// launches.
	unlock, err := lockInstall(installDir, hdr.Binary)
	if err != nil {
		return err
	}
	err = ensureInstalled(installDir, hdr.SHA256, hdr.Binary, func(stage string) error {
		if _, err := payload.Seek(0, io.SeekStart); err != nil {
			return err
		}
		switch hdr.Format {
		case "tar.zstd":
			return extractTarZstd(payload, stage)
		case "zip":
			return extractZip(payload, payloadLen, stage)
		}
		return fmt.Errorf("unknown payload format %q", hdr.Format)
	})
	unlock()
	var busy *inUseError
	if errors.As(err, &busy) {
		return fmt.Errorf("%s is running, so this version cannot be installed over it.\n\n"+
			"Close %s, then open this file again. Nothing was changed.\n\n(%v)",
			hdr.Binary, hdr.Binary, busy.err)
	}
	if err != nil {
		return err
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

var kernel32 = syscall.NewLazyDLL("kernel32.dll")

// lockInstall takes the named mutex of one install directory and returns its
// release. The name is derived from the directory, which is per user, so two
// users (or two apps) never wait on each other. A mutex abandoned by a stub
// that died is acquired like a free one — ensureInstalled repairs what that
// stub left.
func lockInstall(installDir, binary string) (func(), error) {
	sum := sha256.Sum256([]byte(strings.ToLower(installDir)))
	name, err := syscall.UTF16PtrFromString("Global\\aio-sfx-" + hex.EncodeToString(sum[:16]))
	if err != nil {
		return nil, err
	}
	h, _, callErr := kernel32.NewProc("CreateMutexW").Call(0, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return nil, fmt.Errorf("install lock: %v", callErr)
	}
	const waitObject0, waitAbandoned = 0, 0x80
	r, _, callErr := kernel32.NewProc("WaitForSingleObject").Call(h, lockWaitMs)
	if r != waitObject0 && r != waitAbandoned {
		syscall.CloseHandle(syscall.Handle(h))
		if r == uintptr(syscall.WAIT_TIMEOUT) {
			return nil, fmt.Errorf("another copy of this file is still installing %s — try again in a moment", binary)
		}
		return nil, fmt.Errorf("install lock: %v", callErr)
	}
	return func() {
		// Not fatal — the lock goes when this process exits — but a launch
		// waiting on it waits that long, so it is said.
		if ok, _, callErr := kernel32.NewProc("ReleaseMutex").Call(h); ok == 0 {
			fmt.Fprintf(os.Stderr, "aio SFX: install lock not released: %v\n", callErr)
		}
		syscall.CloseHandle(syscall.Handle(h))
	}, nil
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
