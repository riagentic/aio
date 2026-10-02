package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// tree writes the two files `installed` looks for, plus a version marker.
func tree(ver string) func(string) error {
	return func(stage string) error {
		if err := os.MkdirAll(filepath.Join(stage, "electron"), 0o755); err != nil {
			return err
		}
		for name, body := range map[string]string{
			"myapp.exe":             "inner",
			"electron/electron.exe": "runtime",
			"version.txt":           ver,
		} {
			if err := os.WriteFile(filepath.Join(stage, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
				return err
			}
		}
		return nil
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Only the install may be left beside its parent: no stage, no set-aside copy.
func onlyInstall(t *testing.T, dir string) {
	t.Helper()
	es, _ := os.ReadDir(filepath.Dir(dir))
	if len(es) != 1 || es[0].Name() != filepath.Base(dir) {
		t.Fatalf("leftovers beside the install: %v", es)
	}
}

func TestEnsureInstalledFreshThenSkip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "win-x64")
	if err := ensureInstalled(dir, "sha1", "myapp", tree("v1")); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dir, stampName)) != "sha1\n" {
		t.Fatal("stamp not written")
	}
	// Second launch: the stamp matches, nothing is extracted.
	err := ensureInstalled(dir, "sha1", "myapp", func(string) error {
		t.Fatal("a stamped install must not be extracted again")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	onlyInstall(t, dir)
}

func TestEnsureInstalledReplacesDifferentPayload(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "win-x64")
	if err := ensureInstalled(dir, "sha1", "myapp", tree("v1")); err != nil {
		t.Fatal(err)
	}
	if err := ensureInstalled(dir, "sha2", "myapp", tree("v2")); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dir, "version.txt")) != "v2" || read(t, filepath.Join(dir, stampName)) != "sha2\n" {
		t.Fatal("the new payload must replace the old install")
	}
	onlyInstall(t, dir)
}

// A failed extraction (disk full, corrupt payload) must leave the install that
// was there, stamp included.
func TestEnsureInstalledRestoresOnFailedExtract(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "win-x64")
	if err := ensureInstalled(dir, "sha1", "myapp", tree("v1")); err != nil {
		t.Fatal(err)
	}
	boom := errors.New("disk full")
	err := ensureInstalled(dir, "sha2", "myapp", func(stage string) error {
		_ = tree("v2")(stage)
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if read(t, filepath.Join(dir, "version.txt")) != "v1" || !installed(dir, "sha1", "myapp") {
		t.Fatal("the previous install must be back, intact")
	}
	onlyInstall(t, dir)
}

// The install cannot be moved aside (on Windows: the app runs from it). The
// stub must report exactly that and delete nothing.
func TestEnsureInstalledInUseDeletesNothing(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	parent := t.TempDir()
	dir := filepath.Join(parent, "win-x64")
	if err := ensureInstalled(dir, "sha1", "myapp", tree("v1")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0o555); err != nil { // rename inside it now fails
		t.Fatal(err)
	}
	defer os.Chmod(parent, 0o755)
	err := ensureInstalled(dir, "sha2", "myapp", func(string) error {
		t.Fatal("nothing may be extracted while the install is in use")
		return nil
	})
	var busy *inUseError
	if !errors.As(err, &busy) {
		t.Fatalf("err = %v, want inUseError", err)
	}
	if read(t, filepath.Join(dir, "version.txt")) != "v1" || !installed(dir, "sha1", "myapp") {
		t.Fatal("the running install must be untouched")
	}
}

// A stub killed after moving the old install aside: the next launch puts it
// back and, the stamp matching, extracts nothing.
func TestEnsureInstalledRecoversSetAsideInstall(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "win-x64")
	if err := ensureInstalled(dir, "sha1", "myapp", tree("v1")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(dir, dir+".replaced"); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir+".incoming", 0o755); err != nil { // half an extraction
		t.Fatal(err)
	}
	err := ensureInstalled(dir, "sha1", "myapp", func(string) error {
		t.Fatal("the set-aside install matches: nothing to extract")
		return nil
	})
	if err != nil || !installed(dir, "sha1", "myapp") {
		t.Fatalf("err=%v", err)
	}
	onlyInstall(t, dir)
}

// A stub killed after renaming the new tree in: the old install (a full copy
// of the app) is still beside the good one. The next launch removes it.
func TestEnsureInstalledClearsLeftoversBesideGoodInstall(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "win-x64")
	if err := ensureInstalled(dir, "sha2", "myapp", tree("v2")); err != nil {
		t.Fatal(err)
	}
	for _, left := range []string{dir + ".replaced", dir + ".incoming"} {
		if err := tree("v1")(left); err != nil {
			t.Fatal(err)
		}
	}
	err := ensureInstalled(dir, "sha2", "myapp", func(string) error {
		t.Fatal("the install matches: nothing to extract")
		return nil
	})
	if err != nil || read(t, filepath.Join(dir, "version.txt")) != "v2" {
		t.Fatalf("err=%v", err)
	}
	onlyInstall(t, dir)
}
