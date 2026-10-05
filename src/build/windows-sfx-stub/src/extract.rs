//! Payload extraction, built for BOTH the Windows stub and the host (so it is
//! unit-tested with `cargo test` on any machine).
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver};

use ruzstd::decoding::StreamingDecoder;

/// Joins a payload-relative name under `dest`, refusing absolute paths, drive
/// names and `..` escapes (zip/tar slip). `None` when the name is not safe.
pub fn safe_target(dest: &Path, name: &str) -> Option<PathBuf> {
    let mut parts = Vec::new();
    for c in Path::new(name).components() {
        match c {
            // A `:` is a drive or a stream name on Windows, and `join` would
            // let a drive replace `dest`.
            Component::Normal(p) if p.to_string_lossy().contains(':') => return None,
            Component::Normal(p) => parts.push(p),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::Prefix(_) | Component::RootDir => return None,
        }
    }
    Some(parts.iter().fold(dest.to_path_buf(), |p, c| p.join(c)))
}

fn write_file(target: &Path, from: &mut impl Read) -> Result<(), String> {
    let mut write = || -> io::Result<()> {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create(target)?;
        let mut buf = vec![0u8; 1 << 18];
        loop {
            match from.read(&mut buf)? {
                0 => return out.flush(),
                n => out.write_all(&buf[..n])?,
            }
        }
    };
    write().map_err(|e| format!("{}: {e}", target.display()))
}

pub fn extract_zip<R: Read + Seek>(r: R, dest: &Path) -> Result<(), String> {
    let mut zr = zip::ZipArchive::new(r).map_err(|e| e.to_string())?;
    for i in 0..zr.len() {
        let mut f = zr.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_owned();
        let target = safe_target(dest, &name)
            .ok_or_else(|| format!("refusing unsafe zip entry {name:?}"))?;
        if f.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        // A symlink entry would be written as a file holding the link's target.
        const S_IFMT: u32 = 0o170000;
        const S_IFREG: u32 = 0o100000;
        if let Some(mode) = f.unix_mode().filter(|m| !matches!(m & S_IFMT, 0 | S_IFREG)) {
            return Err(format!("unsupported zip entry {name:?} (mode {mode:o})"));
        }
        write_file(&target, &mut f)?;
    }
    Ok(())
}

/// Streams a zstd-compressed tar into `dest`. Streaming (not a buffer of the
/// whole ~300 MB payload) keeps first launch's memory flat. The payload is
/// decoded on a thread of its own, a few chunks ahead of the files being
/// written, so decoding and the disk do not wait for each other.
pub fn extract_tar_zstd<R: Read + Send>(r: R, dest: &Path) -> Result<(), String> {
    const CHUNK: usize = 1 << 20;
    std::thread::scope(|scope| {
        let (tx, rx) = sync_channel::<io::Result<Vec<u8>>>(16);
        scope.spawn(move || {
            let mut frames = Frames::new(BufReader::with_capacity(1 << 16, r));
            loop {
                let mut chunk = Vec::with_capacity(CHUNK);
                let read = (&mut frames).take(CHUNK as u64).read_to_end(&mut chunk);
                let last = !matches!(read, Ok(n) if n > 0);
                // A send fails when the extraction has already stopped.
                if tx.send(read.map(|_| chunk)).is_err() || last {
                    return;
                }
            }
        });
        untar(
            Chunks {
                rx,
                chunk: Vec::new(),
                at: 0,
            },
            dest,
        )
    })
}

fn untar(r: impl Read, dest: &Path) -> Result<(), String> {
    let mut ar = tar::Archive::new(r);
    for entry in ar.entries().map_err(|e| e.to_string())? {
        let mut e = entry.map_err(|e| e.to_string())?;
        let name = String::from_utf8_lossy(&e.path_bytes()).into_owned();
        let target = safe_target(dest, &name)
            .ok_or_else(|| format!("refusing unsafe tar entry {name:?}"))?;
        match e.header().entry_type() {
            tar::EntryType::Directory => fs::create_dir_all(&target).map_err(|e| e.to_string())?,
            tar::EntryType::Regular => write_file(&target, &mut e)?,
            // A symlink, device or any other entry: the packer never writes
            // one (a Windows AppDir has none), so this payload is not ours to
            // guess at — skipping it would install an app with a file missing.
            t => return Err(format!("unsupported tar entry {name:?} (type {t:?})")),
        }
    }
    // What follows the archive's end marker is decoded too, so a payload cut
    // short inside its last frame is an error, not a shorter install.
    io::copy(&mut ar.into_inner(), &mut io::sink()).map_err(|e| e.to_string())?;
    Ok(())
}

/// The decoded payload, as the chunks the decoding thread sends.
struct Chunks {
    rx: Receiver<io::Result<Vec<u8>>>,
    chunk: Vec<u8>,
    at: usize,
}

impl Read for Chunks {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.at == self.chunk.len() {
            match self.rx.recv() {
                Ok(next) => (self.chunk, self.at) = (next?, 0),
                Err(_) => return Ok(0), // the decoder is done: its last chunk was empty
            }
        }
        let n = buf.len().min(self.chunk.len() - self.at);
        buf[..n].copy_from_slice(&self.chunk[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

/// Every zstd frame of a source, one after another, as one stream — the
/// decoder itself stops at the end of the first.
struct Frames<R: BufRead> {
    frame: Option<StreamingDecoder<R, ruzstd::decoding::FrameDecoder>>,
    rest: Option<R>,
}

impl<R: BufRead> Frames<R> {
    fn new(src: R) -> Self {
        Frames {
            frame: None,
            rest: Some(src),
        }
    }
}

impl<R: BufRead> Read for Frames<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if let Some(frame) = &mut self.frame {
                let n = frame.read(buf)?;
                if n > 0 || buf.is_empty() {
                    return Ok(n);
                }
                self.rest = self.frame.take().map(StreamingDecoder::into_inner);
            }
            let Some(mut src) = self.rest.take() else {
                return Err(io::Error::other("zstd: the payload could not be decoded"));
            };
            if src.fill_buf()?.is_empty() {
                self.rest = Some(src);
                return Ok(0);
            }
            self.frame = Some(
                StreamingDecoder::new(src).map_err(|e| io::Error::other(format!("zstd: {e}")))?,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("aio-sfx-x-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn zstd(data: &[u8]) -> Vec<u8> {
        ruzstd::encoding::compress_to_vec(data, ruzstd::encoding::CompressionLevel::Fastest)
    }

    /// Packs name→content pairs (dirs end in "/") into a tar, the shape
    /// `packAppDirTarZstd` writes. The name goes into the header as given.
    fn tar_of(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, body) in entries {
            let mut h = tar::Header::new_ustar();
            h.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
            let dir = name.ends_with('/');
            h.set_entry_type(if dir {
                tar::EntryType::Directory
            } else {
                tar::EntryType::Regular
            });
            h.set_mode(if dir { 0o755 } else { 0o644 });
            h.set_size(body.len() as u64);
            h.set_cksum();
            out.extend_from_slice(h.as_bytes());
            out.extend_from_slice(body.as_bytes());
            out.resize(out.len().next_multiple_of(512), 0);
        }
        out.resize(out.len() + 1024, 0);
        out
    }

    const APP: &[(&str, &str)] = &[
        ("app.exe", "the inner binary"),
        ("electron/", ""),
        ("electron/electron.exe", "runtime"),
        ("dist/app.js", "console.log(1)"),
    ];

    #[test]
    fn tar_zstd_round_trip() {
        let t = Tmp::new("rt");
        extract_tar_zstd(Cursor::new(zstd(&tar_of(APP))), &t.0).unwrap();
        assert_eq!(
            fs::read_to_string(t.0.join("electron/electron.exe")).unwrap(),
            "runtime"
        );
        assert_eq!(
            fs::read_to_string(t.0.join("dist/app.js")).unwrap(),
            "console.log(1)"
        );
    }

    /// A payload of several zstd frames is one archive: stopping at the end of
    /// the first frame would install part of the app and call it done.
    #[test]
    fn tar_zstd_reads_every_frame() {
        let t = Tmp::new("frames");
        let tar = tar_of(APP);
        let (a, b) = tar.split_at(700);
        extract_tar_zstd(Cursor::new([zstd(a), zstd(b)].concat()), &t.0).unwrap();
        assert_eq!(
            fs::read_to_string(t.0.join("dist/app.js")).unwrap(),
            "console.log(1)"
        );
    }

    #[test]
    fn tar_zstd_refuses_a_cut_payload() {
        let t = Tmp::new("cut");
        let z = zstd(&tar_of(APP));
        assert!(extract_tar_zstd(Cursor::new(&z[..z.len() - 3]), &t.0).is_err());
        assert!(extract_tar_zstd(Cursor::new(b"not zstd at all"), &t.0).is_err());
    }

    #[test]
    fn safe_target_refuses_escapes() {
        let dest = Path::new("/dest");
        for name in ["../evil", "a/../../evil", "/abs/evil", "C:evil", "a/C:evil"] {
            assert_eq!(safe_target(dest, name), None, "{name}");
        }
        assert_eq!(
            safe_target(dest, "a/b.txt"),
            Some(dest.join("a").join("b.txt"))
        );
        assert_eq!(safe_target(dest, "a/../b.txt"), Some(dest.join("b.txt")));
        assert_eq!(safe_target(dest, "./"), Some(dest.to_path_buf()));
    }

    #[test]
    fn tar_zstd_refuses_slip() {
        let t = Tmp::new("slip");
        let payload = zstd(&tar_of(&[("linked/", ""), ("../outside.txt", "nope")]));
        let err = extract_tar_zstd(Cursor::new(payload), &t.0.join("in")).unwrap_err();
        assert!(err.contains("refusing unsafe tar entry"), "{err}");
        assert!(!t.0.join("outside.txt").exists());
    }

    /// A symlink (or any entry the packer never writes) must fail the
    /// extraction, never be skipped: skipping installs an app with a file
    /// missing.
    #[test]
    fn tar_zstd_refuses_symlink() {
        let t = Tmp::new("tarlink");
        let mut h = tar::Header::new_ustar();
        h.set_path("link").unwrap();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_link_name("app.exe").unwrap();
        h.set_size(0);
        h.set_cksum();
        let mut tar = h.as_bytes().to_vec();
        tar.resize(tar.len() + 1024, 0);
        let err = extract_tar_zstd(Cursor::new(zstd(&tar)), &t.0).unwrap_err();
        assert!(err.contains("unsupported tar entry"), "{err}");
    }

    fn zip_of(build: impl FnOnce(&mut zip::ZipWriter<Cursor<Vec<u8>>>)) -> Cursor<Vec<u8>> {
        let mut zw = zip::ZipWriter::new(Cursor::new(Vec::new()));
        build(&mut zw);
        Cursor::new(zw.finish().unwrap().into_inner())
    }

    #[test]
    fn zip_round_trip() {
        let t = Tmp::new("zip");
        let deflated = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let body = "runtime ".repeat(4096);
        let z = zip_of(|zw| {
            zw.add_directory("electron/", deflated).unwrap();
            zw.start_file("electron/electron.exe", deflated).unwrap();
            zw.write_all(body.as_bytes()).unwrap();
        });
        extract_zip(z, &t.0).unwrap();
        assert_eq!(
            fs::read_to_string(t.0.join("electron/electron.exe")).unwrap(),
            body
        );
    }

    /// The same rule for the zip payload: a symlink entry would be written as
    /// a file holding the link's target path.
    #[test]
    fn zip_refuses_symlink() {
        let t = Tmp::new("ziplink");
        let opts = zip::write::SimpleFileOptions::default();
        let z = zip_of(|zw| {
            zw.start_file("app.exe", opts).unwrap();
            zw.write_all(b"inner").unwrap();
            zw.add_symlink("link.exe", "app.exe", opts).unwrap();
        });
        let err = extract_zip(z, &t.0).unwrap_err();
        assert!(err.contains(r#"unsupported zip entry "link.exe""#), "{err}");
        assert!(
            fs::symlink_metadata(t.0.join("link.exe")).is_err(),
            "the symlink entry was written"
        );
        // The regular entry before it was extracted as itself.
        assert_eq!(fs::read_to_string(t.0.join("app.exe")).unwrap(), "inner");
    }
}
