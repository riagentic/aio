# aio 1.0.0-alpha29 — wire protocol v2: ONE envelope

alpha28 typed the v1 wire (B4b phase 1). alpha29 finishes the job: every
message on every transport — WS (browser + CLI), UDS NDJSON, the Electron IPC
relay — is now ONE JSON envelope `{v:2, t:"<kind>", d?:payload}`. The v1 zoo
(string prefixes, discriminator keys, and the "anything without a
discriminator is state" hazard) is deleted. Plus a field-fix batch: testUI
correctness, `ui.exclude` enforcement, CRDT op-dedup, AIR renderer conformance.

Upgrade guide: docs/upgrade/from-alpha28-to-alpha29.md.

## B4b phase 2 — wire protocol v2 (D7)

- **One envelope.** 35 frame kinds catalogued in `src/protocol/envelope.ts`;
  CI pins both directions (every spoken kind catalogued, no v1 prefix outside
  the shim). New frames MUST be added to the catalog first.
- **Overloaded v1 keys split.** `__ack` was two different things — now `ack`
  (per-action) vs `sync-ack` (CRDT). `__sync` was request AND response — now
  `sync-req` / `sync-res`.
- **The bare-JSON hazard is gone.** A frame that doesn't decode is dropped
  loudly — it can never be mistaken for state.
- **Version gate is real now.** `PROTOCOL_VERSION = 2`, `MIN_SUPPORTED = 2`.
  A v1 peer is refused with a readable reason (the ONE deliberate v1 shim:
  the `__proto-err:` string form) and close code 4505 — loud, never silent.
- **UDS reaches parity.** Sync + serverFns now work over UDS/IPC (the alpha28
  transport-capability skew is gone). Vitals + time-travel stay WS-only
  diagnostics and are rejected loudly, never dropped.

## Field-fix batch (risoto, inews, tbd, quant, realitio, machine reports)

- **testUI** (breaking): collision/disabled/shim cluster fixed.
- **`ui.exclude`** (breaking): enforced at every client read seam + truth-trap
  locks — excluded state can no longer leak through any read path.
- **CRDT sync** (breaking): op-id dedup on both sides + a chaos suite; fixed 4
  real op-loss/double-apply bugs.
- **AIR**: conformance suite surfaced and fixed 3 renderer bugs; torture app
  green.
- **DX**: `dbPath` option + `--db-path` flag (hermetic test runs);
  electron-unavailable now falls back to the system browser loudly; two aiol
  false positives killed.

## New gates

- **D12 benchmark suite** runs as a CI gate.
- **Docs-truth gates**: every doc snippet type-checks; stale-term denylist.
