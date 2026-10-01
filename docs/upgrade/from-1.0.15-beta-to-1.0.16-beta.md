# Upgrading from 1.0.15-beta to 1.0.16-beta

Nothing is removed and nothing changes shape. No app needs a code change to keep
working — but two **defaults** change and the memory report gains optional
fields, so read [What you may notice](#what-you-may-notice).

```sh
am pin --latest
```

This is the size round. A compiled binary no longer carries the TypeScript
compiler (or the other build-only npm packages), `build.minify` is on by
default, and the Windows one-click `.exe` carries a zstd-compressed payload that
is smaller than the zip it sits beside. On a reference desktop host the
TypeScript compiler alone was ~152 MB of embedded VFS; Step A removes it, and
the zstd payload is ~15% smaller than the deflate zip.

## What you may notice

- **`build.minify` is now ON by default.** Every compiled target (app, `server`,
  Electron, the Windows exe, `cli`) ships each server module with comments and
  local names stripped — function and class names are kept, JSX is preserved,
  and behavior is unchanged. If you need a stack trace that points into your
  source, or your server reads its own `.ts` source at runtime, opt out with
  `"build": { "minify": false }`.
- **Compiled binaries no longer embed `typescript`, `esbuild` or `happy-dom`**
  (nor anything else the binary's module graph cannot reach). An app that loads
  one at **runtime** — a playground that `import("typescript")` in shipped code
  — must ask for it back by name:

  ```jsonc
  // deno.json
  "build": { "keepPackages": ["typescript"] }
  ```

  The build warns when it is about to drop a package the graph still reaches,
  naming this exact line, so the surprise arrives at build time.
- **The Windows one-click `<name>-win-x64.exe`** now carries a zstd-compressed
  tar payload instead of the zip bytes, and its small extractor stub ships
  prebuilt — building a desktop app needs no Go toolchain. The extracted layout,
  the offline double-click and the next-launch fast path are unchanged; the
  download is smaller and the first extract is faster. The `.zip` artifact is
  still a plain zip. Nothing to do.
- **The packaged Electron runtime** no longer carries aio's own cache stamps
  (`.aio-complete`, `.aio-last-used`). Nothing reads them; nothing to do.
- **Optional Chromium extras stay.** `dxcompiler.dll`/`dxil.dll` and the
  software Vulkan fallback are kept by default — a 3D app keeps hardware
  acceleration and a GPU-less VM keeps its software fallback. An owner who knows
  the app renders no GPU content can opt in to removing them with
  `"build": { "chromiumExtras": "strip" }`.
- **The memory report gains OPTIONAL fields.** `MemoryReport` (from
  `aio/extras`) can now carry `native` (`{ rss, external, rssGrowth }`),
  `nativeLeak` (the heap was flat while RSS climbed), `gauges` and `topGrower`.
  They are additive and absent unless the host supplies them, so an existing
  `onMemoryPressure` handler compiles and runs unchanged. `am heap` now reports
  a `gauges` array (each series with its `owner` and, for a bounded counter, its
  ceiling), and `/__aio/metrics` adds `aio_memory_external_bytes` and one
  `aio_memory_gauge{name,owner,unit,kind}` per series. Nothing to do.
- **An app whose project root is a huge directory no longer hangs at boot.** The
  version is derived from the nearest `deno.json` ancestor of the entry; if that
  ancestor is a directory aio will not hash (a stray `deno.json` in `$HOME` made
  `$HOME` the “project”, an 896 GB read), the version now reports `unknown (…)`
  and boot continues. Give the app its own `deno.json` (or make the project a
  git repository) to get a version back. Nothing to do otherwise.

- **A production Electron app's socket serves only its own window.** When an app
  runs with no TCP port (`prod` + `uds` + Electron), the local socket now gives
  every same-user process that is not the Electron window the app spawned **no
  state and no methods** — checked with kernel peer credentials (`SO_PEERCRED`/
  `LOCAL_PEERPID`/`GetNamedPipeClientProcessId`). Such a process may still use
  the `ctl` control plane (that is how `am` reaches a running app, and it serves
  no raw state in production). Dev is unaffected (the lockdown is production-
  only), and so is any app that opened a TCP port. Nothing to do.
- **Other applications cannot read the socket.** A Unix socket or named pipe
  cannot be sniffed from outside; the only ways in are opening a session (a
  foreign peer is given no state and no methods) or reading the process's memory
  (denied on Linux via `PR_SET_DUMPABLE`). What this does NOT do is sandbox code
  running inside your own window — a compromised renderer is still a trusted
  client, so keep `visible`/`access` for what the window may see and call.

## Retire

- Nothing. No workaround in this guide's scope is retired by 1.0.16-beta.
