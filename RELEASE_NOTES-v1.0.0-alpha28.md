# aio 1.0.0-alpha28 — the restructure completes: B3–B5

alpha27 made methods the ONE style (B1) and un-globaled the runtime (B2).
alpha28 lands everything after: the local-first groundwork, SQLite-only
persistence, the typed wire catalog, the core diet, and the full-matrix
validation harness. The perfect-aio decisions D1–D12 are now all either shipped
or explicitly staged. Migration guide: docs/upgrade/restructure.md.

## B3 phase 1 — Explainable rejections + the server seam (D3/D11)

- **`sync.onRejected`** — when the server refuses an optimistic op, the op is
  pruned, state rebases, the reason reaches your UI. Silent drift is gone.
- **`serverFns` / `serverFn`** — the explicit, typed server/client seam. Define
  in `*.server.ts`; browsers get a typed WS proxy automatically.
- Full local-first flip (`localFirst: true`) is speced
  (docs/specs/2026-07-22-local-first.md) and waits for field mileage.

## B4a — SQLite-only persistence (D4)

Deno.Kv is gone; persisted state lives in your app's single `data.db` (`aio_kv`
table — visible to `am sql`). Legacy KV data migrates automatically on first
boot. Perf gate: writes 27× faster (0.031 vs 0.845 ms/op), setMulti 17× faster;
no more 64 KiB value cap; no more unstable flag.

## B4b phase 1 — ONE typed wire catalog (D7)

`src/protocol/envelope.ts` now catalogs and types every frame on every
transport, and CI pins the catalog against the live code in both directions.
Unification surfaced and fixed four real defects: AIR's divergent ack parse, the
silently-dropped `__sync_error` (client hung in "syncing"), AIR skipping the
`__proto` version hello, and UDS silently dropping WS-only frames.

## B4c — Core diet: `aio/extras` (D5)

The main `aio` entry slimmed 120 → 82 symbols, measured from real imports.
Periphery (lint, parseCli, draft, matchEffect, deepFreeze, instances, deep
diagnostic types, …) moved — unchanged — to `aio/extras`. `deno task lint` flags
old imports with the one-line fix.

## B5 — Full-matrix validation (D6)

- `deno task validate:matrix` — one command: all-target boot smokes + UI
  functional tests + onboarding e2e + build smoke.
- docs/build/validation-runbook.md — the physical checklist (off-box remote,
  Windows/macOS installers, real Android device) with a results ledger.

## Papercuts

- Typed route params: `useRoute<{ id: string }>("/users/:id")`.
- `Link`/`Route` children are typed (`RenderableChildren`) — no more casts.
- The dispatch-budget warning now explains async-method sync-prefix semantics
  instead of gaslighting you about a 3 ms method.

**Breaking:** imports of moved periphery symbols need the `aio/extras` specifier
(aiol tells you exactly which). Everything else is additive.
