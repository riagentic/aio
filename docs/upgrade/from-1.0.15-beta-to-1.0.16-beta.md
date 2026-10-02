# Upgrading from 1.0.15-beta to 1.0.16-beta

Nothing is removed and nothing changes shape. Two **defaults** change, the
memory report gains optional fields, and a production desktop app locks its
local socket down — which a few apps must act on. Read
[What you may notice](#what-you-may-notice).

> **Go straight to 1.0.17-beta** (`am pin --latest` does). 1.0.16-beta shipped
> defects in the three things it introduced — minified builds, the Windows
> one-click `.exe` and the local-peer lockdown — which 1.0.17-beta repairs. This
> page describes what you get on 1.0.17-beta; continue with
> [1.0.16-beta → 1.0.17-beta](from-1.0.16-beta-to-1.0.17-beta.md).

```sh
am pin --latest
```

This is the size round. A compiled binary no longer carries the TypeScript
compiler (or the other build-only npm packages), `build.minify` is on by
default, and the Windows one-click `.exe` carries a zstd-compressed payload that
is smaller than the zip it sits beside. On a reference desktop host the
TypeScript compiler alone was ~152 MB of embedded VFS, and the zstd payload is
~15% smaller than the deflate zip.

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
- **Optional Chromium extras stay.** `dxcompiler.dll`/`dxil.dll`, the software
  Vulkan implementation (`vk_swiftshader*`) and the Vulkan loader
  (`vulkan-1.dll`, `libvulkan.so.1`) are kept exactly as Electron shipped them.
  `"build": { "chromiumExtras": "strip" }` removes all of Vulkan — hardware and
  software, since the loader is how Chromium reaches any Vulkan driver — and the
  DXIL compiler, leaving the OpenGL/Direct3D paths. Only for an app that renders
  no GPU content.
- **The memory report gains OPTIONAL fields.** `MemoryReport` (from
  `aio/extras`) can now carry `native` (`{ rss, external, rssGrowth }`),
  `nativeLeak` (the heap was flat while RSS climbed, over two consecutive
  windows), `gauges` and `topGrower`. They are additive and absent unless the
  host supplies them, so an existing `onMemoryPressure` handler compiles and
  runs unchanged. `am heap` now reports a `gauges` array (each series with its
  `owner` and, for a bounded counter, its ceiling), and `/__aio/metrics` adds
  `aio_memory_external_bytes` and one `aio_memory_gauge{name,owner,unit,kind}`
  per series. Nothing to do.
- **An app whose project root is a huge directory no longer hangs at boot.** The
  version is derived from the nearest `deno.json` ancestor of the entry, and a
  stray `deno.json` in a home directory made the whole home "the project". The
  read is bounded: up to 20,000 files and 128 MB the `-dirty`/`-nogit` hash is
  of paths and contents, as before; past that it is of path, size and mtime;
  past 50,000 files, 50,000 directories or 64 levels the version reports
  `unknown (…)` and boot continues. A pinned `"version": "1.2.3"` reads no tree.
  To do, only if you see `unknown (…)`: give the app its own `deno.json`. The
  numbers are in [versioning](../build/versioning.md#what-a-version-may-cost).
- **`AIO_MAX_HEAP_MB`** (new) caps an app's V8 heap, in decimal megabytes; a
  value below the built-in floor is raised to it. A value that is no number
  above zero (`4g`, `0`) is no cap; another spelling of a number (`0x2000`,
  `1e4`) caps at the number it is read as. Each says so in a warning. See
  [environment](../build/environment.md). Nothing to do.

- **A production Electron app's local sockets serve only its own window.** In
  production (`--prod` / a built app), a desktop app on its local socket gives a
  session only to the window process it launched — on the state socket and on
  the HTTP socket beside it — checked with kernel peer credentials
  (`SO_PEERCRED`/ `LOCAL_PEERPID`/`GetNamedPipeClientProcessId`). Any other
  process of the same user gets no state and no methods. Over `ctl` such a
  process may ask `GET /__aio/health` only, and is told `{status, appId}` — so
  `am health` still answers. Dev is unaffected. An app that named a TCP port
  keeps that port open to every local process (the socket is still gated, and
  the boot log says what the port leaves open). **To do:**
  - a companion process that connects to the app's socket needs
    `electron: { allowLocalPeers: true }`;
  - a `$ELECTRON_PATH` wrapper must `exec` Electron;
  - `--prod --client=electron` run from source needs `--allow-ffi`.
- **What the lockdown is not.** A foreign process cannot open a session. It can
  still read the app's `state.db` and logs on disk and, unless the OS forbids
  it, the window process's memory (on Linux the **server** process is made
  non-dumpable; the Electron window process is not). This stops other programs
  connecting; it is not a boundary against code running as the same user, and it
  does not sandbox code inside your own window — keep `visible`/`access` for
  what the window may see and call. `$ELECTRON_PATH` names the process that is
  trusted. Details:
  [Local-peer lockdown](../auth/auth.md#local-peer-lockdown-production-desktop-apps).

## Retire

- Nothing. No workaround in this guide's scope is retired by 1.0.16-beta.
