package main

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// buildTarZstd packs name→content pairs (dirs end in "/") into an in-memory
// tar.zstd, the shape `packAppDirTarZstd` writes.
func buildTarZstd(t *testing.T, entries []struct{ name, body string }) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw, err := zstd.NewWriter(&buf, zstd.WithEncoderLevel(zstd.SpeedBestCompression))
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(zw)
	for _, e := range entries {
		if strings.HasSuffix(e.name, "/") {
			if err := tw.WriteHeader(&tar.Header{
				Name:     e.name,
				Typeflag: tar.TypeDir,
				Mode:     0o755,
			}); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := tw.WriteHeader(&tar.Header{
			Name:     e.name,
			Typeflag: tar.TypeReg,
			Mode:     0o644,
			Size:     int64(len(e.body)),
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractTarZstdRoundTrip(t *testing.T) {
	payload := buildTarZstd(t, []struct{ name, body string }{
		{"app.exe", "the inner binary"},
		{"electron/", ""},
		{"electron/electron.exe", "runtime"},
		{"dist/app.js", "console.log(1)"},
	})
	dest := t.TempDir()
	if err := extractTarZstd(bytes.NewReader(payload), dest); err != nil {
		t.Fatalf("extract: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "electron", "electron.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "runtime" {
		t.Fatalf("content = %q", got)
	}
	if _, err := os.Stat(filepath.Join(dest, "dist", "app.js")); err != nil {
		t.Fatalf("nested file missing: %v", err)
	}
}

func TestSafeTargetRefusesEscapes(t *testing.T) {
	dest := t.TempDir()
	for _, name := range []string{"../evil", "a/../../evil", "/abs/evil"} {
		if _, ok := safeTarget(dest, name); ok {
			t.Fatalf("%q must be refused", name)
		}
	}
	if _, ok := safeTarget(dest, "a/b.txt"); !ok {
		t.Fatal("a normal path must be allowed")
	}
}

func TestExtractTarZstdRefusesSlip(t *testing.T) {
	payload := buildTarZstd(t, []struct{ name, body string }{
		{"linked/", ""},
		{"../outside.txt", "nope"},
	})
	if err := extractTarZstd(bytes.NewReader(payload), t.TempDir()); err == nil {
		t.Fatal("a ../ entry must be refused")
	}
}
