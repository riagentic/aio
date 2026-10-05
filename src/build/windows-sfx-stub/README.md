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
3. Takes the install's named mutex (waits up to 10 minutes), so a second
   double-click during the first extraction waits, then only launches. A Windows
   mutex belongs to the thread that waited for it; the stub takes and releases
   it on its main thread (the payload is decoded on a second one).
4. Stamp (`.aio-sfx-stamp`) equal to the payload hash: removes a leftover
   `win-<arch>.replaced` / `win-<arch>.incoming` (a stub that was killed) and
   launches. Otherwise it moves the existing install aside
   (`win-<arch>.replaced` — this is the step that fails while the app is
   running, and then nothing is changed and the message says to close the app),
   extracts beside it (`win-<arch>.incoming`), stamps, renames the new tree in
   and deletes the old one. Any failure puts the old install back. An install of
   a NEWER version than the payload's is kept as it is: the stub writes the
   payload's version to `.aio-sfx-version` when it extracts, the app rewrites it
   with its own version at every start, and an `.exe` whose version is older
   only opens the install. An old download therefore never puts its version over
   an app that has updated itself.
5. When it extracted, and the header asks for it (`shortcut`), adds a Start-menu
   shortcut to `<name>.exe` named after the app (`title`), so the download can
   be deleted. A shortcut the user removed is not put back by a later open.
6. Starts `<name>.exe` with the user's arguments and exits (it does not wait for
   the app, so its exit code is the stub's own).

The app's updater replaces the extracted tree in place and carries the stamp
into the new tree (`carrySfxStamp`, `../../server/updates-apply.ts`), so the
downloaded `.exe` stays a launcher for the updated app.

## Files

| File                                      | Role                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `src/main.rs`                             | The Windows stub (hash, lock, launch). Windows-only code.         |
| `src/install.rs`                          | The swap: aside, extract, stamp, rename in, undo. Host-tested.    |
| `src/extract.rs`                          | Payload extraction (zstd tar, or zip). Host-tested.               |
| `src/format.rs`                           | Trailer constants (`AIOSFX02`) and parser. Host-tested.           |
| `src/version.rs`                          | Version order, the updater's (`version-order.json`). Host-tested. |
| `version-order.json`                      | Version pairs both comparators are tested against.                |
| `Cargo.toml` / `Cargo.lock`               | The crate and its pinned dependencies — for rebuilding only.      |
| `prebuilt/aio-windows-sfx-stub-amd64.exe` | The committed PE the build ships.                                 |
| `THIRD_PARTY_NOTICES`                     | Licenses of what the PE links (Rust, the crates, mingw-w64).      |

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
- `SFX_STUB_SOURCE_SHA256` — a hash over `src/*.rs`, `Cargo.toml`, `Cargo.lock`
  and `version-order.json`. Run
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
`2fd8497fbb7c00cf1cecee664b4e8b1b2bd8c01e0a5c0196f010bf8704d41871`; sources
`7aa3ce923acd381e4dae5a0c8a8b51e4177b64cf6adaefd4e62f70a2f7c5b3fd`.

The trailer format is shared with `build-windows-exe.ts`:
`[stub][payload][JSON header][u32 hdrLen][u64 payloadLen][AIOSFX02]`.
