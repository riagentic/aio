# Vitals DiagReporter — Developer Diagnostics

**Date:** 2026-03-24 **Status:** Approved (brainstorm) **Scope:** ~500-700 lines
new code + tests, 2 new modules, wiring in existing modules

## Problem

AIO's vitals infrastructure detects problems (render freezes, transport
degradation, slow dispatch) but gives developers zero actionable output. When
the UI freezes or shows stale data, developers resort to `console.log` and
guesswork. The probes fire, alerts trigger — but nothing reaches the console in
a useful form.

### Three pain points

1. **UI freezes / goes blank** — state stops updating, clicks don't work
2. **Stale data** — UI renders but shows old state, updates lag behind
3. **Slow actions** — dispatch works but takes too long, UI feels sluggish

## Design

### 1. DiagReporter — split architecture

The reporter runs in **two halves** because probes are split across server and
client:

- **Server-side reporter** — lives inside `createVitalsSystem()`, IS the
  `onVitalAlert` handler. Correlates loop probe + transport probe data. Outputs
  to server console.
- **Client-side reporter** — lives in browser.ts, receives render probe events +
  pong data (which carries `LoopVitals` from server). Outputs to browser
  console.

No new cross-boundary protocol needed: the existing ping/pong already carries
server loop vitals to the client. Render freeze data stays client-side (that's
where the developer's console is). Server-side reporter handles transport/loop
correlation for server-side logging and the `onDiagnostic` hook.

```
SERVER:
  loop probe + transport probe
      ↓
  checkAndAlert() → evaluateHints()
      ↓
  DiagReporter (server)
      ├─ builds DiagEvent (slow, stale, disconnect)
      ├─ formatDiagEvent() → server console
      └─ onDiagnostic(event) → app hook

CLIENT:
  render probe + pong data (carries LoopVitals)
      ↓
  DiagReporter (client)
      ├─ builds DiagEvent (freeze, recovered)
      ├─ formatDiagEvent() → browser console
      └─ (no hook — server hook covers telemetry)
```

**Factory:** `createDiagReporter(config)` — server instance created by
`createVitalsSystem()`. Client instance created alongside render probe in
browser.ts.

**Recovery deduplication:** Each half tracks
`lastStatus: Map<string, DiagEvent["kind"]>`. Emits `recovered` only on
transition from degraded → healthy. Multiple probes clearing simultaneously =
one recovery event.

### 2. DiagEvent type (added to `src/vitals/types.ts`)

```ts
type DiagEvent = {
  kind: "freeze" | "stale" | "slow" | "disconnect" | "recovered";
  severity: "likely" | "possible" | "speculative";
  summary: string;
  detail: {
    trigger?: string; // action/feature that triggered it
    reduceMs?: number;
    p95Ms?: number;
    queueDepth?: number;
    drainRate?: number;
    rtt?: number;
    skipCount?: number;
    frozenFor?: number;
    payloadBytes?: number;
    hint?: string;
  };
  timestamp: number;
};
```

**Kind boundaries:**

| Kind         | Meaning                           | Transport | Data arriving?            | Reporter |
| ------------ | --------------------------------- | --------- | ------------------------- | -------- |
| `freeze`     | UI main thread blocked            | any       | irrelevant — render stuck | client   |
| `stale`      | Connected, deltas skipped/lagging | connected | no / delayed              | server   |
| `slow`       | Actions processing too slowly     | any       | yes, but slow             | server   |
| `disconnect` | Transport lost                    | gone      | no                        | server   |
| `recovered`  | Was degraded, now healthy         | restored  | yes                       | both     |

**VitalStatus → DiagEvent.kind mapping rules:**

| Probe state(s)                                           | DiagEvent.kind |
| -------------------------------------------------------- | -------------- |
| Render probe: `frozen`                                   | `freeze`       |
| Transport: `frozen` (no pong for > frozen threshold)     | `disconnect`   |
| Transport: `degraded`/`warning` + broadcast skips > 0    | `stale`        |
| Loop: reduce time > threshold OR queue depth > threshold | `slow`         |
| Any probe: was non-healthy, now `healthy`                | `recovered`    |

Priority when multiple conditions match: `disconnect` > `freeze` > `stale` >
`slow`. Only the highest-priority kind emits; lower conditions appear in
`detail`.

### 3. Pure formatter (`src/vitals/diag-formatter.ts`)

```ts
function formatDiagEvent(event: DiagEvent): string[];
```

Returns lines. Reporter wraps in `console.group`/`console.warn` (structured
block) or `console.warn` (one-liner).

**Format decision:** Structured block when severity is `"likely"` or
`"possible"` AND 2+ data points available. One-liner otherwise.

**Structured block examples:**

```
[aio:vitals] RENDER FROZEN — no update for 3.2s
  trigger:    portfolio.refresh reduce took 1847ms (p95: 45ms)
  queue:      12 actions pending, drain rate 2.1/s
  transport:  healthy (RTT 23ms)
  hint:       slow reducer blocking main thread — consider async
```

```
[aio:vitals] STALE STATE — 4 broadcasts skipped, client degraded
  last delta:  2.1s ago
  transport:   degraded (RTT 890ms, was 34ms)
  server loop: healthy (p95: 12ms)
  hint:        network latency spike — check connection
```

```
[aio:vitals] SLOW DISPATCH — orders.execute took 340ms (budget: 50ms)
  queue:      8 pending, drain rate 1.4/s
  p95:        28ms (this action is 12x p95)
  effects:    3 in-flight
  hint:       single slow reducer — profile orders.execute
```

**One-liner fallback:**

```
[aio:vitals] transport recovered (was degraded for 1.2s, RTT back to 28ms)
```

### 4. `onDiagnostic` hook — public API

Added to `DiagnosticsConfig` level (alongside `dev`/`prod`, not inside them) in
`src/diagnostics/types.ts`:

```ts
export type DiagnosticsConfig = false | {
  dev?: DiagnosticsOptions;
  prod?: DiagnosticsOptions;
  onDiagnostic?: (event: DiagEvent) => void; // NEW — fires in both modes
};
```

- Lives at config level so it applies regardless of dev/prod mode
- Replaces `onVitalAlert` as the public-facing API
- `onVitalAlert` becomes internal plumbing (not exported)
- Console output gated by dev/prod vitals setting; `onDiagnostic` hook always
  fires when provided + vitals enabled

### 5. Config and defaults

```ts
aio.run({
  diagnostics: {
    dev: { vitals: true }, // default: reporter on, console output on
    prod: { vitals: false }, // default: reporter off, console silent
    onDiagnostic: (event) => {}, // optional: fires in both modes when vitals enabled
  },
});
```

Follows existing `DiagnosticsConfig` pattern.

### 6. Wire `onClientStateSent()` + broadcast payload size

**`onClientStateSent()`** exists in transport probe but is never called.
One-line fix in `src/server.ts` broadcast loop — call it after
`ws.send(delta.msg)`:

```ts
config.vitalsSystem?.serverTransport.onClientStateSent(meta.id, Date.now());
```

Note: signature is `onClientStateSent(clientId: string, ts: number)` — both args
required.

**Broadcast payload size:** Track `delta.msg.length` (byte length of serialized
JSON) per broadcast in a parallel
`Map<string, { lastPayloadBytes: number; totalBytes: number; count: number }>`
alongside the connections map in server.ts. Not added to `ClientLiveness` (keeps
transport liveness separate from content metrics). Surface in
`DiagEvent.detail.payloadBytes` when large payloads correlate with stale/slow
behavior.

### 7. Per-feature state size tracking

Compute per-feature sizes from the state snapshot. Surface when a single feature
dominates total payload — helps developer know where to optimize.

**Performance guard:** Do NOT compute on every broadcast (hot path, up to
100fps). Instead:

- Compute on vitals heartbeat interval (default 1s) by sampling current state
- Compute on-demand when `/__aio/vitals` endpoint is hit
- Only when vitals are enabled

Exposed via `/__aio/vitals` endpoint as `featureSizes: Record<string, number>`
(bytes per feature).

### 8. `useAio()` full-state subscription dev warning

`useAio()` takes no arguments — it subscribes to the entire state tree and
re-renders on every state change. In dev mode, emit:

```
[aio:vitals] useAio() subscribes to full state tree — re-renders on every change. Use useFeature(ref) instead.
```

**Implementation:** Add a dev-only check in the `useAio()` hook in
`src/browser.ts`. Uses `console.warn` once per call site (deduplicate via
`new Error().stack` fingerprint to avoid spam). Note: `useAio()` has no selector
overload — the only fix is to switch to `useFeature(ref)`.

### 9. Hint rule #7: re-render storm detection

New rule in `src/vitals/hints.ts`, detected **client-side** by the render probe.

**Mechanism:** Count `_subscribe` notification callbacks per second (the
function passed to `useSyncExternalStore`). Each call = one potential re-render.
Track count in a sliding 1s window in the client-side reporter.

Threshold: 30+ subscribe notifications in 1 second.

```
[aio:vitals] RE-RENDER STORM — 47 subscribe callbacks in last 1s
  useAio() detected:  yes (full-state subscription active)
  hint:               switch from useAio() to useFeature(ref) for granular subscriptions
```

**What we CAN identify:** Whether `useAio()` (full-state) is active — tracked by
the dev warning in #8. We do NOT attempt to name individual component offenders
(React doesn't expose this without DevTools profiler APIs).

Integrates with #8 — if `useAio()` is detected active AND re-render storm fires,
the hint connects them as likely cause.

### 10. `_applyPatch` reference stability

**Narrow issue:** When a delta patch (`$p`) includes a key whose value is
structurally identical to what's already in state, `_applyPatch` creates a new
object reference for that key's subtree (via `{ ...prev_slice }` spread).
Downstream selectors see a "change" that isn't — triggering unnecessary
re-renders.

Note: `_applyPatch` already preserves references for keys NOT in the patch
(lines 109-111 in browser.ts). The issue is only for keys that appear in `$p`
but carry identical values.

**Fix:** For each key in the patch, shallow-equal compare the incoming value
against the existing value. If equal, preserve the old reference. Use shallow
equality (not deep) to keep the hot path fast — one level of property comparison
per patched key.

## Files touched

| File                                  | Change                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/vitals/diag-reporter.ts`         | **NEW** — createDiagReporter(), server + client variants, correlation, state tracking, throttling                       |
| `src/vitals/diag-formatter.ts`        | **NEW** — formatDiagEvent(), pure string output                                                                         |
| `src/vitals/types.ts`                 | Add `DiagEvent` type                                                                                                    |
| `src/vitals/hints.ts`                 | Add rule #7 (re-render storm detection)                                                                                 |
| `src/vitals/mod.ts`                   | Wire server reporter into createVitalsSystem(), internalize onVitalAlert                                                |
| `src/diagnostics/types.ts`            | Add `onDiagnostic` to `DiagnosticsConfig` (top level, not per-mode)                                                     |
| `src/server.ts`                       | Wire onClientStateSent(id, ts), broadcast payload size tracking map                                                     |
| `src/browser.ts`                      | Client-side reporter, _applyPatch shallow-equal for patched keys, useAio() dev warning, subscribe notification counting |
| `tests/vitals/diag-reporter.test.ts`  | **NEW** — correlation tests with mock probe states                                                                      |
| `tests/vitals/diag-formatter.test.ts` | **NEW** — pure formatter tests                                                                                          |

### 11. Console output throttling

Same `kind` + same `trigger` suppressed for 2 seconds. Prevents a slow reducer
firing every tick from flooding the console. The `onDiagnostic` hook fires every
time (no throttling — the app controls its own sink). Only console output is
debounced.

Implementation: `lastConsoleEmit: Map<string, number>` keyed by
`${kind}:${trigger}`. Skip `console.warn` if < 2s since last emit for that key.

## Nice-to-have (deferred)

- Ring buffer / event timeline for post-mortem
- Per-action round-trip timing
- IPC-specific metrics
- Visual overlay / dashboard page
- Memory profiling
