// Payload extraction, built for BOTH the Windows stub and the host (so it can
// be unit-tested with `go test` on any machine). Nothing here uses a
// Windows-only syscall.
package main

import (
	"archive/tar"
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/klauspost/compress/zstd"
)

// safeTarget joins a payload-relative name under dest, refusing absolute paths
// and `..` escapes (zip/tar slip). Returns the target and whether it is safe.
func safeTarget(dest, name string) (string, bool) {
	name = filepath.Clean(filepath.FromSlash(name))
	if name == ".." || strings.HasPrefix(name, ".."+string(os.PathSeparator)) ||
		filepath.IsAbs(name) {
		return "", false
	}
	target := filepath.Join(dest, name)
	if !strings.HasPrefix(target, dest+string(os.PathSeparator)) && target != dest {
		return "", false
	}
	return target, true
}

func extractZip(r io.ReaderAt, size int64, dest string) error {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return err
	}
	dest = filepath.Clean(dest)
	for _, zf := range zr.File {
		target, ok := safeTarget(dest, zf.Name)
		if !ok {
			return fmt.Errorf("refusing unsafe zip entry %q", zf.Name)
		}
		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, zf.Mode())
		if err != nil {
			rc.Close()
			return err
		}
		_, copyErr := io.Copy(out, rc)
		closeErr := out.Close()
		rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

// extractTarZstd streams a zstd-compressed tar into dest. Streaming (not a
// buffer of the whole ~300 MB payload) keeps first launch's memory flat.
func extractTarZstd(r io.Reader, dest string) error {
	zr, err := zstd.NewReader(r)
	if err != nil {
		return err
	}
	defer zr.Close()
	dest = filepath.Clean(dest)
	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		target, ok := safeTarget(dest, hdr.Name)
		if !ok {
			return fmt.Errorf("refusing unsafe tar entry %q", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(hdr.Mode)&0o777)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		default:
			// Symlinks and devices have no place in a Windows AppDir; skip
			// rather than fail — the packer never writes them.
		}
	}
	return nil
}
