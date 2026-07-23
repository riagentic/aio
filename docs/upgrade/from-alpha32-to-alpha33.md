# Upgrade: 1.0.0-alpha32 → 1.0.0-alpha33

A feature + hardening release. The headlines are **`deno task build`** (build a
whole fleet of targets with one command) and **amui**, levelled up into a real
manager. Underneath, a 30-audit sweep and a new artifact-reliability gate closed
several bugs that could lose data or ship a broken binary.

**Most apps upgrade with no code changes.** No wire-protocol change: alpha32 and
alpha33 interoperate. Two things are worth doing deliberately — see
[Recommended after upgrading](#recommended-after-upgrading).

## New: `deno task build` — one command, a whole fleet

Declare the targets once in `deno.json` and build them all into a predictable
`dist/` plus a `manifest.json`:

```json
{
  "build": {
    "targets": ["server", "electron-client", "android-client"],
    "out": "dist"
  }
}
```

```sh
deno task build              # everything in build.targets
deno task build --targets=browser,cli
deno task build --list       # what's available
```

Eight targets (`server`, `browser`, `electron`, `android`, `cli`,
`electron-client`, `android-client`, `cli-client`). Every `compile:*` task keeps
working exactly as before — the fleet build orchestrates them, it doesn't
replace them. See
[build/targets](../build/targets.md#build-a-fleet--deno-task-build).

New apps get the `build` block and task from `am create`. To add it to an
existing app, copy the block above into your `deno.json` and add:

```json
{
  "tasks": {
    "build": "deno run -A ./dep/aio/src/build-all.ts --build-spec=./dep/aio/src/build.ts"
  }
}
```

## amui, levelled up

The manager UI now mines everything aio's diagnostics expose: a **Logs** tab
(framework + app lines, filterable, live-follow), a source-aware **Codebase**
tab, a process card, per-cell health, and a Metrics tab with the dispatch loop,
per-client transport, per-cell state sizes and a live action stream. It also
**lists itself** now — amui is an aio app, so every monitoring surface works on
it (its lifecycle stays off-limits: it can't start or stop itself).

```sh
cd amui && deno task dev
```

## Fixes that may change what you observe

These are bug fixes, not API changes — but if you built a workaround around one
of them, you can drop it.

- **Compiled binaries are portable.** A `deno compile` binary detects prod from
  its embedded `dist/`, so it runs from any directory. Previously it fell back
  to dev mode and crashed unless launched from its build directory.
- **`.wasm` and other data assets are embedded.** Every `.wasm` in your project
  is included automatically; list anything else under `deno.json`
  `"compile": { "include": [...] }`. Apps that read assets via
  `new URL("./x.wasm", import.meta.url)` previously shipped without them.
- **`compile:service` binaries boot, and the generated systemd unit works.** The
  unit used to pass `--headless`, which the binary does not parse — the service
  started in the wrong client mode. It now emits `--client=server-only`. If you
  already installed a generated unit, regenerate it (or change that flag by
  hand).
- **Sync cells survive compaction.** After a `sync: true` cell passed 1000 ops,
  compaction folded them into a snapshot that boot replay never read — the next
  restart came back empty. Boot now restores from the snapshot first.
- **`db:` tables keep persisting after a restart.** The table baseline was taken
  before restored rows loaded, so the first flush after any restart failed with
  a UNIQUE violation and rolled back that flush's writes.
- **`/__aio/…` no longer resolves absolute URLs** (it could read arbitrary local
  files and fetch arbitrary hosts), and `.env`, dotfiles and `*.server.ts` are
  no longer served over HTTP.
- **Electron reconnects don't duplicate state.** The IPC bridge was rebound on
  every reconnect, so after one server restart each update applied twice.
- **`am create --target=X` and `am auth --app=X` are honoured** (both were
  parsed and then ignored).

## Recommended after upgrading

1. **Rebuild your clients.** The browser bundle is now stamped with the aio
   version that built it, and a bundle from a different version is rebuilt
   automatically instead of being reused. A stale `dist/app.js` left over from
   an older framework was the usual cause of "some parts speak a different
   protocol" mismatches. A protocol mismatch now names which side is older.
2. **Run the new build gate** if you ship binaries:

   ```sh
   deno task test:build
   ```

   It builds every compile target for real and requires each artifact to boot
   **from a different working directory** and serve — the check that would have
   caught the portability and systemd bugs above.

## Docs corrections

- The offline queue holds **100** actions, not 1000 (the docs were 10× off).
- The CRDT protocol docs now describe the v2 envelope (`op` / `sync-ack` /
  `sync-req` / `sync-res`); the `__op` / `__ack` / `__sync` frames they still
  documented were removed in alpha29.
