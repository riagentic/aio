# Windows SFX stub (prebuilt)

`prebuilt/aio-windows-sfx-stub-amd64.exe` is the small PE behind the one-click
Windows `<name>-win-x64.exe`. It reads the payload appended by
`../build-windows-exe.ts`, verifies its SHA-256, extracts it once to
`%LOCALAPPDATA%\aio-sfx\<name>\win-<arch>\`, then launches the inner app with
`ELECTRON_PATH` set. Later launches skip the extract when the stamp matches.

**It is committed prebuilt so that building a one-click `.exe` needs no Go
toolchain on the build host.** `ensureWindowsSfxStub` in
`../build-windows-exe.ts` uses the committed file only when its SHA-256 equals
the pinned `SFX_STUB_SHA256`; any other bytes are refused, loudly. The zstd
payload is packed in Deno (`packAppDirTarZstd`, `@std/tar` + `node:zlib`), so
there is no host packer binary either.

## What the stub does

1. Finds the trailer: at the end of the file, or — for an Authenticode-signed
   exe — just before the certificate table (PE security directory, up to 7 pad
   bytes).
2. Hashes the payload and compares it with the header.
3. Takes the install's named mutex (waits up to 10 minutes), so a second
   double-click during the first extraction waits, then only launches. A Windows
   mutex belongs to the thread that waited for it, so `main` pins itself to its
   thread (`runtime.LockOSThread`) — released from another thread the lock
   stayed held until the process exited.
4. Stamp (`.aio-sfx-stamp`) equal to the payload hash: removes a leftover
   `win-<arch>.replaced` / `win-<arch>.incoming` (a stub that was killed) and
   launches. Otherwise it moves the existing install aside
   (`win-<arch>.replaced` — this is the step that fails while the app is
   running, and then nothing is changed and the message says to close the app),
   extracts beside it (`win-<arch>.incoming`), stamps, renames the new tree in
   and deletes the old one. Any failure puts the old install back.
5. Starts `<name>.exe` with the user's arguments and exits (it does not wait for
   the app, so its exit code is the stub's own).

The app's updater replaces the extracted tree in place and carries the stamp
into the new tree (`carrySfxStamp`, `../../server/updates-apply.ts`), so the
downloaded `.exe` stays a launcher for the updated app.

## Files

| File                                      | Role                                                          |
| ----------------------------------------- | ------------------------------------------------------------- |
| `main.go`                                 | The Windows stub (lock + launch). `//go:build windows`.       |
| `install.go`                              | The swap: aside, extract, stamp, rename in, undo. Host-built. |
| `extract.go`                              | Payload extraction (zstd tar, or zip). Host-built.            |
| `format.go`                               | Trailer constants (`AIOSFX02`) and parser. Host-built.        |
| `*_test.go`                               | `go test ./...` — runs on any host.                           |
| `go.mod` / `go.sum`                       | The module and its zstd dependency — for rebuilding only.     |
| `prebuilt/aio-windows-sfx-stub-amd64.exe` | The committed PE the build ships.                             |
| `THIRD_PARTY_NOTICES`                     | Licenses of what the PE links (Go, klauspost/compress).       |

## Rebuild (only when this source changes)

The build is reproducible: the same Go version and this command give the same
bytes on any machine, from any directory. Pinned: **go1.27.1**,
`github.com/klauspost/compress v1.17.11` (`go.sum`). From this directory:

```sh
go test ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -buildvcs=false -ldflags="-s -w -H windowsgui" \
  -o prebuilt/aio-windows-sfx-stub-amd64.exe .
sha256sum prebuilt/aio-windows-sfx-stub-amd64.exe
```

`-trimpath -buildvcs=false` are not optional: without them the PE carries the
build machine's paths and the checkout's revision into every user's `.exe`.

Then update the two pins in `../build-windows-exe.ts`, and the two lines at the
end of this section, and commit them with the PE:

- `SFX_STUB_SHA256` — the `sha256sum` printed above.
- `SFX_STUB_SOURCE_SHA256` — a hash over `*.go`, `go.mod` and `go.sum`. Run
  `deno test -A tests/build-windows-sfx-stub.test.ts`: the failing "stub
  sources" test prints the new value. It needs no Go, so it is the gate that
  catches a source edit (a `_test.go` one too) nobody rebuilt after — the tests
  that run `go` are shown ignored on a machine without it.

`tests/build-windows-sfx-stub.test.ts` fails until the pins, the PE, the magic
in `format.go` and the magic in the packer agree, fails on any build-machine
path in the PE, and — where `go version` is exactly the pinned one — rebuilds
the stub and compares it with the committed file. A new Go version or dependency
changes the bytes: update the pins, this README and `THIRD_PARTY_NOTICES`
together.

Current build: `go1.27.1`, SHA-256
`e9bee8d42ef71032400fb36bc1f4cffdf932af8e7895cf1965d5c2873af17263`; sources
`2aabfadf55385b773e8fe8cc67f9aa6a95c77544e9579d963df1682366205834`.

The trailer format is shared with `build-windows-exe.ts`:
`[stub][payload][JSON header][u32 hdrLen][u64 payloadLen][AIOSFX02]`.
