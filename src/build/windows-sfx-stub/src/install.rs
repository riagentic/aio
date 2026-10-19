//! Installing the extracted tree, built for BOTH the Windows stub and the host
//! (so the swap, its undo and its crash recovery are unit-tested with
//! `cargo test` on any machine). The caller holds the install lock.
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::version::compare_versions;
use std::cmp::Ordering;

/// The file that records which payload an install was extracted from: the
/// payload's SHA-256, one line. The app's own updater carries it into every
/// tree it swaps in (`carrySfxStamp`, src/server/updates-apply.ts), so the exe
/// that installed the app stays a plain launcher for the updated tree instead
/// of extracting its old payload over it.
pub const STAMP_NAME: &str = ".aio-sfx-stamp";

/// The file that records which app VERSION an install holds, one line. The
/// stub writes it when it extracts, and the app rewrites it with its own
/// version at every start (`stampSfxVersion`, src/server/updates-apply.ts) —
/// so after an update it names the updated version. An exe whose payload is
/// OLDER than it opens the install instead of extracting over it: the app's
/// data may already be in the newer version's shape.
pub const VERSION_NAME: &str = ".aio-sfx-version";

/// What the record of an install's Start-menu shortcut is named: the install
/// directory's path plus this (`win-x64.shortcut`) — beside the install, so an
/// update or a reinstall leaves it. The stub writes it when it adds the
/// shortcut; the app writes it for an install whose `.exe` added none
/// (`SFX_SHORTCUT_RECORD`, src/server/sfx-shortcut.ts). One line: the path.
pub const SHORTCUT_RECORD: &str = ".shortcut";

/// The file that lists every file an extraction wrote, one `<size> <path>`
/// line each (`/`-separated, relative to the install). An install whose stamp
/// matches is launched only when every listed file is there at its size — a
/// file deleted or cut short since (a scanner's quarantine, a disk error) gets
/// the app extracted again, not launched broken. The app's updater does NOT
/// carry it (`carrySfxStamp`): a tree it swaps in is not this extraction, so
/// it is checked as before, by the stamp and the two executables.
pub const FILES_NAME: &str = ".aio-sfx-files";

/// What the stub itself writes into an install, so never in the list: the
/// app rewrites the version at every start.
const OWN_FILES: [&str; 3] = [STAMP_NAME, VERSION_NAME, FILES_NAME];

#[derive(Debug)]
pub enum InstallError {
    /// The installed copy could not be moved aside, which on Windows means a
    /// process is running from it (or holds a file in it). Nothing was changed.
    InUse(io::Error),
    Other(String),
}

impl From<io::Error> for InstallError {
    fn from(e: io::Error) -> Self {
        InstallError::Other(e.to_string())
    }
}

/// Whether `install_dir` already holds this payload.
pub fn installed(install_dir: &Path, sha: &str, binary: &str) -> bool {
    fs::read_to_string(install_dir.join(STAMP_NAME))
        .is_ok_and(|prev| prev.trim().eq_ignore_ascii_case(sha))
        && complete(install_dir, binary)
        && files_intact(install_dir)
}

/// Every file [`FILES_NAME`] lists is there at its size. True when there is
/// no list (an older stub's install, or one the updater swapped in); false
/// when it cannot be read or parsed — that is no proof the install is whole.
fn files_intact(install_dir: &Path) -> bool {
    let list = match fs::read_to_string(install_dir.join(FILES_NAME)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return true,
        Err(_) => return false,
        Ok(list) => list,
    };
    list.lines().all(|line| {
        let Some((size, rel)) = line.split_once(' ') else {
            return false;
        };
        let path = rel
            .split('/')
            .fold(install_dir.to_path_buf(), |p, c| p.join(c));
        size.parse::<u64>()
            .is_ok_and(|size| fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == size))
    })
}

/// Writes [`FILES_NAME`] for the tree at `stage`: every regular file in it,
/// sorted by path, except the stub's own.
fn write_files_list(stage: &Path) -> io::Result<()> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, u64)>) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| {
                io::Error::other(format!("{}: not a UTF-8 name", entry.path().display()))
            })?;
            let path = if rel.is_empty() {
                name.to_owned()
            } else {
                format!("{rel}/{name}")
            };
            let meta = entry.metadata()?;
            if meta.is_dir() {
                walk(&entry.path(), &path, out)?;
            } else if !(rel.is_empty() && OWN_FILES.contains(&name)) {
                out.push((path, meta.len()));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(stage, "", &mut files)?;
    files.sort();
    let list: String = files
        .iter()
        .map(|(path, size)| format!("{size} {path}\n"))
        .collect();
    fs::write(stage.join(FILES_NAME), list)
}

/// The marker a shared-runtime package carries where a bundled one has
/// `electron\` (`SHARED_RUNTIME_MARKER`, ../../../electron/shared-runtime.ts):
/// its Electron is in the per-user store, not in the install.
const SHARED_RUNTIME_MARKER: &str = "electron-shared.json";

fn complete(install_dir: &Path, binary: &str) -> bool {
    file_exists(&install_dir.join(format!("{binary}.exe")))
        && (file_exists(&install_dir.join("electron").join("electron.exe"))
            || file_exists(&install_dir.join(SHARED_RUNTIME_MARKER)))
}

/// The version of the complete install at `install_dir` when it is NEWER than
/// `version`. None whenever that cannot be said for certain: no version on
/// either side, or one that cannot be ordered.
pub fn newer_installed(install_dir: &Path, binary: &str, version: &str) -> Option<String> {
    let theirs = fs::read_to_string(install_dir.join(VERSION_NAME)).ok()?;
    let theirs = theirs.trim();
    (compare_versions(theirs, version) == Some(Ordering::Greater) && complete(install_dir, binary))
        .then(|| theirs.to_owned())
}

/// Leaves a complete, stamped tree of this payload at `install_dir`, calling
/// `extract(stage)` only when one is not there already — and not when the
/// install is a NEWER version than this payload's (`version`; empty when the
/// payload names none), unless `replace_newer` asks for this payload whatever
/// is there. `Ok(true)` when it extracted.
///
/// An existing install is moved ASIDE first — the one step that fails while
/// the app runs from it, before a byte is written — then the new tree is
/// extracted beside it and renamed in, and only then is the old one deleted.
/// Any failure puts the old install back, so the worst case is the version
/// that was already there.
pub fn ensure_installed(
    install_dir: &Path,
    sha: &str,
    binary: &str,
    version: &str,
    replace_newer: bool,
    extract: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<bool, InstallError> {
    let stage = beside(install_dir, ".incoming");
    let old = beside(install_dir, ".replaced");
    // A stub killed between moving the old install aside and moving the new
    // one in left no install at the name: put the old one back first.
    if !exists(install_dir) && exists(&old) {
        rename(&old, install_dir)
            .map_err(|e| InstallError::Other(format!("restore {}: {e}", install_dir.display())))?;
    }
    // The stamp says which payload was EXTRACTED here, and the app's updater
    // carries it into every tree it swaps in: an install that has since
    // updated itself holds this stamp and a newer version.
    let newer = newer_installed(install_dir, binary, version).is_some();
    let present = installed(install_dir, sha, binary);
    let keep = if replace_newer {
        present && !newer
    } else {
        present || newer
    };
    if keep {
        // A stub killed after renaming the new tree in left the old one (a full
        // copy of the app) or half an extraction beside it. Best effort: the
        // install is good either way.
        let _ = remove_all(&stage);
        let _ = remove_all(&old);
        return Ok(false);
    }
    remove_all(&stage)?;
    remove_all(&old)?;
    if let Some(parent) = install_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    let had = exists(install_dir);
    if had {
        move_aside(install_dir, &old).map_err(InstallError::InUse)?;
    }
    let restore = |why: String| {
        let _ = remove_all(&stage);
        if had {
            if let Err(e) = rename(&old, install_dir) {
                return InstallError::Other(format!(
                    "{why} — and the previous install could not be put back (it is at {}): {e}",
                    old.display()
                ));
            }
        }
        InstallError::Other(why)
    };
    fs::create_dir_all(&stage).map_err(|e| restore(e.to_string()))?;
    extract(&stage).map_err(|e| restore(format!("extract: {e}")))?;
    write_files_list(&stage).map_err(|e| restore(format!("list the extracted files: {e}")))?;
    fs::write(stage.join(STAMP_NAME), format!("{sha}\n")).map_err(|e| restore(e.to_string()))?;
    if !version.is_empty() {
        fs::write(stage.join(VERSION_NAME), format!("{version}\n"))
            .map_err(|e| restore(e.to_string()))?;
    }
    rename(&stage, install_dir).map_err(|e| restore(format!("install: {e}")))?;
    // The new install is in place; a leftover old tree is only disk space,
    // and the next launch clears it.
    let _ = remove_all(&old);
    Ok(true)
}

/// How long the move aside is tried for. A file in the install held for a
/// moment — by a virus scanner reading what was just extracted, by an app that
/// is on its way out — refuses the move exactly as a running app does. The
/// app that really runs is still refused, this much later.
const ASIDE_WAIT: Duration = Duration::from_secs(3);

/// `rename(install, old)`, tried again every 100 ms for [`ASIDE_WAIT`].
fn move_aside(install_dir: &Path, old: &Path) -> io::Result<()> {
    let started = Instant::now();
    loop {
        match rename(install_dir, old) {
            Err(_) if started.elapsed() < ASIDE_WAIT => {
                std::thread::sleep(Duration::from_millis(100));
            }
            done => return done,
        }
    }
}

/// `<path><suffix>` — a sibling of the install, on the same volume.
pub fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut s = OsString::from(path);
    s.push(suffix);
    s.into()
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

pub fn file_exists(p: &Path) -> bool {
    fs::metadata(p).is_ok_and(|m| !m.is_dir())
}

/// Removes a file or a whole tree; one that is not there is not an error.
fn remove_all(p: &Path) -> io::Result<()> {
    match fs::symlink_metadata(p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
    }
}

#[cfg(not(windows))]
fn rename(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

/// `MoveFileExW`, not `fs::rename`: std renames with POSIX semantics where
/// Windows has them, and "the install cannot be moved while the app runs from
/// it" is the refusal the swap is built on.
#[cfg(windows)]
fn rename(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 1;
    let wide = |p: &Path| p.as_os_str().encode_wide().chain([0]).collect::<Vec<u16>>();
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both are NUL-terminated UTF-16 buffers that outlive the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh `<tmp>/<unique>/win-x64` path; the parent is removed on drop.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("aio-sfx-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
        fn install(&self) -> PathBuf {
            self.0.join("win-x64")
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Writes the two files `installed` looks for, plus a version marker.
    fn tree(ver: &str) -> impl FnOnce(&Path) -> Result<(), String> + '_ {
        move |stage| {
            fs::create_dir_all(stage.join("electron")).map_err(|e| e.to_string())?;
            for (name, body) in [
                ("myapp.exe", "inner"),
                ("electron/electron.exe", "runtime"),
                ("version.txt", ver),
            ] {
                fs::write(stage.join(name), body).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }

    /// A shared-runtime payload: the app and the marker, no `electron\`.
    fn shared_tree(ver: &str) -> impl FnOnce(&Path) -> Result<(), String> + '_ {
        move |stage| {
            for (name, body) in [
                ("myapp.exe", "inner"),
                (SHARED_RUNTIME_MARKER, "{\"runtime\":\"shared\"}"),
                ("version.txt", ver),
            ] {
                fs::write(stage.join(name), body).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }

    fn never(what: &'static str) -> impl FnOnce(&Path) -> Result<(), String> {
        move |_| panic!("{what}")
    }

    fn read(p: PathBuf) -> String {
        fs::read_to_string(p).unwrap()
    }

    /// Only the install may be left beside its parent: no stage, no set-aside copy.
    fn only_install(dir: &Path) {
        let names: Vec<_> = fs::read_dir(dir.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            [dir.file_name().unwrap()],
            "leftovers beside the install"
        );
    }

    #[test]
    fn fresh_then_skip() {
        let t = Tmp::new("fresh");
        let dir = t.install();
        ensure_installed(&dir, "sha1", "myapp", "", false, tree("v1")).unwrap();
        assert_eq!(read(dir.join(STAMP_NAME)), "sha1\n");
        // Second launch: the stamp matches, nothing is extracted.
        ensure_installed(
            &dir,
            "sha1",
            "myapp",
            "",
            false,
            never("a stamped install was extracted again"),
        )
        .unwrap();
        only_install(&dir);
    }

    /// A shared-runtime install has no `electron\` and is complete: a second
    /// launch extracts nothing (it used to re-extract on every double-click,
    /// and fail while the app was running).
    #[test]
    fn shared_runtime_install_is_complete() {
        let t = Tmp::new("shared");
        let dir = t.install();
        ensure_installed(&dir, "sha1", "myapp", "", false, shared_tree("v1")).unwrap();
        assert!(installed(&dir, "sha1", "myapp"));
        ensure_installed(
            &dir,
            "sha1",
            "myapp",
            "",
            false,
            never("a stamped shared install was extracted again"),
        )
        .unwrap();
        only_install(&dir);
    }

    #[test]
    fn replaces_different_payload() {
        let t = Tmp::new("replace");
        let dir = t.install();
        ensure_installed(&dir, "sha1", "myapp", "", false, tree("v1")).unwrap();
        ensure_installed(&dir, "sha2", "myapp", "", false, tree("v2")).unwrap();
        assert_eq!(read(dir.join("version.txt")), "v2");
        assert_eq!(read(dir.join(STAMP_NAME)), "sha2\n");
        only_install(&dir);
    }

    /// A failed extraction (disk full, corrupt payload) must leave the install
    /// that was there, stamp included.
    #[test]
    fn restores_on_failed_extract() {
        let t = Tmp::new("restore");
        let dir = t.install();
        ensure_installed(&dir, "sha1", "myapp", "", false, tree("v1")).unwrap();
        let err = ensure_installed(&dir, "sha2", "myapp", "", false, |stage| {
            tree("v2")(stage)?;
            Err("disk full".into())
        });
        assert!(
            matches!(err, Err(InstallError::Other(ref m)) if m == "extract: disk full"),
            "{err:?}"
        );
        assert_eq!(read(dir.join("version.txt")), "v1");
        assert!(
            installed(&dir, "sha1", "myapp"),
            "the previous install must be back, intact"
        );
        only_install(&dir);
    }

    /// The install cannot be moved aside (on Windows: the app runs from it).
    /// The stub must report exactly that and delete nothing.
    #[cfg(unix)]
    #[test]
    fn in_use_deletes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let t = Tmp::new("inuse");
        let dir = t.install();
        ensure_installed(&dir, "sha1", "myapp", "", false, tree("v1")).unwrap();
        let chmod = |mode| fs::set_permissions(&t.0, fs::Permissions::from_mode(mode)).unwrap();
        chmod(0o555); // rename inside it now fails
        if fs::write(t.0.join("probe"), "").is_ok() {
            chmod(0o755);
            return; // root ignores directory permissions
        }
        let err = ensure_installed(
            &dir,
            "sha2",
            "myapp",
            "",
            false,
            never("extracted while in use"),
        );
        chmod(0o755);
        assert!(matches!(err, Err(InstallError::InUse(_))), "{err:?}");
        assert_eq!(read(dir.join("version.txt")), "v1");
        assert!(
            installed(&dir, "sha1", "myapp"),
            "the running install must be untouched"
        );
    }

    /// A stub killed after moving the old install aside: the next launch puts
    /// it back and, the stamp matching, extracts nothing.
    #[test]
    fn recovers_set_aside_install() {
        let t = Tmp::new("aside");
        let dir = t.install();
        ensure_installed(&dir, "sha1", "myapp", "", false, tree("v1")).unwrap();
        fs::rename(&dir, beside(&dir, ".replaced")).unwrap();
        fs::create_dir_all(beside(&dir, ".incoming")).unwrap(); // half an extraction
        ensure_installed(
            &dir,
            "sha1",
            "myapp",
            "",
            false,
            never("the set-aside install matches"),
        )
        .unwrap();
        assert!(installed(&dir, "sha1", "myapp"));
        only_install(&dir);
    }

    /// An exe opened over an install of a NEWER version opens it and extracts
    /// nothing; over an older, an equal or an unreadable one it installs.
    #[test]
    fn keeps_a_newer_install() {
        let t = Tmp::new("newer");
        let dir = t.install();
        assert!(ensure_installed(&dir, "sha-a", "myapp", "1.0.0", false, tree("v1")).unwrap());
        assert_eq!(read(dir.join(VERSION_NAME)), "1.0.0\n");
        // The app updated itself and rewrote the version at its next start.
        fs::write(dir.join(VERSION_NAME), "1.2.0-beta\n").unwrap();
        let old = never("an older exe extracted over a newer install");
        assert!(!ensure_installed(&dir, "sha-b", "myapp", "1.1.9", false, old).unwrap());
        assert_eq!(
            read(dir.join(STAMP_NAME)),
            "sha-a\n",
            "the install is untouched"
        );
        only_install(&dir);
        // Asked for by a program (`--aio-sfx-install`), the older one goes in…
        assert_eq!(
            newer_installed(&dir, "myapp", "1.1.9").as_deref(),
            Some("1.2.0-beta")
        );
        assert!(ensure_installed(&dir, "sha-b", "myapp", "1.1.9", true, tree("v0")).unwrap());
        assert_eq!(read(dir.join(VERSION_NAME)), "1.1.9\n");
        assert_eq!(newer_installed(&dir, "myapp", "1.1.9"), None);
        // …also when the newer version came from the app updating itself,
        // which keeps the stamp of the payload it was first extracted from.
        fs::write(dir.join(VERSION_NAME), "1.2.0-beta\n").unwrap();
        let kept = never("the same payload was extracted again");
        assert!(!ensure_installed(&dir, "sha-b", "myapp", "1.1.9", false, kept).unwrap());
        assert!(ensure_installed(&dir, "sha-b", "myapp", "1.1.9", true, tree("v0")).unwrap());
        assert_eq!(read(dir.join(VERSION_NAME)), "1.1.9\n");
        let same = never("the same payload and version was extracted again");
        assert!(!ensure_installed(&dir, "sha-b", "myapp", "1.1.9", true, same).unwrap());
        // …and the app, updated again, is as it was.
        fs::write(dir.join(VERSION_NAME), "1.2.0-beta\n").unwrap();
        // Same version, another build: the exe that is opened wins, as before.
        assert!(ensure_installed(&dir, "sha-c", "myapp", "1.2.0-beta", false, tree("v2")).unwrap());
        assert_eq!(read(dir.join("version.txt")), "v2");
        // A version that cannot be ordered, or none at all, proves nothing.
        for (n, theirs) in ["unknown", ""].iter().enumerate() {
            fs::write(dir.join(VERSION_NAME), theirs).unwrap();
            let sha = format!("sha-u{n}");
            assert!(ensure_installed(&dir, &sha, "myapp", "0.0.1", false, tree("v3")).unwrap());
        }
        fs::remove_file(dir.join(VERSION_NAME)).unwrap();
        assert!(ensure_installed(&dir, "sha-d", "myapp", "", false, tree("v4")).unwrap());
        assert!(!dir.join(VERSION_NAME).exists(), "no version to record");
        // Newer by version but incomplete: not an install to keep.
        fs::write(dir.join(VERSION_NAME), "9.0.0").unwrap();
        fs::remove_file(dir.join("myapp.exe")).unwrap();
        assert!(ensure_installed(&dir, "sha-e", "myapp", "1.0.0", false, tree("v5")).unwrap());
        only_install(&dir);
    }

    /// A file of a stamped install damaged or deleted after the extraction (a
    /// scanner's quarantine, a disk error, a user's cleanup): the stamp still
    /// matches, but the next open extracts again instead of launching a
    /// broken app.
    #[test]
    fn re_extracts_a_damaged_install() {
        let t = Tmp::new("damaged");
        let dir = t.install();
        ensure_installed(&dir, "sha1", "myapp", "", false, tree("v1")).unwrap();
        assert_eq!(
            read(dir.join(FILES_NAME)),
            "7 electron/electron.exe\n5 myapp.exe\n2 version.txt\n"
        );
        // What the app itself writes into its install keeps the fast path:
        // its version at every start, and a file no extraction wrote.
        fs::write(dir.join(VERSION_NAME), "9.9.9\n").unwrap();
        fs::write(dir.join("added-later.log"), "x").unwrap();
        let skip = never("an intact install was extracted again");
        assert!(!ensure_installed(&dir, "sha1", "myapp", "", false, skip).unwrap());
        fs::remove_file(dir.join(VERSION_NAME)).unwrap();
        // A file cut short, then a file gone.
        fs::write(dir.join("version.txt"), "v").unwrap();
        assert!(ensure_installed(&dir, "sha1", "myapp", "", false, tree("v1")).unwrap());
        assert_eq!(read(dir.join("version.txt")), "v1");
        fs::remove_file(dir.join("version.txt")).unwrap();
        assert!(ensure_installed(&dir, "sha1", "myapp", "", false, tree("v1")).unwrap());
        only_install(&dir);
        // A list that cannot be read is no proof the install is whole.
        fs::write(dir.join(FILES_NAME), "garbage").unwrap();
        assert!(ensure_installed(&dir, "sha1", "myapp", "", false, tree("v1")).unwrap());
        // No list — an older stub's install, or a tree the app's updater
        // swapped in (the stamp is carried, the list is not): as before.
        fs::remove_file(dir.join(FILES_NAME)).unwrap();
        fs::write(dir.join("version.txt"), "changed by an update").unwrap();
        let updated = never("an updated install was extracted over");
        assert!(!ensure_installed(&dir, "sha1", "myapp", "", false, updated).unwrap());
    }

    /// A stub killed after renaming the new tree in: the old install (a full
    /// copy of the app) is still beside the good one. The next launch removes it.
    #[test]
    fn clears_leftovers_beside_good_install() {
        let t = Tmp::new("leftover");
        let dir = t.install();
        ensure_installed(&dir, "sha2", "myapp", "", false, tree("v2")).unwrap();
        for left in [".replaced", ".incoming"] {
            tree("v1")(&beside(&dir, left)).unwrap();
        }
        ensure_installed(
            &dir,
            "sha2",
            "myapp",
            "",
            false,
            never("the install matches"),
        )
        .unwrap();
        assert_eq!(read(dir.join("version.txt")), "v2");
        only_install(&dir);
    }
}
