# AIO Framework — Issues

## ~~AIO-7: Diagnostics disabled when `diagnostics` key omitted from aio.run()~~ ✅ RESOLVED

**Fixed:** Both ternaries (diagHooks at line 1581 and diagResolvedOpts at
line 1589) now check `=== false` instead of `!== undefined`. Omitting
`diagnostics` applies DEV_DEFAULTS/PROD_DEFAULTS as documented. Only explicit
`diagnostics: false` disables everything.

---

## ~~AIO-5: No server→browser config channel~~ ✅ RESOLVED

**Fixed:** `renderBudget` now injected via `window.__aioConfig` in HTML
`<script>` tag. Browser reads thresholds on meter creation. `perfBudget` and
`syncIntervalMs` remain server-only (browser doesn't use them directly).

---

## ~~AIO-8: `_applyPatch` breaks feature-level reference stability on sub-key changes~~ ✅ RESOLVED

**Fixed:** Added `_preserveArrayRefs()` — structural sharing for array sub-keys
in `_applyPatch`. Per-element shallow-equal preserves unchanged element
references after JSON round-trip. 1 of 160 members changed → 159 keep their
reference → `React.memo` skips 159 card re-renders. 8 new tests in
delta.test.ts.

---

## ~~AIO-9: `stateForUI` return value not memoized~~ ✅ RESOLVED

**Fixed:** Memoize `stateForUI` by input state reference + user ID. Cache clears
on state change. Same state + same user → cached result, no re-allocation.
Eliminates ~60 object allocations/sec in multi-tick apps.

---

## ~~AIO-10: Graph validation exceeds budget on startup~~ ✅ RESOLVED

**Fixed:** Budget raised from 500ms to 1000ms. Validation is already async and
non-blocking — 692ms for 50+ files with esbuild transpile is normal. Warning now
only fires for genuinely slow validations.

---

## ~~AIO-11: Wasted render detection — warn when `_preserveArrayRefs` work is defeated by app code~~ ✅ RESOLVED

**Fixed:** Four-layer defense: (1) `useProjection(fn, deps)` re-applies
`_preserveArrayRefs` to derived state output — element refs survive any
transformation; (2) `memo(Component)` from `aio/browser` uses `_shallowEqual`
per prop instead of `===` — catches structurally-identical new objects; (3) aiol
lint rule warns on `React.memo` import and `.map()` without `useProjection`; (4)
runtime warning correlates `_preserveArrayRefs` stats with render staleness to
flag wasted renders at console. 15 new tests, docs in ui.md and linter.md.

---

## ~~AIO-12: `flattenKeys` one-level depth causes full-array delta serialization~~ ✅ RESOLVED

**Fixed:** Identity-keyed array delta compression. `flattenKeys` detects arrays
of objects with stable string `id` fields and expands each element as
`$id:`-prefixed flat keys. `_computeDelta` diffs per-element automatically (zero
changes to diff algorithm). Wire format uses `$arr` marker with `$id:` element
patches and `$rm` for removals. Client `_applyPatch` maintains `_idMaps`
registry for O(changed) patch application with built-in reference preservation.
160-element array with 10 changes: 120KB → ~7.5KB per tick.

---

## ~~AIO-13: `_preserveArrayRefs` cost scales with array size × field count~~ ✅ RESOLVED

**Fixed:** Resolved by AIO-12. Identity-patched arrays bypass
`_preserveArrayRefs` entirely — unchanged elements keep their reference in the
`_idMaps` registry, never compared. 8,000 shallow comparisons per patch
eliminated.

---

## ~~AIO-14: `_reset()` missing `_idMaps.clear()` — ghost elements across sessions~~ ✅ RESOLVED

**Fixed:** Added `_idMaps.clear()` to both `_reset()` and the teardown path in
`_subscribe`'s 300ms cleanup. Identity maps now cleared on session end.

---

## ~~AIO-15: `_applyArrPatch` non-null assertion injects `undefined` on desync~~ ✅ RESOLVED

**Fixed:** Replaced `!` assertion with explicit `undefined` check and
self-healing. Desynced entries are filtered out, `order` is cleaned up, and a
diagnostic event is emitted for debugging.

---

## ~~AIO-16: `flattenKeys` drops empty arrays — client sees `undefined` instead of `[]`~~ ✅ RESOLVED

**Fixed:** Empty arrays now emitted as atomic keys in `flattenKeys` (same as
non-identity arrays). Delta system correctly diffs `[item]` → `[]` as a value
change, not a deletion. Test updated to match correct behavior.

---

## ~~AIO-17: `onerror` handler missing vitals/payloadStats cleanup — memory leak~~ ✅ RESOLVED

**Fixed:** Added vitals/payloadStats/pressureMonitor cleanup to `onerror`
handler, symmetric with `onclose`. Both handlers now have identical cleanup.

---

## ~~AIO-18: Double `onDisconnect` callback — `onerror` + `onclose` both fire it~~ ✅ RESOLVED

**Fixed:** Added `disconnected` flag to `ClientMeta`. Both `onerror` and
`onclose` check the flag before calling `config.onDisconnect`. First handler to
fire sets the flag, second handler skips.

---

## ~~AIO-19: Delta patches silently dropped when `_state === null`~~ ✅ RESOLVED

**Fixed:** Added `_diagEmit` call with `delta-before-state` type in both WS and
IPC handlers when a delta arrives before full state. Still dropped (correct
behavior), but now visible in diagnostics overlay.

---

## ~~AIO-20: `ws.onopen` async — unhandled rejection after `await`~~ ✅ RESOLVED

**Fixed:** Added `ws.readyState !== WebSocket.OPEN` guard after
`await _loadOfflineQueue()`. If socket closed during the async gap, the handler
returns early instead of throwing.

---

## ~~AIO-21: `_accessedPaths` never pruned — subscription bloat after unmount~~ ✅ RESOLVED

**Fixed:** `_accessedPaths.clear()` now called on full state receive (both WS
and IPC handlers). Full state triggers re-render of all mounted components,
which re-populate their paths via proxy getters. Paths from unmounted components
naturally disappear. Also cleared on `_reset()` via `_resetTracking()`.

---

## ~~AIO-22: Graph validation race — overlapping async writes to shared `graphResult`~~ ✅ RESOLVED

**Fixed:** Added `_graphGeneration` counter. Each validation captures its
generation at start. After the async `Promise.race`, if generation has advanced
(newer file change triggered a new validation), the stale result is discarded
via early return.

---

## ~~AIO-23: `_reset()` missing cleanup for `_vitalsPingTimer`, `_useAioActiveCount`, `_diagLastEmit`~~ ✅ RESOLVED

**Fixed:** Added to `_reset()`: `_useAioActiveCount = 0`,
`_diagLastEmit.clear()`, `_resetArrayRefStats()`, `_vitalsUrlLogged = false`,
`clearInterval(_vitalsPingTimer)`, `_vitalsTransportProbe = null`.

---

## ~~AIO-24: UDS idle timeout silently kills Electron IPC — no heartbeat in IPC mode~~ ✅ RESOLVED

**Fixed:** Five-part fix: (1) Removed 5-min idle timeout from UDS handler —
local sockets don't need it (OS closes socket if process dies). (2) Added
`conn.close()` on read-loop exit — no more ghost sockets. (3) `_ipc.onClose` now
sets `_ipcConnected = false` — browser knows connection is dead. (4) Electron
bridge `sock.write()` has error callback — write failures destroy socket and
notify renderer via `__aio:close`. (5) IPC keepalive ping (`__ping` every 60s)
as defense-in-depth, cleaned up in `onClose` and `_reset()`. Server ignores
`__ping` messages. 8 new tests in aio24-uds-ipc.test.ts.

---

## ~~AIO-25: UDS broadcast write errors silently drop connection~~ ✅ RESOLVED

**Fixed:** Added `conn.close()` to both `broadcast()` and `sendTo()`
write-failure paths — async `.catch()` and sync `catch` blocks. Write failures
now close the socket cleanly, triggering Electron-side disconnect → reconnect.
Debug log emitted on broadcast write failure. UDS backpressure not needed —
localhost throughput (~1GB/s) provides ~6000x headroom over current load
(~150KB/s post AIO-12), and the write-failure path already handles the
catastrophic case.

---

## ~~AIO-26: Electron first render — array fields arrive as `undefined`~~ ✅ RESOLVED

**Fixed:** Root cause was delta mismatch in electron.ts `__aio:ready` replay.
The handler sent `lastFullState` (self-consistent) then `lastState` (the latest
delta). But `lastState` was a delta computed against an intermediate state the
renderer never received — applying it on top of `lastFullState` skipped
intermediate deltas, producing corrupt state with missing array fields.
Suspected path #1 confirmed; paths #2 and #3 ruled out (subscription filtering
via `__subs:` doesn't even reach the UDS handler — separate issue AIO-27).

Three-part fix: (1) `__aio:ready` handler now only replays `lastFullState` —
never sends `lastState` delta alongside it. Server's next broadcast tick brings
the renderer up to date. (2) Removed `else if (lastState)` fallback that sent a
stale delta with no base (browser would drop it anyway). (3) Reset
`lastState = null` on UDS reconnect alongside `lastFullState` to prevent stale
state leaking across connections.

---

## ~~AIO-27: UDS reader silently drops `__subs:` messages — subscription filtering broken for Electron~~ ✅ RESOLVED

**Fixed:** Four-part fix: (1) Added `__subs:` prefix check in UDS read loop
(`handleUDSConn`) — parses subscription paths, stores per-client, sends filtered
state immediately (mirrors WS handler in `server.ts:1074-1116`). (2) Extended
`UDSClient` with `subscriptions`, `lastState`, `lastKeyJsons` for per-client
delta tracking. (3) Added `broadcastState(force?)` to `UDSHandle` — iterates
clients, applies `_filterByPaths` per subscription, computes per-client delta
via `_computeDelta`. (4) Removed single-delta state from `aio.ts`
(`udsLastState`/`udsLastKeyJsons`) — delta tracking now lives per-client inside
the UDS module, matching the WS architecture.

---

## ~~AIO-28: UDS subscription race — `_accessedPaths.clear()` + deferred render causes empty subs~~ ✅ RESOLVED

**Fixed:** Two-part defense-in-depth: (1) `_cancelSubsTimer()` called after
every `_accessedPaths.clear()` in both IPC and WS full-state handlers — pending
timer can't fire on stale empty paths. (2) Guard in `_scheduleSyncSubs`: if
`_accessedPaths.size === 0`, the timer callback returns early without sending
empty subscriptions. Together, these prevent the race where a full-state arrival
clears paths while a 16ms sub timer is pending.

---

## ~~AIO-29: Subscription filtering delivers persistently broken state to Electron UI~~ ✅ RESOLVED

**Fixed:** Root cause was protocol conflation — filtered subscription responses
(no `$p` key) were indistinguishable from initial full state. Browser replaced
`_state` with filtered subset, Electron bridge overwrote `lastFullState` with
filtered data. On reload, the filtered state was replayed as "full state",
causing missing features.

Protocol-level fix — `$f` marker: (1) Server adds `$f:1` to any non-delta
message sent to a client with active subscriptions (both WS and UDS, both
`__subs:` immediate responses and broadcast full states). (2) Browser merges
`$f` messages into existing `_state` instead of replacing — preserves
unsubscribed features. Does NOT clear `_accessedPaths`. (3) Electron bridge
skips `$f` messages when updating `lastFullState` — only true full states are
cached for replay. Three message types now explicit: `{data}` = full state
(replace), `{$p:...}` = delta (patch), `{$f:1, data}` = filtered (merge). 5 new
tests in aio29-filtered-marker.test.ts.

---

## ~~AIO-30: Control messages corrupt Electron state cache + shallow $f merge loses sub-keys~~ ✅ RESOLVED

**Fixed:** Two bugs found and fixed:

(1) **Control message corruption (CRITICAL)**: Electron bridge `sock.on('data')`
updated `lastFullState` for ALL lines including `__reload`, `__css`, `__boot:`.
Hot reload sent `"__reload"` → `lastFullState = "__reload"` → page reload →
`__aio:ready` replayed `"__reload"` → browser reloaded again → **infinite
loop**. Fix: Only track JSON lines (`line[0] === '{'`) for
`lastState`/`lastFullState`.

(2) **Shallow merge wipes sub-keys**: `$f` merge was `{...prev, ...data}` — one
level deep. If filtered response had `ratelimit: {providers: [...]}` (no stats),
the merge replaced entire `ratelimit` object, losing `stats`. Fix: Two-level
deep merge preserves feature sub-keys not in the filtered update.

---

## ~~AIO-31: `unflattenPatch` creates conflicting identity patch + deletion — empty→non-empty array transition deletes key from state (CRITICAL)~~ ✅ RESOLVED

**Crash:** `Cannot read properties of undefined (reading 'reduce')`, also
`.length` and `.toFixed()` at different times after app start. Reload
temporarily fixes it.

**Root cause:** When an identity-keyed array transitions from `[]` to
`[{id: ...}]`, `_computeDelta` correctly identifies the flat-key shape change:

- Old flat keys (empty array, AIO-16 atomic): `feature.array` = `[]`
- New flat keys (identity-keyed, AIO-12): `feature.array.$id:a`,
  `feature.array.$id:b`

This produces: changed = `{feature.array.$id:a, feature.array.$id:b}`, removed =
`["feature.array"]`. Both are correct individually.

`unflattenPatch` creates a **self-contradicting patch**:

```json
{ "$p": { "feature": {
    "array": { "$arr": true, "$id:a": {...}, "$id:b": {...} },
    "$d": ["array"]
}}}
```

The identity entries (line 341-347) create
`patch.feature.array = { $arr: true, ... }`. The removal (line 383-387) adds
`"array"` to `patch.feature.$d`.

`_applyPatch` (browser.ts) processes them in order:

1. Line 291-298: `merged["array"] = _applyArrPatch(...)` → correct array created
   ✓
2. Line 310-314: `delete merged["array"]` → **immediately deleted** ✗

Result: `state.feature.array = undefined`. Any `.reduce()`, `.length`,
`.toFixed()` on that array or its elements crashes.

**Affected arrays in this app (all start as `[]`, all elements have
`id: string`):**

- `ratelimit.providers` — populated at ~2s (ratelimit-tick schedule)
- `fleet.members` — populated at fleet init (~3-5s)
- `core.providers` — populated at core refresh
- `health.checks` — populated at first health check
- `bybitFleet.members` — populated at bybit fleet init

**Why Reload fixes it:** Reload → `__aio:ready` → `__subs:["*"]` → fresh full
state (replacement, no delta patching). By then all arrays are non-empty, no
more empty→non-empty transitions.

**Only affects delta path:** Full state replacement (`_state = data`) and `$f`
merge (`_deepMergeFiltered`) are not affected. Bug activates when subscription
filtering is active (specific path subscriptions, not `*`) and `_computeDelta`
returns a delta (not full) containing the key-shape transition.

**Introduced by:** AIO-12 (identity-keyed arrays) + AIO-16 (empty arrays as
atomic keys). Neither considered the flat-key shape transition between atomic
and identity representations.

**Fix location:** `unflattenPatch` in `server.ts` (line 355-388).

**Proposed fix — suppress `$d` deletion when identity patch exists for same
key:**

```typescript
// In the removed-key loop, before adding to $d:
// Check if same key already has an identity patch ($arr)
if (
  parentObj[child] && typeof parentObj[child] === "object" &&
  !Array.isArray(parentObj[child]) &&
  (parentObj[child] as Record<string, unknown>).$arr === true
) {
  continue; // identity patch supersedes atomic removal
}
```

This ensures that when `array` transitions from atomic (`[]`) to identity-keyed
(`[{id:...}]`), the `$d` deletion is suppressed because the identity patch
already replaces the old value.

**Also need reverse guard:** When array transitions from identity-keyed back to
empty (`[{id:...}]` → `[]`), the `$id:` removals go through the `$rm` path (line
372-380), not `$d`. This direction is already safe. But the `$arr` key itself
(if present in old flat keys) would be a non-`$id:` removal → added to `$d`.
Should be harmless since `$arr` is not a real state key, but worth verifying.

**Fixed:** Applied the proposed fix — `unflattenPatch` now checks if the target
key already has a `$arr` identity patch before adding it to `$d`. Identity patch
supersedes atomic removal. Also fixed error boundary death spiral (AIO-32):
error boundary now subscribes to `_subscribe` to prevent 300ms teardown and
auto-recover on state change. 2 new tests in delta.test.ts, 5 in
aio32-error-boundary.test.ts.

---

## ~~AIO-33: UDS delivers stale snapshot — UI shows ENTERING while reducer has idle~~ ✅ RESOLVED

**Confirmed:** 2026-03-26. Reducer state verified via `deno task am state`: all
3 members have `phase=idle`, `lastBar=20:00`, bars flowing normally. UI renders
`ENTERING` — data is not reaching React side correctly.

**Root cause:** Delta protocol had no self-healing mechanism. Once
`lastKeyJsons` on the server advanced past what the client actually received
(due to any transient message loss, async write timing, or Electron bridge relay
gap), the server permanently believed the client had data it never received.
Every subsequent broadcast computed no diff for those keys — the desync was
permanent until app restart.

Two bugs fixed:

(1) **`lastKeyJsons` updated BEFORE send** — `broadcastState` (both WS and UDS)
updated `client.lastKeyJsons` before calling `ws.send()` / `sendTo()`. If the
send failed (WebSocket throw, UDS async write rejection), the server's key cache
advanced but the client never received the data. Subsequent broadcasts would
never re-detect the change. Fix: update `lastState` and `lastKeyJsons` AFTER
successful send. On "skip" (no change), update immediately (no send needed).

(2) **No periodic resync** — the delta protocol had zero recovery mechanism. A
single lost message caused permanent staleness for affected keys. Fix: added
`broadcastCount` per client. Every 100 broadcasts (~5s at 50ms sync interval),
`lastState` and `lastKeyJsons` are reset to force a full state send. This
guarantees any delta desync self-corrects within ~5 seconds.

**Tests:** 2 new tests in delta.test.ts — verifies forced resync recovery and
retry-on-failed-send behavior.

---

## ~~AIO-34: `_computeDelta` reference-equality shortcut unsafe with mutable state~~ ✅ RESOLVED

**Found during:** AIO-33 investigation. Not the cause of AIO-33, but a real
correctness gap.

**Bug:** `_computeDelta` (server.ts:438) used `flat[k] === lastFlat[k]` to skip
`JSON.stringify` for unchanged references. With `freezeState=false` (production
default), state objects are mutable. If a nested object is mutated in-place
(same reference, different content), the reference check produces a false
positive — `lastKeyJsons` is permanently locked to the stale serialization. The
server never re-serializes the element, the client never receives the update.

**Impact:** Permanent stale UI for affected elements. Only recoverable via app
restart or page reload (triggers fresh full state).

**Fix:** Removed the reference-equality shortcut. `_computeDelta` now always
`JSON.stringify`s every flat key and compares against `lastKeyJsons`. Also
removed the now-unused `flattenKeys(lastState)` call. Cost: ~100μs per broadcast
for typical apps (200 keys). Negligible vs WS/UDS transmission time.

**Tests:** 2 new tests in delta.test.ts — verifies mutation detection on both
identity-keyed array elements and regular nested objects.
