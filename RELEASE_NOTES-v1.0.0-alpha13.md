# v1.0.0-alpha13 — DX overhaul + production hardening

The largest release since `feature()` → `cell()`: the full DX overhaul (phases
1–9), a production-readiness pass that fixed every audited defect and made the
project's own gates green/binding/CI-enforced, plus nuclear audit waves 6–11.

> ⚠️ **Breaking for existing alpha users.** Defaults changed and the React
> compat hooks moved. See **Upgrade** below —
> `docs/upgrade/from-alpha12-to-alpha13.md`.

## ✨ Highlights

- **Honest defaults** — `persist` and `ui` now default to `"all"`. Zero-config
  apps persist and sync, exactly as the README always claimed.
- **`await method()` actually means "applied"** — bound methods return Promises;
  in the browser they resolve on server **ack**, so a read on the next line is
  fresh.
- **Client-scoped cells** — `scope: "client"`: browser-local, per-tab,
  signal-backed state, skipped by server composition.
- **It fails loud, with a fix** — name collisions, dropped dispatches, and
  mis-classified async methods now throw in dev with an actionable message.
- **Green is provable** — CI runs fmt/lint/check/tests across the supported Deno
  range + a JSR publish dry-run on every PR.

## 💥 Breaking changes & upgrade

- **Default flip:** `persist`/`ui` default to `"all"` (was effectively opt-in).
  Opt out per cell with `persist: "none"` / `{ include }` / `{ exclude }`. The
  "mode cliff" (one configured cell flipping global behavior) is gone.
- **React compat hooks moved off the main surface:** `useState` / `useEffect` /
  `useMemo` / `useCallback` are now **only** at `aio/air/compat`. `useRef` stays
  on `aio/air` (native AIR primitive).
  ```diff
  - import { useState, useEffect } from "aio/air";
  + import { useState, useEffect } from "aio/air/compat";
  ```
- **`AioConfig` is no longer a public export** — the public authoring surface is
  `CellsConfig` (`cells: [...]`).
- **`await` on bound methods** now resolves on apply/ack; existing `await`s get
  _more_ correct, unawaited calls are unchanged (fire-and-forget).

→ Full steps: **`docs/upgrade/from-alpha12-to-alpha13.md`**

## 🧠 DX overhaul

- `useEffect` honors a non-empty deps array (React semantics; signal
  auto-tracking disabled inside deps-driven effects).
- **Typed events:** `e.currentTarget` is element-typed (`AirEvent<T>`);
  `onDoubleClick` aliased; unknown event names warn in dev.
- Child signal subscriptions are independent of parents — the `void sig.value`
  incantation is gone (invariant pinned by test).
- Sync-classified methods that return a Promise throw in dev with a `markAsync`
  hint.
- `ui.entry` replaces the hardcoded `App.tsx` convention (default unchanged);
  `aio doctor` validates the magic `deno.json` lines.

## 🐛 Correctness fixes (production audit B-1…B-13)

- **Signal graph never drops updates** — eager dirty-flag invalidation, lazy
  value pull; an effect reading a signal + derived computed in the same
  `batch()` is glitch-free. (B-2)
- **SQLite worker type-checks again**; `deno check` now covers `src/` incl.
  worker entries. (B-1, B-9)
- **Dropped dispatches reject** instead of resolving on unapplied state. (B-4)
- **Persistence/offline silent-failure trio fixed** — failed multi-key KV
  commits reported, offline queue warns when full, shutdown flush re-runs. (B-7,
  B-8, B-10)
- **esbuild** false "not installed" warning gone; dev transpile + prod bundle
  pinned to the tested version. (B-5, B-6)
- **Lint to zero**, gate now binding. (B-3)

## 🔒 Operations & security

- **Configurable WebSocket limits** (`wsLimits`: message size / msgs-per-sec /
  bytes-per-sec) for tuning `--expose` deployments; defaults unchanged.
- **`/health` reports the framework version** for deploy verification.
- **Token-in-URL** (`?token=`) emits a one-time warning — stays a fallback but
  flags the leak surface. (B-11)

## 🛡️ Hardening — nuclear audit waves 6–11 (~194 fixes)

Sync protocol routing (`onTTCommand` guard keeps time-travel commands out of
prod sync), sync cursor advance, concurrent HLC drop, SVG namespace, watcher
sentinel TOCTOU, logger flush race, signal listener leak, rate-limiter abuse
detection, op-buffer TTL eviction, state-module cleanup.

## 🔧 Release engineering

- **CI** (`.github/workflows/ci.yml`): fmt / lint / check / full test suite
  across the supported Deno range (**2.6.0 floor** + latest stable, ubuntu +
  macOS) + JSR publish dry-run.
- **Whole-tree `deno fmt`** (binding gate) and a **`docs:check`** gate that
  fails if any `AioErrorCode` ships undocumented.
- aiol shares the framework version (single source of truth) and no longer
  false-flags the framework's own internals.
- **GitHub issue templates** (bug / DX paper-cut / docs-lie).

## 📚 Docs

New `from-alpha12-to-alpha13` upgrade guide; fixed the stale "persist defaults
to none" claim in the alpha10→11 guide; every error code documented in
`docs/debugging/errors.md`; dead links and stale `stateForUI`/`stateForDB`
references removed.

---

**Requires Deno 2.6+** · **Quality:** all gates green — 1997 tests, 0 failed.

**Full diff:**
https://github.com/riagentic/aio/compare/v1.0.0-alpha12...v1.0.0-alpha13
