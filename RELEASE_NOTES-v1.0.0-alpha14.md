# v1.0.0-alpha14 — public-surface audit + AIR test harness

Road-to-1.0 hardening plus field-report fixes: the public-surface audit (entry
renames, export trims), wire-protocol and persistence versioning, AIR renderer
lifecycle correctness, and a public component test harness (risharp session 1–2
feedback).

> ⚠️ **Breaking for existing alpha users.** Export paths changed and surfaces
> were trimmed — no runtime semantics changed. See **Upgrade** below —
> `docs/upgrade/from-alpha13-to-alpha14.md`.

## ✨ Highlights

- **The public surface is now locked** — an API snapshot
  (`docs/api-snapshot.json`) is CI-enforced; changing the surface requires a
  deliberate `deno task api:update`.
- **Wire-protocol version handshake** — server and clients exchange
  `__proto:{v,min}` hellos (WS, UDS, CLI); mismatches close loudly (code 4505)
  instead of failing mysteriously. Legacy clients still work.
- **Persistence schema versioning** — KV snapshots are stamped after each
  successful write; alpha-era stores migrate transparently, newer-schema stores
  refuse to load with `PERSIST_SCHEMA` instead of being misread.
- **Public component test harness** — `testComponent`/`setDocument` render and
  drive AIR components in tests without a browser (also via `aio/testing`).
- **`aio create --vendored`** — git-clones the framework into `dep/aio/` with
  the vendored import map already correct.

## 💥 Breaking changes & upgrade

- **Entry renames:** `./src/build` → `./build` (now exports `build(cfg?)`
  instead of building on import), `./src/am` → `./am` (pure CLI entry). Update
  `deno task` definitions using the jsr: paths.
- **`aio/adapters/air` removed** — import `useAio`/`useLocal`/`useConnected`
  from `aio/air`.
- **`aio/air` trimmed 145 → 101 exports** — state re-exports (`aio`, `cell`,
  `actions`, `effects`, `log`, `schedule`, `msg`) live on `aio` only;
  `_`-internals and protocol plumbing hidden; every remaining export documented.
- **Stability tags:** `aio/state-core` and `aio/sync` engine internals are
  `@experimental`; `aio/db` no longer exports the worker wire format.

→ Full steps: **`docs/upgrade/from-alpha13-to-alpha14.md`**

## 🐛 Correctness fixes (field reports, AIO-390…AIO-402)

- **Browser `aio` surface exports `own`** — module-top `import { own }` (the
  documented `own.set` pattern) no longer crashes the browser graph. (AIO-402)
- **UDS server acks dispatches** — awaited methods no longer hang over Electron.
  (AIO-402)
- **`onMount` runs after the DOM subtree and refs are committed** (AIO-390) and
  **fires exactly once** across re-renders that re-collect mount callbacks.
  (AIO-400)
- **Awaited methods no longer falsely time out** — idempotent ack registration
  per cid (AIO-396); the AIR command router settles acks instead of swallowing
  `__ack:` frames. (AIO-399)
- **Fragment-in-map keyed children keep DOM order** across re-renders, pinned by
  a reorder/add/remove stress suite. (AIO-395)
- **Pre-bind cell reads return declared state defaults** instead of undefined.
  (AIO-391)
- **Nested array state serializes as arrays** through the async live proxy
  (AIO-397); **browser-side `cell()` honors `scope: "client"`** and rejects
  async client methods at definition time. (AIO-398)
- **Perf guards no longer flood the console** — throttled per (code, action) to
  once per 10s with a coalesced count; every occurrence still reaches the
  diagnostic bus. (AIO-401)
- **Cell `version`/`onMigrate` stamps are actually written** — migrations no
  longer re-run on every restart.

## 🧪 New APIs

- **`useRaf`** — requestAnimationFrame loop with automatic cleanup. (AIO-392)
- **`CellEffect`** — typed self-referencing effects in cell configs.
- **`cell.method.action()`** — schedule methods without hand-writing action
  objects.
- **Multi-client sync concurrency pinned by E2E test** — interleaved op storm,
  exact ack/relay counts, no echo, late-joiner catch-up.

## 📚 Docs

Backoff-on-rate-limit self-scheduling pattern; keyed-map-with-default accessor
pattern; README vendored snippet declares `immer` + `@std/path`; new
`from-alpha13-to-alpha14` upgrade guide.
