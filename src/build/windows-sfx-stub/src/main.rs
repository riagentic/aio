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

#[cfg(not(windows))]
fn main() {
    eprintln!("aio SFX: this stub runs on Windows only");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    if let Err(msg) = win::run() {
        win::show_error(&msg);
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod win {
    use crate::extract::{extract_tar_zstd, extract_zip};
    use crate::format::read_trailer;
    use crate::install::{ensure_installed, file_exists, InstallError};
    use sha2::{Digest, Sha256};
    use std::ffi::c_void;
    use std::fs::File;
    use std::io::{self, Read, Seek, SeekFrom};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

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
    }

    /// How long a launch waits for another one that is extracting. First
    /// extraction of a large app under an antivirus scan takes a while; past
    /// this it says so.
    const LOCK_WAIT_MS: u32 = 10 * 60 * 1000;

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
    }

    impl Read for Section {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let left = (self.len - self.pos.min(self.len)).min(buf.len() as u64) as usize;
            self.file.seek(SeekFrom::Start(self.off + self.pos))?;
            let n = self.file.read(&mut buf[..left])?;
            self.pos += n as u64;
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
            Ok(self.pos)
        }
    }

    pub fn run() -> Result<(), String> {
        let this = std::env::current_exe().map_err(|e| format!("locate self: {e}"))?;
        let mut file = File::open(&this).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let (hdr, off, len) = read_trailer(&mut file, size)?;
        let mut payload = Section {
            file,
            off,
            len,
            pos: 0,
        };

        let mut hash = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            match payload
                .read(&mut buf)
                .map_err(|e| format!("hash payload: {e}"))?
            {
                0 => break,
                n => hash.update(&buf[..n]),
            }
        }
        let got = hex(&hash.finalize());
        if !got.eq_ignore_ascii_case(&hdr.sha256) {
            return Err(format!(
                "payload checksum mismatch (want {} got {got})",
                hdr.sha256
            ));
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

        // One launch at a time checks, extracts and stamps: a second
        // double-click during the first extraction waits here, then finds the
        // stamp and only launches.
        let lock = Lock::take(&install_dir, &hdr.binary)?;
        let done = ensure_installed(
            &install_dir,
            &hdr.sha256,
            &hdr.binary,
            &hdr.version,
            |stage| {
                payload
                    .seek(SeekFrom::Start(0))
                    .map_err(|e| e.to_string())?;
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
                return Err(format!(
                    "{0} is running, so this version cannot be installed over it.\n\n\
                     Close {0}, then open this file again. Nothing was changed.\n\n({e})",
                    hdr.binary
                ))
            }
            Err(InstallError::Other(msg)) => return Err(msg),
        };

        if !file_exists(&inner) {
            return Err(format!("inner app missing: {}", inner.display()));
        }
        // A way to open the app that is not this download: once it is there
        // the exe can be deleted. Made when the app is installed, not at every
        // open, so a shortcut the user removed stays removed.
        if extracted && hdr.shortcut {
            let title = if hdr.title.is_empty() {
                &hdr.binary
            } else {
                &hdr.title
            };
            if let Err(e) = shortcut::add(title, &inner, &install_dir) {
                eprintln!("aio SFX: no Start-menu shortcut: {e}");
            }
        }
        // Spawn without waiting: the stub exits; the GUI child keeps running.
        std::process::Command::new(&inner)
            .args(std::env::args_os().skip(1))
            .current_dir(&install_dir)
            .env("ELECTRON_PATH", &electron)
            .spawn()
            .map_err(|e| format!("launch {}: {e}", inner.display()))?;
        Ok(())
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
            // SAFETY: `handle` is the live mutex handle created above.
            match unsafe { WaitForSingleObject(handle, LOCK_WAIT_MS) } {
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

    /// The Start-menu shortcut, through the shell's own `IShellLinkW` — the
    /// one way to write a `.lnk` that Windows itself defines.
    mod shortcut {
        use super::wide;
        use std::ffi::c_void;
        use std::os::windows::ffi::OsStrExt;
        use std::path::Path;

        #[repr(C)]
        struct Guid(u32, u16, u16, [u8; 8]);
        const TAIL: [u8; 8] = [0xC0, 0, 0, 0, 0, 0, 0, 0x46];
        const CLSID_SHELL_LINK: Guid = Guid(0x0002_1401, 0, 0, TAIL);
        const IID_SHELL_LINK_W: Guid = Guid(0x0002_14F9, 0, 0, TAIL);
        const IID_PERSIST_FILE: Guid = Guid(0x0000_010B, 0, 0, TAIL);

        #[link(name = "ole32")]
        extern "system" {
            fn CoInitializeEx(reserved: *mut c_void, model: u32) -> i32;
            fn CoUninitialize();
            fn CoCreateInstance(
                class: *const Guid,
                outer: *mut c_void,
                context: u32,
                interface: *const Guid,
                out: *mut *mut c_void,
            ) -> i32;
        }

        // Slots of the two COM interfaces' method tables (shobjidl_core.h,
        // objidl.h), after IUnknown's QueryInterface, AddRef, Release.
        const QUERY_INTERFACE: usize = 0;
        const RELEASE: usize = 2;
        const SET_WORKING_DIRECTORY: usize = 9; // IShellLinkW
        const SET_PATH: usize = 20; // IShellLinkW
        const SAVE: usize = 6; // IPersistFile

        /// The function in slot `slot` of the COM object `this`.
        ///
        /// SAFETY: `this` must be a live COM interface pointer whose table has
        /// that slot, and `F` the slot's real signature.
        unsafe fn method<F: Copy>(this: *mut c_void, slot: usize) -> F {
            let table = *(this as *const *const *const c_void);
            std::mem::transmute_copy(&*table.add(slot))
        }

        fn check(what: &str, hresult: i32) -> Result<(), String> {
            if hresult >= 0 {
                Ok(())
            } else {
                Err(format!("{what} failed (0x{hresult:08X})"))
            }
        }

        pub fn add(title: &str, target: &Path, working_dir: &Path) -> Result<(), String> {
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
            let (lnk, target, dir) = (
                wide(&format!("{}\\{name}.lnk", programs.display())),
                path(target),
                path(working_dir),
            );
            type Set = unsafe extern "system" fn(*mut c_void, *const u16) -> i32;
            type Query =
                unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32;
            type Save = unsafe extern "system" fn(*mut c_void, *const u16, i32) -> i32;
            type Release = unsafe extern "system" fn(*mut c_void) -> u32;
            const APARTMENT_THREADED: u32 = 2;
            const INPROC_SERVER: u32 = 1;
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
                made
            }
        }
    }

    pub fn show_error(msg: &str) {
        eprintln!("aio SFX: {msg}");
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
