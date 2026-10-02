// Installing the extracted tree, built for BOTH the Windows stub and the host
// (so the swap, its undo and its crash recovery are unit-tested with `go test`
// on any machine). The caller holds the install lock.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// stampName is the file that records which payload an install was extracted
// from: the payload's SHA-256, one line. The app's own updater carries it into
// every tree it swaps in (`carrySfxStamp`, src/server/updates-apply.ts), so the
// exe that installed the app stays a plain launcher for the updated tree
// instead of extracting its old payload over it.
const stampName = ".aio-sfx-stamp"

// inUseError: the installed copy could not be moved aside, which on Windows
// means a process is running from it (or holds a file in it). Nothing was
// changed.
type inUseError struct{ err error }

func (e *inUseError) Error() string { return e.err.Error() }

// installed reports whether installDir already holds this payload.
func installed(installDir, sha, binary string) bool {
	prev, err := os.ReadFile(filepath.Join(installDir, stampName))
	return err == nil && strings.EqualFold(strings.TrimSpace(string(prev)), sha) &&
		fileExists(filepath.Join(installDir, binary+".exe")) &&
		fileExists(filepath.Join(installDir, "electron", "electron.exe"))
}

// ensureInstalled leaves a complete, stamped tree of this payload at
// installDir, calling extract(stage) only when one is not there already.
//
// An existing install is moved ASIDE first — the one step that fails while
// the app runs from it, before a byte is written — then the new tree is
// extracted beside it and renamed in, and only then is the old one deleted.
// Any failure puts the old install back, so the worst case is the version
// that was already there.
func ensureInstalled(installDir, sha, binary string, extract func(stage string) error) error {
	stage := installDir + ".incoming"
	old := installDir + ".replaced"
	// A stub killed between moving the old install aside and moving the new
	// one in left no install at the name: put the old one back first.
	if !exists(installDir) && exists(old) {
		if err := os.Rename(old, installDir); err != nil {
			return fmt.Errorf("restore %s: %w", installDir, err)
		}
	}
	if installed(installDir, sha, binary) {
		// A stub killed after renaming the new tree in left the old one (a full
		// copy of the app) or half an extraction beside it. Best effort: the
		// install is good either way.
		_ = os.RemoveAll(stage)
		_ = os.RemoveAll(old)
		return nil
	}
	if err := os.RemoveAll(stage); err != nil {
		return err
	}
	if err := os.RemoveAll(old); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(installDir), 0o755); err != nil {
		return err
	}
	had := exists(installDir)
	if had {
		if err := os.Rename(installDir, old); err != nil {
			return &inUseError{err}
		}
	}
	restore := func(why error) error {
		_ = os.RemoveAll(stage)
		if had {
			if err := os.Rename(old, installDir); err != nil {
				return fmt.Errorf("%w — and the previous install could not be put back (it is at %s): %v", why, old, err)
			}
		}
		return why
	}
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return restore(err)
	}
	if err := extract(stage); err != nil {
		return restore(fmt.Errorf("extract: %w", err))
	}
	if err := os.WriteFile(filepath.Join(stage, stampName), []byte(sha+"\n"), 0o644); err != nil {
		return restore(err)
	}
	if err := os.Rename(stage, installDir); err != nil {
		return restore(fmt.Errorf("install: %w", err))
	}
	// The new install is in place; a leftover old tree is only disk space,
	// and the next launch clears it.
	_ = os.RemoveAll(old)
	return nil
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
