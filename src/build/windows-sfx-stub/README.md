# Windows SFX stub (prebuilt)

`prebuilt/aio-windows-sfx-stub-amd64.exe` is the small PE behind the one-click
Windows `<name>-win-x64.exe`. It reads the payload appended by
`../build-windows-exe.ts`, verifies its SHA-256, extracts it once to
`%LOCALAPPDATA%\aio-sfx\<name>\win-<arch>\`, then launches the inner app with
`ELECTRON_PATH` set. Later launches skip the extract when the stamp matches.

**It is committed prebuilt so that building a one-click `.exe` needs no compiler
on the build host.** `ensureWindowsSfxStub` in `../build-windows-exe.ts` uses
the committed file only when its SHA-256 equals the pinned `SFX_STUB_SHA256`;
any other bytes are refused, loudly. The zstd payload is packed in Deno
(`packAppDirTarZstd`, `@std/tar` + `node:zlib`), so there is no host packer
binary either.

The stub is written in Rust (~0.7 MB). Through 1.0.17-beta it was a Go program
(3.7 MB); the trailer, the install folder, the stamp and the lock name are
unchanged, so an `.exe` built with either stub opens an install the other made.

## What the stub does

1. Finds the trailer: at the end of the file, or — for an Authenticode-signed
   exe — just before the certificate table (PE security directory, up to 7 pad
   bytes).
2. Hashes the payload and compares it with the header.
3. Takes the install's named mutex (waits up to 10 minutes; one abandoned by a
   stub that was killed is taken like a free one), so a second double-click
   during the first extraction waits, then only launches. A Windows mutex
   belongs to the thread that waited for it; the stub takes and releases it on
   its main thread (the payload is decoded on a second one).
4. Stamp (`.aio-sfx-stamp`) equal to the payload hash, and every file the
   extraction listed in `.aio-sfx-files` (`<size> <path>` per line, written when
   it extracts; the updater does not carry it, so a tree it swapped in is
   checked by the stamp and the executables only) there at its size: removes a
   leftover `win-<arch>.replaced` / `win-<arch>.incoming` (a stub that was
   killed) and launches. Otherwise it moves the existing install aside
   (`win-<arch>.replaced` — this is the step that fails while the app is
   running, and then nothing is changed and the message says to close the app;
   it is tried for 3 seconds first, because a virus scanner or an app on its way
   out holds a file of the install for a moment and refuses the move the same
   way), extracts beside it (`win-<arch>.incoming`), stamps, renames the new
   tree in and deletes the old one. Any failure puts the old install back. An
   install of a NEWER version than the payload's is kept as it is: the stub
   writes the payload's version to `.aio-sfx-version` when it extracts, the app
   rewrites it with its own version at every start, and an `.exe` whose version
   is older only opens the install. An old download therefore never puts its
   version over an app that has updated itself.
5. When it extracted, and the header asks for it (`shortcut`), adds a Start-menu
   shortcut to `<name>.exe` named after the app (`title`), so the download can
   be deleted, and records it beside the install (`win-<arch>.shortcut`, the
   shortcut's path). A shortcut the user removed is not put back by a later
   open, nor by an upgrade: an extraction that REPLACES an install whose
   shortcut is on record adds none (one into an empty folder does). A shortcut
   that could not be added fails nothing: it is said on stderr under
   `--aio-sfx-install` and in a message box by a plain open, and nothing is
   recorded. An install made by an `.exe` that added none (aio 1.0.17 or older)
   gets it from the app itself, once, at a start after it updated
   (`../../server/sfx-shortcut.ts`) — under the same file name
   (`shortcut-names.json`).
6. Starts `<name>.exe` with the user's arguments and exits (it does not wait for
   the app, so its exit code is the stub's own).

While it extracts it shows the shell's progress window (`IProgressDialog`),
titled after the app, with no Cancel button.

A failure is said in a message box — and on stderr, with exit code 1. Where
nobody could press OK (the process is not on an interactive window station: a
service, an ssh session, a task that runs whether or not the user is logged on)
there is no box and no progress window: the stderr line and the exit code are
the answer.

The FIRST argument may be the stub's own (it is then not passed to the app; an
older stub passes it on):

- `--aio-sfx-install` — steps 1–5 only: install this version, start nothing,
  show nothing (no progress window, no message box). It replaces a NEWER install
  too, and says so on stderr: a program asked for this version (`am upgrade`
  going back to an older build). Exit 0 when this version is installed, 3 when
  the app is running (nothing changed), 1 for any other failure, with the reason
  on stderr. `run.ps1 -NoRun` (what `am upgrade <name>` runs) uses it, after
  finding the switch's text in the stub bytes of the `.exe` it built.
- `--aio-sfx-wait` — as a plain open, then waits for the app and exits with its
  exit code.

Two environment variables are the stub's own (neither reaches the app; an older
stub ignores both):

- `AIO_SFX_REASON_FILE` — a file path. A stub that fails writes its reason
  there, as well as to stderr and the message box. For a program that starts the
  stub without reading its stderr: `run.ps1` opens the `.exe` with no redirect —
  the app would inherit the pipe and hold whoever reads it — so with no desktop
  it had only the exit code to show.
- `AIO_SFX_LOCK_WAIT_MS` — how long to wait for the install's mutex, in place of
  the 10 minutes.

The app's updater replaces the extracted tree in place and carries the stamp
into the new tree (`carrySfxStamp`, `../../server/updates-apply.ts`), so the
downloaded `.exe` stays a launcher for the updated app.

## Files

| File                                      | Role                                                                |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `src/main.rs`                             | The Windows stub (hash, lock, launch). Windows-only code.           |
| `src/install.rs`                          | The swap: aside, extract, stamp, rename in, undo. Host-tested.      |
| `src/extract.rs`                          | Payload extraction (zstd tar, or zip). Host-tested.                 |
| `src/format.rs`                           | Trailer constants (`AIOSFX02`) and parser. Host-tested.             |
| `src/version.rs`                          | Version order, the updater's (`version-order.json`). Host-tested.   |
| `version-order.json`                      | Version pairs both comparators are tested against.                  |
| `shortcut-names.json`                     | Titles and the shortcut file name each gives, tested on both sides. |
| `Cargo.toml` / `Cargo.lock`               | The crate and its pinned dependencies — for rebuilding only.        |
| `prebuilt/aio-windows-sfx-stub-amd64.exe` | The committed PE the build ships.                                   |
| `THIRD_PARTY_NOTICES`                     | Licenses of what the PE links (Rust, the crates, mingw-w64).        |

The unit tests are in the same files (`cargo test` — runs on any host).

## Rebuild (only when this source changes)

The build is reproducible: the same toolchain and this command give the same
bytes on any machine, from any directory. Pinned:

- **rustc 1.98.0** with the `x86_64-pc-windows-gnu` target
  (`rustup target add x86_64-pc-windows-gnu`). The linker is the `rust-lld` that
  ships with it.
- The crates in `Cargo.lock`.
- The mingw-w64 link libraries of Ubuntu 24.04: **mingw-w64-x86-64-dev
  11.0.1-3build1** and **gcc-mingw-w64-x86-64-win32 13.2.0-6ubuntu1+26.1**
  (`sudo apt install mingw-w64-x86-64-dev gcc-mingw-w64-x86-64-win32`). Only
  their `.a`/`.o` files are read; no mingw program runs. Installed somewhere
  other than `/usr` (the `.deb`s unpacked with `dpkg-deb -x`), set
  `AIO_SFX_MINGW` to that `usr` folder.

From this directory:

```sh
cargo test --locked
MINGW=${AIO_SFX_MINGW:-/usr}
RUSTFLAGS="-Clinker=rust-lld -Clink-self-contained=yes \
  -Clink-arg=--no-insert-timestamp \
  -Lnative=$MINGW/x86_64-w64-mingw32/lib \
  -Lnative=$MINGW/lib/gcc/x86_64-w64-mingw32/13-win32 \
  --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo \
  --remap-path-prefix=$PWD=/stub" \
  cargo build --release --locked --target x86_64-pc-windows-gnu
cp target/x86_64-pc-windows-gnu/release/aio-windows-sfx-stub.exe \
  prebuilt/aio-windows-sfx-stub-amd64.exe
sha256sum prebuilt/aio-windows-sfx-stub-amd64.exe
```

`--remap-path-prefix` and `--no-insert-timestamp` are not optional: without them
the PE carries the build machine's paths and the build's time into every user's
`.exe`.

Then update the two pins in `../build-windows-exe.ts`, and the two lines at the
end of this section, and commit them with the PE:

- `SFX_STUB_SHA256` — the `sha256sum` printed above.
- `SFX_STUB_SOURCE_SHA256` — a hash over `src/*.rs`, `Cargo.toml`, `Cargo.lock`,
  `shortcut-names.json` and `version-order.json`. Run
  `deno test -A tests/build-windows-sfx-stub.test.ts`: the failing "stub
  sources" test prints the new value. It needs no Rust, so it is the gate that
  catches a source edit nobody rebuilt after — the tests that run `cargo` are
  shown ignored on a machine without it.

`tests/build-windows-sfx-stub.test.ts` fails until the pins, the PE, the magic
in `src/format.rs` and the magic in the packer agree, fails on any build-machine
path in the PE, and — where `rustc --version` is exactly the pinned one and the
mingw-w64 libraries are there — rebuilds the stub and compares it with the
committed file. A new toolchain or dependency changes the bytes: update the
pins, this README and `THIRD_PARTY_NOTICES` together.

Current build: `rustc 1.98.0`, SHA-256
`6ae21df0351152255c2a80298ccad075a40d7203271a31796e3886d423584f31`; sources
`c6227c864a7580d507e9b284a7306e336d28df0e1fddaadcdfc7baea98f97286`.

The trailer format is shared with `build-windows-exe.ts`:
`[stub][payload][JSON header][u32 hdrLen][u64 payloadLen][AIOSFX02]`.
