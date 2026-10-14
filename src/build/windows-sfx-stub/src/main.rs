//! aio Windows SFX stub — a thin PE that carries a compressed AppDir after
//! itself, extracts it once to %LOCALAPPDATA%, then launches the inner app
//! offline.
//!
//! This is a PREBUILT binary, committed at
//! prebuilt/aio-windows-sfx-stub-amd64.exe, so building the one-click `.exe`
//! needs no compiler. Rebuild it ONLY when this source changes — the exact
//! command, the pinned toolchain and the SHA-256 to update are in README.md.
//!
//! The payload is a zstd-compressed tar of the AppDir, packed in Deno
//! (`packAppDirTarZstd` in ../build-windows-exe.ts); "zip" is the packer's
//! fallback. The trailer is described in format.rs.
#![cfg_attr(windows, windows_subsystem = "windows")]
#![cfg_attr(not(windows), allow(dead_code))]

mod extract;
mod format;
mod install;
mod version;

/// What the FIRST argument asks of the stub. Any other first argument, and
/// every later one, is the app's.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    /// Install if needed, start the app, exit 0 once it is started.
    Open,
    /// `--aio-sfx-install`: install this version over whatever is there — a
    /// newer one too — start nothing, show nothing. The exit code says
    /// whether it did ([`EXIT_IN_USE`]: the app is running); the reason goes
    /// to stderr. How `am upgrade` installs the `.exe` it built.
    Install,
    /// `--aio-sfx-wait`: as `Open`, then wait for the app and exit with its
    /// exit code.
    Wait,
}

/// `--aio-sfx-install` exit code: the app is running, nothing was changed.
const EXIT_IN_USE: i32 = 3;

impl Mode {
    fn of(first: Option<&std::ffi::OsStr>) -> Mode {
        match first.and_then(|a| a.to_str()) {
            Some("--aio-sfx-install") => Mode::Install,
            Some("--aio-sfx-wait") => Mode::Wait,
            _ => Mode::Open,
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("aio SFX: this stub runs on Windows only");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    let mode = Mode::of(std::env::args_os().nth(1).as_deref());
    match win::run(mode) {
        Ok(code) => std::process::exit(code),
        // Nobody is there to press OK on a box when a program asked for the
        // install: the reason is the stderr line, and the exit code.
        Err((code, msg)) if mode == Mode::Install => {
            win::leave_reason(&msg);
            eprintln!("aio SFX: {msg}");
            std::process::exit(code);
        }
        Err((_, msg)) => {
            win::leave_reason(&msg);
            win::show_error(&msg);
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Mode;
    use std::ffi::OsStr;

    #[test]
    fn only_the_exact_first_argument_is_the_stubs() {
        let of = |a: &str| Mode::of(Some(OsStr::new(a)));
        assert_eq!(of("--aio-sfx-install"), Mode::Install);
        assert_eq!(of("--aio-sfx-wait"), Mode::Wait);
        for app_arg in ["--aio-sfx-install=1", "--AIO-SFX-INSTALL", "--port=1", ""] {
            assert_eq!(of(app_arg), Mode::Open, "{app_arg:?}");
        }
        assert_eq!(Mode::of(None), Mode::Open);
    }
}

#[cfg(windows)]
mod win {
    use crate::extract::{extract_tar_zstd, extract_zip};
    use crate::format::read_trailer;
    use crate::install::{
        beside, ensure_installed, file_exists, newer_installed, InstallError, SHORTCUT_RECORD,
    };
    use crate::{Mode, EXIT_IN_USE};
    use sha2::{Digest, Sha256};
    use std::ffi::c_void;
    use std::fs::File;
    use std::io::{self, Read, Seek, SeekFrom};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attrs: *const c_void, owned: i32, name: *const u16) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, ms: u32) -> u32;
        fn ReleaseMutex(handle: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(owner: *mut c_void, text: *const u16, title: *const u16, kind: u32) -> i32;
        fn GetProcessWindowStation() -> *mut c_void;
        fn GetUserObjectInformationW(
            object: *mut c_void,
            index: i32,
            info: *mut c_void,
            len: u32,
            needed: *mut u32,
        ) -> i32;
    }

    /// Can anybody see a window of this process? Only on the interactive
    /// window station of a logged-on session. A service, a task that runs
    /// "whether the user is logged on or not" and an ssh session are on a
    /// station nobody sees, where a message box waits for an OK that never
    /// comes. When Windows will not say, the answer is yes: a double-click
    /// must keep its box.
    fn has_desktop() -> bool {
        #[repr(C)]
        struct UserObjectFlags {
            inherit: i32,
            reserved: i32,
            flags: u32,
        }
        const UOI_FLAGS: i32 = 1;
        const WSF_VISIBLE: u32 = 1;
        let mut info = UserObjectFlags {
            inherit: 0,
            reserved: 0,
            flags: 0,
        };
        let mut needed = 0u32;
        // SAFETY: the station handle is this process's own (not closed, per
        // the API); `info` is a live USEROBJECTFLAGS of the size passed.
        let known = unsafe {
            let station = GetProcessWindowStation();
            !station.is_null()
                && GetUserObjectInformationW(
                    station,
                    UOI_FLAGS,
                    (&raw mut info).cast(),
                    std::mem::size_of::<UserObjectFlags>() as u32,
                    &mut needed,
                ) != 0
        };
        !known || info.flags & WSF_VISIBLE != 0
    }

    /// How long a launch waits for another one that is extracting. First
    /// extraction of a large app under an antivirus scan takes a while; past
    /// this it says so.
    const LOCK_WAIT_MS: u32 = 10 * 60 * 1000;
    /// Names another wait, in milliseconds — for whoever starts the stub and
    /// would rather be told sooner (and for the test of the message).
    const LOCK_WAIT_ENV: &str = "AIO_SFX_LOCK_WAIT_MS";
    /// Names a file the reason of a failed open is written to. Whoever starts
    /// the stub without reading its stderr — `run.ps1`, which must not hand
    /// the app a pipe — reads why from there. Never the app's: it is taken
    /// out of the environment the app is started with.
    const REASON_FILE_ENV: &str = "AIO_SFX_REASON_FILE";

    /// The reason of a failure, in the file [`REASON_FILE_ENV`] names.
    pub fn leave_reason(msg: &str) {
        let Some(path) = std::env::var_os(REASON_FILE_ENV).filter(|p| !p.is_empty()) else {
            return;
        };
        if let Err(e) = std::fs::write(&path, format!("{msg}\n")) {
            eprintln!("aio SFX: {}: {e}", Path::new(&path).display());
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain([0]).collect()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The payload: `len` bytes of the exe starting at `off`.
    struct Section {
        file: File,
        off: u64,
        len: u64,
        pos: u64,
        /// `pos`, for the progress window's thread.
        seen: Arc<AtomicU64>,
    }

    impl Read for Section {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let left = (self.len - self.pos.min(self.len)).min(buf.len() as u64) as usize;
            self.file.seek(SeekFrom::Start(self.off + self.pos))?;
            let n = self.file.read(&mut buf[..left])?;
            self.pos += n as u64;
            self.seen.store(self.pos, Ordering::Relaxed);
            Ok(n)
        }
    }

    impl Seek for Section {
        fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
            let pos = match to {
                SeekFrom::Start(p) => Some(p),
                SeekFrom::End(d) => self.len.checked_add_signed(d),
                SeekFrom::Current(d) => self.pos.checked_add_signed(d),
            };
            self.pos = pos.ok_or_else(|| io::Error::other("seek before the payload"))?;
            self.seen.store(self.pos, Ordering::Relaxed);
            Ok(self.pos)
        }
    }

    /// The exit code — or, failing, the exit code of `--aio-sfx-install` and
    /// the reason.
    pub fn run(mode: Mode) -> Result<i32, (i32, String)> {
        let fail = |msg: String| (1, msg);
        let this = std::env::current_exe().map_err(|e| fail(format!("locate self: {e}")))?;
        let mut file = File::open(&this).map_err(|e| fail(e.to_string()))?;
        let size = file.metadata().map_err(|e| fail(e.to_string()))?.len();
        let (hdr, off, len) = read_trailer(&mut file, size).map_err(fail)?;
        let seen = Arc::new(AtomicU64::new(0));
        let mut payload = Section {
            file,
            off,
            len,
            pos: 0,
            seen: seen.clone(),
        };

        let mut hash = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            match payload
                .read(&mut buf)
                .map_err(|e| fail(format!("hash payload: {e}")))?
            {
                0 => break,
                n => hash.update(&buf[..n]),
            }
        }
        let got = hex(&hash.finalize());
        if !got.eq_ignore_ascii_case(&hdr.sha256) {
            return Err(fail(format!(
                "payload checksum mismatch (want {} got {got})",
                hdr.sha256
            )));
        }

        let base = std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map_or_else(std::env::temp_dir, PathBuf::from);
        let install_dir = base
            .join("aio-sfx")
            .join(&hdr.binary)
            .join(format!("win-{}", hdr.arch));
        let inner = install_dir.join(format!("{}.exe", hdr.binary));
        let electron = install_dir.join("electron").join("electron.exe");
        let title = if hdr.title.is_empty() {
            &hdr.binary
        } else {
            &hdr.title
        };

        // One launch at a time checks, extracts and stamps: a second
        // double-click during the first extraction waits here, then finds the
        // stamp and only launches.
        let lock = Lock::take(&install_dir, &hdr.binary).map_err(fail)?;
        // Where the Start-menu shortcut of this install is recorded, and
        // whether an install is there to replace (one a killed stub moved
        // aside is put back first).
        let record = beside(&install_dir, SHORTCUT_RECORD);
        let upgrade = install_dir.exists() || beside(&install_dir, ".replaced").exists();
        // Opened over a newer install, this file opens that install. Asked by
        // a program to install its own version, it does — and says so.
        let replaced = (mode == Mode::Install)
            .then(|| newer_installed(&install_dir, &hdr.binary, &hdr.version))
            .flatten();
        let done = ensure_installed(
            &install_dir,
            &hdr.sha256,
            &hdr.binary,
            &hdr.version,
            mode == Mode::Install,
            |stage| {
                payload
                    .seek(SeekFrom::Start(0))
                    .map_err(|e| e.to_string())?;
                // Minutes, for a large app under an antivirus scan: whoever
                // opened the file sees that it is working. The window closes
                // when this returns, so an error box is never under it.
                let _window = (mode != Mode::Install && has_desktop())
                    .then(|| progress::show(title, seen, len));
                match hdr.format.as_str() {
                    "tar.zstd" => extract_tar_zstd(&mut payload, stage),
                    "zip" => extract_zip(&mut payload, stage),
                    other => Err(format!("unknown payload format {other:?}")),
                }
            },
        );
        drop(lock);
        let extracted = match done {
            Ok(extracted) => extracted,
            Err(InstallError::InUse(e)) => {
                return Err((
                    EXIT_IN_USE,
                    format!(
                        "{0} is running, so this version cannot be installed over it.\n\n\
                         Close {0}, then open this file again. Nothing was changed.\n\n({e})",
                        hdr.binary
                    ),
                ))
            }
            Err(InstallError::Other(msg)) => return Err(fail(msg)),
        };

        if !file_exists(&inner) {
            return Err(fail(format!("inner app missing: {}", inner.display())));
        }
        // A way to open the app that is not this download: once it is there
        // the exe can be deleted. Made when the app is installed, not at every
        // open, so a shortcut the user removed stays removed — and not when
        // this install replaced one whose shortcut is on record: an upgrade
        // does not put a removed one back either.
        if extracted && hdr.shortcut && !(upgrade && file_exists(&record)) {
            match shortcut::add(title, &inner, &install_dir) {
                // The app's own record (`SFX_SHORTCUT_RECORD`,
                // ../../server/sfx-shortcut.ts): the shortcut's path. Not
                // written, the next install only adds the shortcut again.
                Ok(lnk) => {
                    if let Err(e) = std::fs::write(&record, format!("{lnk}\n")) {
                        eprintln!("aio SFX: {}: {e}", record.display());
                    }
                }
                // Said where every failure of this file is said: the app is
                // installed and opens, but only from this download.
                Err(e) if mode == Mode::Install => {
                    eprintln!("aio SFX: no Start-menu shortcut: {e}");
                }
                Err(e) => show_error(&format!(
                    "{title} is installed and opens now, but it has no Start-menu shortcut \
                     ({e}).\n\nKeep this file to open {title} again."
                )),
            }
        }
        if mode == Mode::Install {
            if let Some(theirs) = replaced {
                eprintln!(
                    "aio SFX: replaced the newer {} {theirs} with {}",
                    hdr.binary, hdr.version
                );
            }
            return Ok(0);
        }
        let mut app = std::process::Command::new(&inner)
            .args(std::env::args_os().skip(if mode == Mode::Wait { 2 } else { 1 }))
            .current_dir(&install_dir)
            .env("ELECTRON_PATH", &electron)
            .env_remove(REASON_FILE_ENV)
            .env_remove(LOCK_WAIT_ENV)
            .spawn()
            .map_err(|e| fail(format!("launch {}: {e}", inner.display())))?;
        if mode == Mode::Wait {
            let status = app
                .wait()
                .map_err(|e| fail(format!("wait for {}: {e}", inner.display())))?;
            return Ok(status.code().unwrap_or(1));
        }
        // Not waited for: the stub exits; the GUI child keeps running.
        Ok(0)
    }

    /// The named mutex of one install directory, released on drop. The name is
    /// derived from the directory, which is per user, so two users (or two
    /// apps) never wait on each other. A mutex abandoned by a stub that died
    /// is acquired like a free one — `ensure_installed` repairs what that stub
    /// left. A Windows mutex belongs to the thread that waited for it: it is
    /// taken and released on the main thread (extraction has a second one).
    struct Lock(*mut c_void);

    impl Lock {
        fn take(install_dir: &Path, binary: &str) -> Result<Lock, String> {
            let lower: String = install_dir
                .to_string_lossy()
                .chars()
                .flat_map(char::to_lowercase)
                .collect();
            let name = wide(&format!(
                "Global\\aio-sfx-{}",
                hex(&Sha256::digest(lower.as_bytes())[..16])
            ));
            // SAFETY: `name` is a NUL-terminated UTF-16 buffer that outlives the call.
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
            if handle.is_null() {
                return Err(format!("install lock: {}", io::Error::last_os_error()));
            }
            const WAIT_OBJECT_0: u32 = 0;
            const WAIT_ABANDONED: u32 = 0x80;
            const WAIT_TIMEOUT: u32 = 0x102;
            let wait = std::env::var(LOCK_WAIT_ENV)
                .ok()
                .and_then(|ms| ms.parse().ok())
                .unwrap_or(LOCK_WAIT_MS);
            // SAFETY: `handle` is the live mutex handle created above.
            match unsafe { WaitForSingleObject(handle, wait) } {
                WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Lock(handle)),
                waited => {
                    let os = io::Error::last_os_error();
                    // SAFETY: the handle is live and not used again.
                    unsafe { CloseHandle(handle) };
                    Err(if waited == WAIT_TIMEOUT {
                        format!(
                            "another copy of this file is still installing {binary} — try again in a moment"
                        )
                    } else {
                        format!("install lock: {os}")
                    })
                }
            }
        }
    }

    impl Drop for Lock {
        fn drop(&mut self) {
            // Not fatal — the lock goes when this process exits — but a launch
            // waiting on it waits that long, so it is said.
            // SAFETY: the handle is the live mutex this thread owns.
            unsafe {
                if ReleaseMutex(self.0) == 0 {
                    eprintln!(
                        "aio SFX: install lock not released: {}",
                        io::Error::last_os_error()
                    );
                }
                CloseHandle(self.0);
            }
        }
    }

    /// What the two shell objects used here share: COM itself, and calling a
    /// method by its slot in the interface's table.
    mod com {
        use std::ffi::c_void;

        #[repr(C)]
        pub struct Guid(pub u32, pub u16, pub u16, pub [u8; 8]);

        #[link(name = "ole32")]
        extern "system" {
            pub fn CoInitializeEx(reserved: *mut c_void, model: u32) -> i32;
            pub fn CoUninitialize();
            pub fn CoCreateInstance(
                class: *const Guid,
                outer: *mut c_void,
                context: u32,
                interface: *const Guid,
                out: *mut *mut c_void,
            ) -> i32;
        }
        pub const APARTMENT_THREADED: u32 = 2;
        pub const INPROC_SERVER: u32 = 1;
        /// IUnknown's third slot.
        pub const RELEASE: usize = 2;
        pub type Release = unsafe extern "system" fn(*mut c_void) -> u32;

        /// The function in slot `slot` of the COM object `this`.
        ///
        /// SAFETY: `this` must be a live COM interface pointer whose table has
        /// that slot, and `F` the slot's real signature.
        pub unsafe fn method<F: Copy>(this: *mut c_void, slot: usize) -> F {
            let table = *(this as *const *const *const c_void);
            std::mem::transmute_copy(&*table.add(slot))
        }
    }

    /// The window an extraction shows, through the shell's own
    /// `IProgressDialog` — which draws and runs the window on a thread of its
    /// own, so the stub has no window code. Best effort throughout: an install
    /// never fails for the lack of a progress bar.
    mod progress {
        use super::com::*;
        use super::wide;
        use std::ffi::c_void;
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        use std::sync::Arc;
        use std::thread::JoinHandle;
        use std::time::Duration;

        const NODE: [u8; 6] = [0x00, 0x60, 0x97, 0xDF, 0x5B, 0xD4];
        const fn guid(a: u32, b: u16, c: u16, d: [u8; 2]) -> Guid {
            let n = NODE;
            Guid(a, b, c, [d[0], d[1], n[0], n[1], n[2], n[3], n[4], n[5]])
        }
        const CLSID_PROGRESS_DIALOG: Guid = guid(0xF838_3852, 0xFCD3, 0x11D1, [0xA6, 0xB9]);
        const IID_PROGRESS_DIALOG: Guid = guid(0xEBBC_7C04, 0x315E, 0x11D2, [0xB6, 0x2F]);

        // Slots of IProgressDialog's method table (shlobj_core.h), after
        // IUnknown's three.
        const START: usize = 3;
        const STOP: usize = 4;
        const SET_TITLE: usize = 5;
        const SET_PROGRESS64: usize = 9;
        const SET_LINE: usize = 10;
        /// PROGDLG_AUTOTIME | PROGDLG_NOCANCEL: the time left is shown, and
        /// there is no Cancel button — half an install is not a state to offer.
        const FLAGS: u32 = 0x02 | 0x40;

        /// Closes the window when dropped.
        pub struct Window {
            done: Arc<AtomicBool>,
            thread: Option<JoinHandle<()>>,
        }

        impl Drop for Window {
            fn drop(&mut self) {
                self.done.store(true, Ordering::Relaxed);
                if let Some(thread) = self.thread.take() {
                    let _ = thread.join();
                }
            }
        }

        /// Shows "Installing `title`…" with a bar at `seen` of `total`, read
        /// ten times a second until the returned window is dropped.
        pub fn show(title: &str, seen: Arc<AtomicU64>, total: u64) -> Window {
            let done = Arc::new(AtomicBool::new(false));
            let stop = done.clone();
            let (title, line) = (wide(title), wide(&format!("Installing {title}…")));
            type Start = unsafe extern "system" fn(
                *mut c_void,
                *mut c_void,
                *mut c_void,
                u32,
                *const c_void,
            ) -> i32;
            type Stop = unsafe extern "system" fn(*mut c_void) -> i32;
            type SetTitle = unsafe extern "system" fn(*mut c_void, *const u16) -> i32;
            type SetProgress64 = unsafe extern "system" fn(*mut c_void, u64, u64) -> i32;
            type SetLine =
                unsafe extern "system" fn(*mut c_void, u32, *const u16, i32, *const c_void) -> i32;
            // SAFETY: the dialog is created, used and released on this one
            // thread, between CoInitializeEx and CoUninitialize; the wide
            // strings are NUL-terminated and live as long as the thread.
            let thread = std::thread::spawn(move || unsafe {
                if CoInitializeEx(std::ptr::null_mut(), APARTMENT_THREADED) < 0 {
                    return;
                }
                let mut dlg = std::ptr::null_mut();
                if CoCreateInstance(
                    &CLSID_PROGRESS_DIALOG,
                    std::ptr::null_mut(),
                    INPROC_SERVER,
                    &IID_PROGRESS_DIALOG,
                    &mut dlg,
                ) >= 0
                {
                    let null = std::ptr::null_mut();
                    method::<SetTitle>(dlg, SET_TITLE)(dlg, title.as_ptr());
                    method::<SetLine>(dlg, SET_LINE)(dlg, 1, line.as_ptr(), 0, std::ptr::null());
                    if method::<Start>(dlg, START)(dlg, null, null, FLAGS, std::ptr::null()) >= 0 {
                        while !stop.load(Ordering::Relaxed) {
                            let at = seen.load(Ordering::Relaxed).min(total);
                            method::<SetProgress64>(dlg, SET_PROGRESS64)(dlg, at, total);
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        method::<Stop>(dlg, STOP)(dlg);
                    }
                    method::<Release>(dlg, RELEASE)(dlg);
                }
                CoUninitialize();
            });
            Window {
                done,
                thread: Some(thread),
            }
        }
    }

    /// The Start-menu shortcut, through the shell's own `IShellLinkW` — the
    /// one way to write a `.lnk` that Windows itself defines.
    mod shortcut {
        use super::com::*;
        use super::wide;
        use std::ffi::c_void;
        use std::os::windows::ffi::OsStrExt;
        use std::path::Path;

        const TAIL: [u8; 8] = [0xC0, 0, 0, 0, 0, 0, 0, 0x46];
        const CLSID_SHELL_LINK: Guid = Guid(0x0002_1401, 0, 0, TAIL);
        const IID_SHELL_LINK_W: Guid = Guid(0x0002_14F9, 0, 0, TAIL);
        const IID_PERSIST_FILE: Guid = Guid(0x0000_010B, 0, 0, TAIL);

        // Slots of the two COM interfaces' method tables (shobjidl_core.h,
        // objidl.h), after IUnknown's QueryInterface, AddRef, Release.
        const QUERY_INTERFACE: usize = 0;
        const SET_WORKING_DIRECTORY: usize = 9; // IShellLinkW
        const SET_PATH: usize = 20; // IShellLinkW
        const SAVE: usize = 6; // IPersistFile

        fn check(what: &str, hresult: i32) -> Result<(), String> {
            if hresult >= 0 {
                Ok(())
            } else {
                Err(format!("{what} failed (0x{hresult:08X})"))
            }
        }

        pub fn add(title: &str, target: &Path, working_dir: &Path) -> Result<String, String> {
            let programs = std::env::var_os("APPDATA")
                .filter(|v| !v.is_empty())
                .map(|appdata| Path::new(&appdata).join(r"Microsoft\Windows\Start Menu\Programs"))
                .ok_or("APPDATA is not set")?;
            let name = crate::format::shortcut_file_name(title);
            if name.is_empty() {
                return Err(format!("{title:?} is not a file name"));
            }
            std::fs::create_dir_all(&programs).map_err(|e| e.to_string())?;
            let path = |p: &Path| p.as_os_str().encode_wide().chain([0]).collect::<Vec<u16>>();
            let at = format!("{}\\{name}.lnk", programs.display());
            let (lnk, target, dir) = (wide(&at), path(target), path(working_dir));
            type Set = unsafe extern "system" fn(*mut c_void, *const u16) -> i32;
            type Query =
                unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32;
            type Save = unsafe extern "system" fn(*mut c_void, *const u16, i32) -> i32;
            // SAFETY: every pointer handed to COM is a live local, the wide
            // strings are NUL-terminated and outlive the calls, and each
            // interface pointer is used only between the call that returned
            // it and its Release.
            unsafe {
                check(
                    "CoInitializeEx",
                    CoInitializeEx(std::ptr::null_mut(), APARTMENT_THREADED),
                )?;
                let made = (|| {
                    let mut link = std::ptr::null_mut();
                    check(
                        "CoCreateInstance",
                        CoCreateInstance(
                            &CLSID_SHELL_LINK,
                            std::ptr::null_mut(),
                            INPROC_SERVER,
                            &IID_SHELL_LINK_W,
                            &mut link,
                        ),
                    )?;
                    let saved = (|| {
                        check(
                            "SetPath",
                            method::<Set>(link, SET_PATH)(link, target.as_ptr()),
                        )?;
                        check(
                            "SetWorkingDirectory",
                            method::<Set>(link, SET_WORKING_DIRECTORY)(link, dir.as_ptr()),
                        )?;
                        let mut file = std::ptr::null_mut();
                        check(
                            "QueryInterface",
                            method::<Query>(link, QUERY_INTERFACE)(
                                link,
                                &IID_PERSIST_FILE,
                                &mut file,
                            ),
                        )?;
                        let saved =
                            check("Save", method::<Save>(file, SAVE)(file, lnk.as_ptr(), 1));
                        method::<Release>(file, RELEASE)(file);
                        saved
                    })();
                    method::<Release>(link, RELEASE)(link);
                    saved
                })();
                CoUninitialize();
                made.map(|()| at)
            }
        }
    }

    pub fn show_error(msg: &str) {
        eprintln!("aio SFX: {msg}");
        // With nobody to press OK the stderr line and the exit code are the
        // whole answer: a box there would hold this process forever.
        if !has_desktop() {
            return;
        }
        // MessageBoxW so a double-click failure is visible without a console.
        const MB_ICONERROR: u32 = 0x10;
        let (text, title) = (wide(msg), wide("aio installer"));
        // SAFETY: both are NUL-terminated UTF-16 buffers that outlive the call.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_ICONERROR,
            )
        };
    }
}
