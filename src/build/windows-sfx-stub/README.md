# Windows SFX stub (prebuilt)

`prebuilt/aio-windows-sfx-stub-amd64.exe` is the small PE behind the one-click
Windows `<name>-win-x64.exe`. It reads the payload appended by
`../build-windows-exe.ts`, verifies its SHA-256, extracts it once to
`%LOCALAPPDATA%\aio-sfx\<name>\win-<arch>\`, then launches the inner app with
`ELECTRON_PATH` set. Later launches skip the extract when the stamp matches.

**It is committed prebuilt so that building a one-click `.exe` needs no Go
toolchain on the build host.** `ensureWindowsSfxStub` in
`../build-windows-exe.ts` uses the committed file directly (it only checks that
it exists and starts with `MZ`). The zstd payload is packed in Deno
(`packAppDirTarZstd`, `@std/tar` + `node:zlib`), so there is no host packer
binary either.

## Files

| File                                      | Role                                                           |
| ----------------------------------------- | -------------------------------------------------------------- |
| `main.go`                                 | The Windows stub (extract + launch). `//go:build windows`.     |
| `extract.go`                              | Payload extraction (zstd tar, or zip). Host-buildable, tested. |
| `format.go`                               | Shared trailer constants (`AIOSFX02`).                         |
| `extract_test.go`                         | `go test` for the extraction codec (runs on any host).         |
| `go.mod` / `go.sum`                       | The module and its zstd dependency — for rebuilding only.      |
| `prebuilt/aio-windows-sfx-stub-amd64.exe` | The committed PE the build ships.                              |

## Rebuild (only when this source changes)

Needs Go >= 1.22. From this directory:

```sh
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -ldflags="-s -w -H windowsgui" \
  -o prebuilt/aio-windows-sfx-stub-amd64.exe .
```

Then commit the new binary. The trailer format is shared with
`build-windows-exe.ts`:
`[stub][payload][JSON header][u32 hdrLen][u64 payloadLen][AIOSFX02]`.
