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

---

## ~~AIO-36: `_reset()` does not remove `popstate` listener or clear `_popstateHandler`~~ ✅ RESOLVED

**Severity:** MEDIUM **Category:** Resource Leak **File:**
`src/browser.ts:1741-1791`

**Bug:** `_reset()` clears all timers, sockets, and state but does NOT call
`removeEventListener("popstate", _popstateHandler)` or set
`_popstateHandler = null`. The teardown path inside `_subscribe()`'s 300ms
cleanup (line 496-498) does clean it up, but `_reset()` is the authoritative
cleanup function used by tests and reconnection.

After `_reset()`, the stale `_popstateHandler` (pointing to old `_rSync`)
remains registered. A subsequent `_subscribe()` checks `if (!_popstateHandler)`
(line 453) — since it's still set, no new listener is added. But the old
listener references stale closure state.

Additionally, line 1857-1860 registers a popstate listener at module top-level
load, outside any lifecycle — this one is never cleaned up by anything.

**Fix:** Add to `_reset()`:

```typescript
if (_popstateHandler) {
  removeEventListener("popstate", _popstateHandler);
  _popstateHandler = null;
}
```

**Fixed:** Applied the proposed fix — `_reset()` now removes popstate listener
and nulls `_popstateHandler` before `_resetTracking()` and `_coreReset()`.

---

## ~~AIO-37: `useVirtualList` division by zero when `itemHeight <= 0`~~ ✅ RESOLVED

**Severity:** LOW **Category:** Edge Case / Defensive **File:**
`src/virtual-list.ts:74-78`

**Bug:** `Math.floor(scrollTop / itemHeight)` and
`Math.ceil(containerHeight / itemHeight)` divide by `itemHeight` with no guard.
If user passes `itemHeight: 0`, both produce `Infinity`, causing the loop (line
82-84) to attempt infinite iterations → browser tab freeze.

**Fix:** Guard at function entry:

```typescript
const safeItemHeight = Math.max(1, itemHeight);
```

**Fixed:** Applied guard. `safeItemHeight` used for divisions only;
multiplications keep original `itemHeight` (correctly produce 0 when
`itemHeight` is 0).

---

## ~~AIO-38: `useFieldArray` `move()` inserts `undefined` on out-of-bounds index~~ ✅ RESOLVED

**Severity:** MEDIUM **Category:** Edge Case / Data Corruption **File:**
`src/form.ts:209-213`

**Bug:** `move(from, to)` does `arr.splice(from, 1)` with no bounds check. When
`from >= arr.length`, splice returns `[]`, destructuring yields `undefined`, the
`!` assertion is compile-time only (no runtime effect), and
`arr.splice(to, 0, undefined)` silently inserts `undefined` into the field
array. The form now has a ghost `undefined` entry that will crash on render.

```typescript
move(from: number, to: number) {
  const arr = [...sig.peek()];
  const [item] = arr.splice(from, 1);  // empty if from OOB
  arr.splice(to, 0, item!);             // inserts undefined
  sig.set(arr);
}
```

Same pattern affects `set(index, item)` on line 215 — no bounds check, sets
`arr[index]` which can create sparse array holes if index > length.

**Fix:** Guard both:

```typescript
move(from: number, to: number) {
  const arr = [...sig.peek()];
  if (from < 0 || from >= arr.length || to < 0 || to > arr.length) return;
  const [item] = arr.splice(from, 1);
  arr.splice(to, 0, item!);
  sig.set(arr);
}
```

**Fixed:** Applied bounds guards to `move()`, `set()`, and `remove()`. All three
no-op on invalid indices.

---

## ~~AIO-39: `Listeners.notify()` skips listeners on concurrent deletion during iteration~~ ✅ RESOLVED

**Severity:** MEDIUM **Category:** Race Condition / Correctness **File:**
`src/listeners.ts:21-23`

**Bug:** `notify()` iterates over the internal `Set<fn>` directly. Per
ECMAScript spec, if an element is deleted from a Set before being visited during
`for...of`, it is skipped. If a listener's callback causes another listener to
be unsubscribed (deleted from the Set) during the same notification cycle, that
listener never fires.

```typescript
notify(value: T): void {
  for (const fn of this.fns) fn(value);  // fn() can delete next listener
}
```

**Confirmed with test:**

```typescript
const fns = new Set();
const fn1 = () => {
  fns.delete(fn2);
}; // removes fn2
const fn2 = () => {/* never called */};
fns.add(fn1);
fns.add(fn2);
for (const fn of fns) fn(); // fn2 skipped!
```

**Trigger scenario:** React `useSyncExternalStore` — each component subscribes
via `_listeners.add()`. During `_listeners.notify()`, `onStoreChange()` triggers
React re-render. If batching is bypassed (e.g. `flushSync`, or AIR renderer
synchronous updates), a component unmount calls `unsub()` which deletes from the
Set mid-iteration. The next listener is skipped — that component misses the
state update.

**Impact:** Intermittent stale renders. Hard to reproduce because it depends on
listener insertion order and synchronous unmount timing.

**Fix:** Copy before iterating:

```typescript
notify(value: T): void {
  for (const fn of Array.from(this.fns)) fn(value);
}
```

**Fixed:** Applied `Array.from()` snapshot before iteration. Listeners can no
longer be skipped by mid-cycle deletion.

---

## ~~AIO-40: `_applyPathDelete` null/array guard incomplete — `typeof null === "object"` passes check~~ ✅ RESOLVED

**Severity:** LOW **Category:** Defensive / Edge Case **File:**
`src/state-core.ts:428-433`

**Bug:** The type guard on line 429 uses
`typeof current[parts[i]!] !== "object"` to bail on non-object intermediates.
But `typeof null === "object"` in JS, so null values pass the check. Line 430
then does `{ ...null }` which produces `{}` — silently corrupting `null` to
empty object. Same issue with arrays: `{ ...[1,2,3] }` produces
`{ "0": 1, "1": 2, "2": 3 }`.

```typescript
if (typeof current[parts[i]!] !== "object") return; // null passes!
current[parts[i]!] = {
  ...(current[parts[i]!] as Record<string, unknown>), // { ...null } → {}
};
```

**Trigger:** Cannot be triggered via normal delta protocol — `flattenKeys` never
generates sub-paths through null values (line 296: `v &&` short-circuits on
null). Only triggerable via crafted `_applyPathDelete` call, which doesn't
happen in production.

**Fix:** Defense-in-depth — tighten the guard:

```typescript
const val = current[parts[i]!];
if (!val || typeof val !== "object" || Array.isArray(val)) return;
```

**Fixed:** Applied tighter guard. Null and arrays now rejected at the type
check.

---

## ~~AIO-41: `aiol` lint check uses unescaped state key in RegExp — breaks on special chars~~ ✅ RESOLVED

**Severity:** LOW **Category:** Correctness / Edge Case **File:**
`aiol/checks.ts:461`

**Bug:** State key names are interpolated directly into `new RegExp()` without
escaping regex special characters:

```typescript
const arrayMatch = f.file.content.match(new RegExp(`${key}\\s*:\\s*\\[`));
```

If a state key contains regex metacharacters (e.g. `items[0]`, `data.list`,
`a+b`), the pattern becomes malformed — false negatives or thrown errors.

**Trigger:** Unlikely in practice — state keys are typically valid JS
identifiers. But the linter should be robust against any input.

**Fix:**

```typescript
const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const arrayMatch = f.file.content.match(new RegExp(`${escaped}\\s*:\\s*\\[`));
```

**Fixed:** Applied regex escaping. Only `new RegExp` with dynamic interpolation
in the file.

---

## ~~AIO-42: Error overlay `label` not escaped in `innerHTML` — defense-in-depth~~ ✅ RESOLVED

**Severity:** LOW **Category:** Defense-in-depth / XSS surface **File:**
`src/server-html.ts:458`

**Bug:** `label` is injected into `innerHTML` without `esc()`:

```javascript
"&#9888; " + label + "</div>";
```

All other dynamic values in the overlay use `esc()`. Currently `label` only
receives hardcoded strings from `classifyBrowserError()` (`'Import Error'`,
`'Build Error'`, etc.), so this is not exploitable today. But the `c.label`
override path (line 449) means a future server change could introduce XSS if it
starts returning user-influenced labels.

**Fix:** Apply `esc()` for consistency:

```javascript
"&#9888; " + esc(label) + "</div>";
```

**Fixed:** Applied `esc(label)` — consistent with all other dynamic values in
the overlay.

---

## ~~AIO-43: `graph-validator.ts` — `resolveSpecifier` rejects JSX runtime imports as missing from import map~~ ✅ RESOLVED

**Severity:** BLOCKING **Category:** Graph Validator / False Positive **File:**
`src/graph-validator.ts:93-103`

**Bug:** When the JSX compiler transform (`jsxImportSource: "aio"`) rewrites
`.tsx` files, it injects `import { jsx } from "aio/jsx-runtime"` (or
`react/jsx-runtime` depending on config). These are **compiler-injected
imports** — they don't appear in the source and don't need explicit import map
entries. The runtime resolves them via `jsxImportSource`.

`resolveSpecifier` checks `importMap[spec]` and when `react/jsx-runtime` or
`aio/jsx-runtime` is not found in the import map, it returns a
`missing-import-map` error. Since `missing-import-map` is in the `BLOCKING`
error set (line 350), this **prevents the app from loading** in dev mode.

**Trigger:** Any `.tsx` file in a project using `jsxImportSource: "aio"` without
an explicit `react/jsx-runtime` entry in `deno.json` imports.

**Reproduction:**

1. Set `compilerOptions.jsxImportSource: "aio"` in `deno.json`
2. Remove `react/jsx-runtime` from imports (it's not needed — aio provides the
   JSX runtime)
3. Start dev server → graph validator blocks with:
   ```
   "react/jsx-runtime" is not in the import map
   FIX: Add "react/jsx-runtime": "npm:react/jsx-runtime" to deno.json imports.
   ```

**Root cause:** `resolveSpecifier` (line 93) does a direct `importMap[spec]`
lookup with no awareness that `/jsx-runtime` and `/jsx-dev-runtime` specifiers
are implicitly resolved by the compiler's JSX transform.

**Fix applied:** Added early return before the import map lookup:

```typescript
// JSX runtime specifiers are injected by the compiler (jsxImportSource),
// not explicit imports — treat as external even without an import map entry.
if (spec.endsWith("/jsx-runtime") || spec.endsWith("/jsx-dev-runtime")) {
  return { kind: "external", url: spec };
}
```

**Test:** Project with `jsxImportSource: "aio"` and no `react/jsx-runtime`
import map entry now starts without graph errors.

---

## ~~AIO-44: `graph-validator.ts` — `checkPlatformSafety` flags guarded `Deno.*` usage as server-only~~ ✅ RESOLVED

**Severity:** LOW (non-blocking, `server-only-api` category is not in BLOCKING
set) **Category:** Graph Validator / False Positive **File:**
`src/graph-validator.ts:170-187`

**Bug:** `checkPlatformSafety` scans for `Deno.*` usage in browser-bound code to
warn about server-only APIs. It correctly strips comments and string literals
before scanning, but does NOT account for `typeof Deno !== 'undefined'` runtime
guards. Code like:

```typescript
const args = typeof Deno !== "undefined" ? Deno.args : [];
```

is runtime-safe (the guard prevents `Deno.args` from executing in browsers), but
the validator still flags `Deno.args` as `server-only`.

**Impact:** Non-blocking (the error category `server-only-api` is filtered out
of the blocking set at line 349-354), but produces noise in the dev overlay.

**Trigger:** Any feature file that uses `typeof Deno` guards for isomorphic
code.

**Fix applied:** Added same-line `typeof Deno` guard detection in the `DENO_RE`
scan loop:

```typescript
const originalLine = code.split("\n")[lineNum - 1] ?? "";
if (/typeof\s+Deno\b/.test(originalLine)) continue;
```

**Limitation:** Only checks the same line. Multi-line guards like:

```typescript
if (typeof Deno !== "undefined") {
  Deno.args; // next line — not detected
}
```

are NOT handled. Single-line ternary pattern (the common case) IS handled.

---

## ~~AIO-45: `browser-air.ts` — AIR entry point had NO WebSocket/IPC transport (CRITICAL)~~ ✅ RESOLVED

**Severity:** CRITICAL **Category:** Transport / Architecture **File:**
`src/browser-air.ts`

**Bug:** `browser-air.ts` (the AIR renderer browser entry point, served as
`/__aio/ui.js` when `renderer: "aio"`) imported everything from
`browser-protocol.ts` but **never wired up a WebSocket or IPC transport**. The
transport lived exclusively in `browser.ts` (the React entry point) which:

1. Calls `_setConnectFn()` to wire `_connect()` into the protocol layer
2. Calls `_setSubscribeTriggers()` to wire subscription reconnection
3. Calls `_setTeardownFn()` to wire cleanup
4. Calls `_setClientSend()` to wire action dispatch

Without these calls, `_connectFn` in `browser-protocol.ts` remained `null`. The
flow:

1. HTML bootstrap calls `await _aioMod._waitForState()`
2. `_waitForState()` calls `if (_connectFn) _connectFn()` — `_connectFn` is
   `null`
3. No WS/IPC connection opens
4. `_stateReadyPromise` never resolves
5. App permanently shows "Loading…"

**Symptoms:** Any app using `renderer: "aio"` shows "Loading…" forever. No
errors in console. Server logs show the app started correctly. Switching to
`renderer: "react"` (which uses `browser.ts`) works fine.

**Root cause:** `browser-air.ts` was created during the renderer-agnostic split
(commit `7a982a7`) to provide a React-free AIR entry point. The protocol layer
was correctly extracted into `browser-protocol.ts`, but the transport wiring
that lived in `browser.ts` was not duplicated or extracted into a shared module.
The `_setConnectFn` / `_setSubscribeTriggers` / `_setTeardownFn` /
`_setClientSend` dependency injection pattern requires explicit wiring by each
entry point — if any is missing, things silently break.

**Fix applied:** Added a complete minimal WS + IPC transport directly in
`browser-air.ts`:

- `_connect()` — WebSocket connection with auto-reconnect (exponential backoff)
- `_connectIPC()` — Electron IPC bridge for UDS mode
- `_send()` — routes actions through WS, IPC, or offline queue
- `_handleState()` — calls `_coreHandleMessage`, `_incStateVersion`,
  `_resolveStateReady`
- Full wiring: `_setConnectFn`, `_setSubscribeTriggers`, `_setTeardownFn`,
  `_setClientSend`

The AIR transport intentionally omits React-specific features from `browser.ts`:

- No `_walkReactTree` (React DevTools component tree)
- No `_listeners.notify()` (AIR uses signals, not external store subscriptions)
- No vitals render meter (AIR auto-memo makes this less critical)
- No offline queue persistence (IndexedDB replay) — simplified for MVP
- No `__click:` / `__getState` / `__tt:` command handling (React DevTools only)

**Architectural note:** The duplication between `browser.ts` and
`browser-air.ts` is now worse. Both files contain independent transport
implementations (~200 lines each), plus duplicated routing components, `msg()`,
`actions()` factory, `schedule` stubs, etc. The correct long-term fix is
extracting the transport into a shared `browser-transport.ts` that both entry
points import. See AIO-47 for the deduplication proposal.

**Verified:** App loads, initial state arrives, `useFeature` returns populated
state, UI renders. Tested via both WS (browser) and IPC (Electron UDS).

---

## ~~AIO-46: `browser-air.ts` — `_handleState` passes raw data instead of merged state to `_checkStateIntegrity`~~ ✅ RESOLVED

**Severity:** LOW **Category:** Correctness / Diagnostic **File:**
`src/browser-air.ts` (in the transport added by AIO-45 fix)

**Bug:** The `_handleState` function in browser-air.ts:

```typescript
function _handleState(data: Record<string, unknown>) {
  const result = _coreHandleMessage(data);
  if (result === "dropped") return;
  if (result === "noop") return;
  _checkStateIntegrity(data); // ← passes raw incoming data
  _incStateVersion();
  if (_coreHasState()) _resolveStateReady();
}
```

passes the raw incoming `data` (which may be a delta `{$p:...}` or filtered
`{$f:1,...}`) to `_checkStateIntegrity`. The React transport in `browser.ts`
correctly passes the **merged state** after `_coreHandleMessage`:

```typescript
const next = _coreGetState(); // ← gets merged state from state-core
_checkStateIntegrity(next); // ← validates the final merged state
```

**Impact:** `_checkStateIntegrity` may run on partial data (delta patches,
filtered responses) instead of the full merged state. In practice this is
low-impact since integrity checks are non-blocking diagnostics, but the
validation results would be misleading.

**Fix:** Replace `_checkStateIntegrity(data)` with:

```typescript
import { getState as _coreGetState } from "./state-core.ts";
// ...
const next = _coreGetState();
_checkStateIntegrity(next);
```

---

## ~~AIO-47: `browser.ts` / `browser-air.ts` massive code duplication — maintainability risk~~ ✅ RESOLVED

**Severity:** MEDIUM **Category:** Architecture / Maintainability **Files:**
`src/browser.ts` (1,399 lines), `src/browser-air.ts` (603 lines)

**Problem:** Both browser entry points contain independent, duplicated
implementations of:

| Duplicated Code                 | browser.ts                                  | browser-air.ts    | Lines (each) |
| ------------------------------- | ------------------------------------------- | ----------------- | ------------ |
| WS/IPC transport                | `_connect`, `_connectIPC`, reconnect, queue | Same (simplified) | ~200         |
| `msg()` function                | Lines 200-210                               | Lines 102-111     | ~10          |
| `actions()`/`effects()` factory | Lines 212-240                               | Lines 113-141     | ~30          |
| `schedule` stubs                | Lines 242-270                               | Lines 143-171     | ~30          |
| `page()` function               | Lines 372-380                               | Lines 242-249     | ~8           |
| `useRoute()`                    | Lines 382-395                               | Lines 254-261     | ~12          |
| `useNavigate()`                 | Lines 397-405                               | Lines 264-269     | ~8           |
| `Route` component               | Lines 407-450                               | Lines 285-313     | ~30          |
| `Outlet`                        | Lines 452-458                               | Lines 316-319     | ~5           |
| `Link`                          | Lines 460-490                               | Lines 322-343     | ~20          |
| `NavLink`                       | Lines 492-500                               | Lines 346-352     | ~8           |
| `Redirect`                      | Lines 502-515                               | Lines 355-362     | ~10          |
| `memo()`                        | Lines 350-370                               | Lines 233-238     | ~8           |

**Total duplicated:** ~370 lines across both files.

`browser-air.ts` line 100 comments: "inline copy — same as browser.ts, dev mode
single-file constraint." However, this constraint appears outdated — the dev
mode transpiler already handles multi-file imports (esbuild transpiles each file
independently, and the import map resolves inter-module references).

**Risk:** Any bug fix to routing, `msg()`, `schedule`, or other shared logic
must be applied in both files. History shows this leads to drift — the transport
implementations already differ (browser.ts has vitals, offline queue, DevTools;
browser-air.ts has a simplified version).

**Proposed fix:** Extract shared code into `browser-shared.ts`:

```
browser-shared.ts  — msg, actions, schedule, page, routing, memo (~200 lines)
browser-transport.ts — _connect, _connectIPC, _send, reconnect, queue (~250 lines)
browser.ts — React-specific: hooks, vitals, _walkReactTree, Listeners (~600 lines)
browser-air.ts — AIR-specific: signal hooks, auto-memo (~200 lines)
```

Both entry points import from shared modules. No duplication. The "single-file
constraint" comment should be verified and removed if outdated.

**Phase 1 Fixed:** Extracted `browser-shared.ts` (72 lines) containing `msg()`,
`_factory()`/`actions()`/`effects()`, `schedule` — 100% identical code that was
duplicated in both files. Both browser.ts and browser-air.ts now re-export from
the shared module. browser.ts: 1399→1324 (−75), browser-air.ts: 608→538 (−70).

**Phase 2 Fixed:** Extracted transport helpers to `browser-shared.ts`:
`detectIPC()`, `buildWsUrl()`, `refreshCSS()`, `handleControlMessage()`,
`AioIPCBridge` type. Eliminated 4 copies of control message handling (__reload,
__css, __boot:). browser.ts: 1324→1282, browser-air.ts: 538→501.

**Remaining transport/router code is intentionally separate:** Transport differs
significantly (browser.ts adds vitals, offline queue, DevTools, time-travel —
~200 lines of React-specific logic interleaved). Router components use different
rendering primitives (createElement vs h()). A strategy-pattern abstraction
would add complexity without clarity.

---

## ~~AIO-48: `createLiveProxy` missing `has` and `ownKeys` traps — `Array.map()`, `{...spread}`, `in` operator fail silently~~ ✅ RESOLVED

**Severity:** HIGH **Category:** State / Proxy **File:**
`src/feature-impl.ts:306-356`

**Bug:** `createLiveProxy` (the proxy used by async methods to read/write state)
only implements `get` and `set` traps. Missing traps:

| Missing Trap               | Affected Operations                                                | Symptom                                                               |
| -------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `has`                      | `'key' in obj`, `Array.prototype.map` (uses `in` to check indices) | `map()` may skip elements or produce unexpected results               |
| `ownKeys`                  | `Object.keys()`, `Object.entries()`, `{...spread}`, `for...in`     | `{...obj}` produces `{}` (empty object), `Object.keys()` returns `[]` |
| `getOwnPropertyDescriptor` | `Object.entries()`, `JSON.stringify()`                             | May throw or return undefined for valid keys                          |

**Reproduction:**

```typescript
// In an async method:
async navigateTo(s: MdviewState, filePath: string, scrollY: number) {
  // s is a live proxy — s.history returns a nested proxy for the history array

  // FAILS: .map() internally uses `in` operator — no `has` trap
  const copy = s.history.map(e => ({ ...e }))  // produces array of {}

  // FAILS: spread uses ownKeys — no `ownKeys` trap
  const entry = s.history[0]
  const clone = { ...entry }  // produces {} — all properties lost

  // WORKS: explicit property access via `get` trap
  const clone2 = {
    filePath: entry.filePath,   // get trap → reads value correctly
    scrollY: entry.scrollY,     // get trap → reads value correctly
  }
}
```

**Impact:** Any async method that uses `Array.map()`, `Object.keys()`,
`Object.entries()`, `{...spread}`, `for...in`, or `in` operator on proxy state
will silently produce wrong results (empty objects, empty arrays). The proxy
reads fresh state correctly via explicit property access (`obj.key`), but
structural operations that enumerate keys fail because the proxy target is an
empty `{}` object (line 355: `new Proxy({} as S, handler)`).

**Root cause:** The proxy target is `{}` (empty object) and there are no
`ownKeys` or `has` traps. JavaScript engines use the proxy target's own keys as
the basis for enumeration when no `ownKeys` trap is provided. Since the target
is `{}`, enumeration yields nothing.

**Workaround (current):** `snapshotHistory()` in mdview uses explicit
index-based access:

```typescript
function snapshotHistory(proxy, updateIdx, scrollY) {
  const len = proxy.length; // get trap — works
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    const e = proxy[i]!; // get trap — works
    out[i] = { filePath: e.filePath, scrollY: e.scrollY, fileName: e.fileName }; // explicit property reads — works
  }
  return out;
}
```

This is fragile — every consumer of proxy state must know to avoid standard JS
patterns.

**Proposed fix:** Add `has`, `ownKeys`, and `getOwnPropertyDescriptor` traps:

```typescript
const handler: ProxyHandler<S> = {
  get(_target, prop, _receiver) {/* existing */},
  set(_target, prop, value) {/* existing */},

  has(_target, prop) {
    if (typeof prop === "symbol") return false;
    const fresh = path.length === 0
      ? getState()
      : getNestedValue(getState(), path);
    return prop in (fresh as object);
  },

  ownKeys() {
    const fresh = path.length === 0
      ? getState()
      : getNestedValue(getState(), path);
    return Reflect.ownKeys(fresh as object);
  },

  getOwnPropertyDescriptor(_target, prop) {
    const fresh = path.length === 0
      ? getState()
      : getNestedValue(getState(), path);
    return Object.getOwnPropertyDescriptor(fresh as object, prop);
  },
};
```

**Note:** The `get` trap already reads from fresh state on every access, so
adding these traps maintains the same fresh-read semantics. The `set` trap
(mutation batching) is unaffected.

---

## ~~AIO-49: Signal system — no cycle detection in computed chains~~ ✅ RESOLVED

**Severity:** MEDIUM **Category:** Signals / Safety **File:** `src/signal.ts`

**Bug:** `ComputedImpl.get()` re-runs the compute function and re-subscribes to
dependencies. If computed A depends on computed B which depends on computed A,
calling `.value` on either triggers infinite recursion → stack overflow.

```typescript
const a = computed(() => b.value + 1); // depends on b
const b = computed(() => a.value + 1); // depends on a
a.value; // → stack overflow
```

There is no cycle detection or max-depth guard. The `_trackStack` (line 38)
grows unboundedly.

**Impact:** Runtime crash (stack overflow). Currently unlikely in practice since
computed chains in aio apps are typically shallow, but becomes a real risk as
the framework is used for more complex derived state.

**Proposed fix:** Track recomputation depth or maintain a "currently computing"
set:

```typescript
const _computing = new Set<ComputedImpl<unknown>>();

get() {
  if (_computing.has(this)) {
    throw new Error(`[aio:signal] Circular dependency detected in computed`);
  }
  _computing.add(this);
  try {
    // ... existing recompute logic
  } finally {
    _computing.delete(this);
  }
}
```

---

## ~~AIO-50: Signal system — glitch (stale notification) outside `batch()`~~ ✅ RESOLVED

**Severity:** LOW **Category:** Signals / Correctness **File:**
`src/signal.ts:116-129`

**Bug:** When a signal is set **outside** `batch()`, the two-phase notification
runs immediately per-subscriber:

```typescript
set(v: T) {
  if (Object.is(this._value, v)) return;
  this._value = v;
  if (_batchDepth > 0) {
    // deferred — correct
  } else {
    // immediate — glitch-prone
    for (const sub of this._subscribers) sub.prepare();
    for (const sub of this._subscribers) sub.execute();
  }
}
```

If subscriber A's `execute()` triggers another signal change, subscriber B's
`prepare()` already ran on the old value. The new signal change queues new
prepare/execute calls, but B's first `execute()` still fires with stale state.

Inside `batch()`, this is handled correctly — all changes are deferred,
`_flush()` processes them in a loop until stable. Outside `batch()`, there is no
such protection.

**Impact:** Intermittent stale renders when signals are set outside batch
context. Low impact in practice because:

1. Most signal sets in aio happen inside `_applyFullState` /
   `_applyDeltaToSignals` which use `batch()`
2. The AIR renderer's `_scheduleComponentRender` uses `queueMicrotask`, which
   naturally batches

**Trigger scenario:** Manual `signal.set()` call outside batch, where one
subscriber's execute causes another signal.set() that affects a subsequent
subscriber.

**Proposed fix:** Make all signal sets implicitly batched:

```typescript
set(v: T) {
  if (Object.is(this._value, v)) return;
  this._value = v;
  for (const sub of this._subscribers) _pendingSubscribers.add(sub);
  if (_batchDepth === 0) _flush();
}
```

This routes all notifications through `_flush()`, which loops until stable. The
explicit `batch()` API remains for grouping multiple signal changes into a
single flush.

---

## ~~AIO-51: `_flush()` in signal.ts has no max-iteration guard~~ ✅ RESOLVED

**Severity:** LOW **Category:** Signals / Safety **File:**
`src/signal.ts:133-149`

**Bug:** `_flush()` uses `while (_pendingSubscribers.size > 0)` with no
iteration cap:

```typescript
function _flush(): void {
  while (_pendingSubscribers.size > 0) {
    const batch = [..._pendingSubscribers];
    _pendingSubscribers.clear();
    for (const sub of batch) sub.prepare();
    for (const sub of batch) sub.execute();
    // If execute() triggers new signal changes, _pendingSubscribers refills
    // Loop continues indefinitely
  }
}
```

If a subscriber's `execute()` always triggers a signal change that re-queues
subscribers, this loops forever → browser tab freeze.

**Impact:** Theoretical infinite loop. Unlikely in practice but possible with
poorly designed computed chains or effect-driven signal updates.

**Proposed fix:** Add max-iteration guard:

```typescript
function _flush(): void {
  let iterations = 0;
  while (_pendingSubscribers.size > 0) {
    if (++iterations > 100) {
      console.warn(
        "[aio:signal] _flush exceeded 100 iterations — possible infinite loop. Remaining subscribers cleared.",
      );
      _pendingSubscribers.clear();
      break;
    }
    // ... existing logic
  }
}
```

---

## ~~AIO-52: `aio.ts` monolith — 2,986 lines, single point of maintainability failure~~ ✅ RESOLVED

**Severity:** MEDIUM **Category:** Architecture / Maintainability **File:**
`src/aio.ts`

**Problem:** `aio.ts` is the largest single file in the framework at 2,986
lines. It handles:

- CLI argument parsing
- Middleware pipeline
- Feature registration and composition
- Persistence (checkpoint save/load)
- Scheduling (cron, timers)
- Server startup orchestration
- Time-travel integration
- Diagnostics initialization
- State broadcasting (WS + UDS)
- Hot reload / file watching
- Electron launch
- Graph validation triggering

This makes the file:

1. **Hard to navigate** — finding where broadcast logic ends and persistence
   begins requires scrolling through hundreds of unrelated lines
2. **Hard to test in isolation** — everything depends on the full `aio()`
   startup
3. **Merge conflict magnet** — any two concurrent changes likely touch this file
4. **Circular dependency risk** — other modules can't import helpers from
   `aio.ts` without pulling in the entire orchestrator

**Proposed decomposition:**

```
aio.ts          — orchestrator: startup sequence, config merge, feature registration (~500 lines)
persistence.ts  — checkpoint save/load/restore (~300 lines)
scheduler.ts    — cron, timers, schedule effects (~200 lines)
broadcast.ts    — WS + UDS state broadcasting, delta computation (~400 lines)
cli-parse.ts    — argument parsing, config defaults (~200 lines)
hot-reload.ts   — file watcher, graph validation trigger (~200 lines)
```

Each module exports a clean interface. `aio.ts` composes them in startup order.
Tests can import individual modules.

**Phase 1 Done:** Extracted `paths.ts` (84 lines) + `config.ts` (271 lines) —
pure functions, zero coupling. aio.ts: 2986→2599 (−387, −13%).

**Phase 2 Done:** Extracted `persistence.ts` (179 lines) + `shutdown.ts` (140
lines) — factory pattern with context objects, lazy refs for late-bound
subsystems. aio.ts: 2599→2420 (−179, −7%). Total reduction: 2986→2420 (−566,
−19%).

**Phase 3 Done:** Extracted `uds.ts` (245 lines) — createUDSListener +
handleUDSConn with delta compression, subscription filtering, client state
requests. aio.ts: 2420→2079 (−341). Total reduction: 2986→2079 (−907, −30%).

**Remaining orchestration (~2079 lines) is the main _run() function:** config
merge, feature registration, dispatch wiring, server startup, Electron launch,
signal handlers. This is intentionally one function — it's a startup sequence
with order dependencies that would be harder to reason about if split further.

---

## ~~AIO-53: Build system fetches source from URLs with no integrity verification~~ ✅ RESOLVED

**Severity:** MEDIUM **Category:** Security / Supply Chain **File:**
`src/build.ts`

**Problem:** The HTTP plugin in `build.ts` fetches framework source from URLs
(JSR, esm.sh) at build time:

```typescript
const source = await fetch(sourceUrl).then((r) => r.text());
```

No hash or signature verification. A compromised CDN, MITM attack, or DNS hijack
could inject arbitrary code into the built application. The fetched source is
transpiled and bundled directly into the output binary.

**Impact:** Supply chain attack vector. Low likelihood (requires network-level
attack), but high impact (full code injection into production binary).

**Proposed fix:** Add Subresource Integrity (SRI) style verification:

```typescript
const source = await fetch(sourceUrl).then((r) => r.text());
const hash = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(source),
);
const expected = INTEGRITY_MAP[sourceUrl.href];
if (expected && toHex(hash) !== expected) {
  throw new Error(`Integrity check failed for ${sourceUrl.href}`);
}
```

With a committed `INTEGRITY_MAP` that maps known URLs to expected hashes.
Updated when framework version bumps.

---

## ~~AIO-54: Electron UDS script missing `will-navigate` handler~~ ✅ RESOLVED

**Severity:** CRITICAL **Category:** Electron / Navigation **File:**
`src/electron.ts`

**Original bug:** UDS electron script was missing `will-navigate` handler — link
clicks navigated away from SPA.

**Fix (multi-phase):**

1. Added `will-navigate` + `preventDefault` + `setWindowOpenHandler` to both
   scripts
2. Added IPC relay: intercepted URLs sent back to renderer via `__aio:navigate`
   IPC → preload dispatches `CustomEvent('aio:navigate')` →
   `browser-protocol.ts` handles via `navigate()`

**Note:** The persistent "links don't work" symptom initially attributed to
Electron click swallowing was actually caused by an **app-side infinite render
loop** (AIR signal update in rAF → re-render → rAF → repeat), which continuously
destroyed and rebuilt DOM, preventing click events from propagating. The AIO fix
(IPC relay) is correct and provides good Electron navigation support. The render
loop was an app bug, not an AIO bug.

---

## ~~AIO-55: esbuild follows `import()` with static string into server-only code~~ ✅ RESOLVED

**Fixed:** Two-pronged fix in `src/esbuild-plugin.ts`:

1. **CJS stub modules** — server-only stubs (`@std/*`, `node:*`) now use
   `module.exports = Proxy` instead of ESM `export default`. esbuild resolves
   named imports from CJS via the exports object at runtime, not static analysis
   — so `import { join } from "@std/path"` inside transitively-imported files no
   longer breaks the build.
2. **`*.server.ts` convention** — dynamic `import('./foo.server.ts')` is marked
   external by the plugin. Server-only helper modules can use this suffix to be
   excluded from browser bundles entirely.

Template literal workaround (`import(\`\${_hp}.ts\`)`) is no longer needed.

---

## ~~AIO-56: `aio://` custom protocol missing `registerSchemesAsPrivileged` — fails same-origin checks~~ ✅ RESOLVED

**Fixed:** Added `protocol.registerSchemesAsPrivileged()` at module scope in
`electronMainScriptUDS` (before `app.on('ready')`). Registers `aio://` scheme
with `standard`, `secure`, `supportFetchAPI`, and `corsEnabled` privileges.
Conditional on `USE_PROTOCOL` (prod mode only). Same-origin checks now pass for
`aio:///` URLs.

---

## ~~AIO-57: Proxy `.map()` + spread still fails silently on second+ call~~ ✅ RESOLVED

**Fixed:** Two-part surgical fix in `src/feature-impl.ts` (`createLiveProxy`):

1. `ownKeys` trap now **deletes stale keys** from `target` before adding missing
   ones — keeps target in sync when the underlying array/object is fully
   replaced between calls.
2. `getOwnPropertyDescriptor` trap now reads descriptor value **directly from
   `fresh` state** rather than from `target`, so it is immune to stale target
   content regardless of sync timing.

**Severity:** HIGH **Category:** State / Proxy **File:** `src/feature-impl.ts`
(`createLiveProxy`)

**Previous fix:** Added ownKeys/preventExtensions/isExtensible traps to satisfy
ES invariants. Marked resolved.

**Still broken:** `.map()` with `{...spread}` on proxy state arrays silently
fails on second+ invocation. The method's catch block catches the error, sets
`s.error`, but navigation never completes.

**Evidence:**

```
// First navigateTo — history has 1 entry → .map() works → new page loads ✅
// Second navigateTo — history has 2 entries → .map() fails silently → no state update, no re-render ❌
```

Console shows `send.navigateTo` dispatched, but no Article re-render follows.
Server error log confirms proxy-related failures. Restoring `snapshotHistory()`
(explicit indexed access) immediately fixes the issue.

**Reproduction:**

```typescript
// In async method — s is a live proxy:
const history = s.history.map((e, i) =>
  // ← fails on 2nd+ call
  i === s.historyIndex ? { ...e, scrollY } : e // ← spread on proxy entry
);
```

**Working workaround:**

```typescript
function snapshotHistory(proxy, updateIdx, scrollY) {
  const len = proxy.length;
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    const e = proxy[i]!;
    out[i] = i === updateIdx
      ? { filePath: e.filePath, scrollY, fileName: e.fileName }
      : { filePath: e.filePath, scrollY: e.scrollY, fileName: e.fileName };
  }
  return out;
}
```

**Hypothesis:** The ownKeys trap syncs target keys on first call but something
goes stale after the proxy state is mutated (first navigateTo assigns
`s.history = [...]`). The second `.map()` call sees inconsistent target state.

---

## ~~AIO-58: AIR ref callbacks not reliably invoked — element handlers never attach~~ ✅ RESOLVED

**Fixed:** `removeDomCleanup` in `src/vdom.ts` now calls `_callRef(ref, null)`
for element refs during cleanup. Previously, element refs were only nullified in
`removeDom` but not in `removeDomCleanup` (used by type-mismatch replacement),
causing ref callbacks to leak. Initial mount ref calls were already correct.

---

## ~~AIO-59: AIR signals lack equality check — `.set()` with same value triggers re-render loop~~ ✅ RESOLVED

**Fixed:** `signal.set()` in `src/signal.ts` now performs shallow equality
comparison for objects/arrays before notifying subscribers. Primitives use
`Object.is`, objects compare key count + `===` per value, arrays compare
length + `===` per element. `set({...same values...})` from rAF callbacks no
longer triggers infinite re-render loops. 5 new tests.

---

## ~~AIO-60: Error messages point to framework internals, not app code~~ ✅ RESOLVED

**Fixed:** `generateTip` in `src/error.ts` now detects proxy/ownKeys errors and
includes the method name, feature name, and a specific hint about avoiding
.map()/.spread on proxy state. Error messages for REDUCE_ERROR also improved.

---

## ~~AIO-61: No dev-mode warnings for common signal pitfalls~~ ✅ RESOLVED

**Fixed:** Existing guards already cover most cases: (1) `_rerenderComponent`
warns at 50 re-renders/sec, (2) `_flush` caps at 100 iterations with warning,
(3) AIO-59 shallow equality prevents the most common infinite loop cause. No
additional warnings needed — false positive risk outweighs benefit.

---

## ~~AIO-62: JSX event types use `@types/react` — native DOM events require `as any` casts everywhere~~ ✅ RESOLVED

**Fixed:** Added `src/jsx.d.ts` — AIR-specific JSX type definitions with native
DOM event types. `onClick` types as `(e: MouseEvent) => void`, `onKeyDown` as
`(e: KeyboardEvent) => void`, etc. Covers all HTML elements, form elements, SVG,
and ARIA/data attributes. No more `as any` casts for event handlers.

---

## ~~AIO-63: No `dangerouslySetInnerHTML`~~ RETRACTED — feature exists, mdview wasn't using it

**RETRACTED:** AIR DOES support `dangerouslySetInnerHTML={{ __html: string }}`
(documented in renderer.md). The mdview app was using a manual rAF + ref +
innerHTML hack unnecessarily. This is an app bug, not a framework issue. mdview
should be refactored to use
`<article dangerouslySetInnerHTML={{ __html: html }} />`.

---

## ~~AIO-64: No persistent instance state~~ RETRACTED — `useRef` supports multiple calls

**RETRACTED:** AIR's `useRef` DOES support multiple calls per component and
persists across re-renders (documented in renderer.md: "Multiple `useRef` calls
maintain independent identity across re-renders"). The mdview static-property
pattern is an app-level mistake — should be refactored to use `useRef`.

---

## ~~AIO-65: No `useEffect` post-render hook~~ RETRACTED — `effect()` + `onMount`/`onCleanup` cover this

**RETRACTED:** AIR provides:

- `effect(() => ...)` — auto-tracked deps, cleanup via return value (replaces
  `useEffect` with deps)
- `onMount(() => ...)` — runs once after first render (replaces
  `useEffect(fn, [])`)
- `onCleanup(() => ...)` — runs before re-render + unmount (replaces useEffect
  cleanup)

The mdview code uses manual flags and rAF because it wasn't written using these
APIs. App should be refactored to use `onMount` for global event registration
and `effect()` for reactive side effects.

---

## ~~AIO-66: `useLocal` API requires full object replacement for single-field updates~~ ✅ RESOLVED

**Fixed:** `useLocal` in `src/adapters/air.ts` now returns `patch(partial)` for
merging partial object updates and `set()` accepts an updater function
`(prev) => next`. Example: `search.patch({ query: value })` instead of
`search.set({...search.local, query: value})`.

---

## ~~AIO-67: `useFeature` type inference broken — requires `as any` double-cast~~ ✅ RESOLVED

**Fixed:** `useFeature` signature in `src/browser-air.ts` now accepts
`FeatureRef & { __aio: { state?: S } }` — TypeScript infers `S` from the feature
definition's state type. `useFeature(myFeature)` returns
`{ state: MyState; send: ... }` without casts.

---

## ~~AIO-68: Boolean HTML attributes~~ RETRACTED — docs show correct handling

**RETRACTED:** AIR docs show `disabled` and `checked` working correctly in
examples (e.g., `disabled={!form.valid}`, `checked={t.done}`). Boolean attribute
handling appears correct.

---

## ~~AIO-69: No `key` prop warnings for array rendering~~ ✅ RESOLVED

**Fixed:** `diffChildren` in `src/vdom.ts` now warns in dev mode when 3+
same-tag element children have no keys (likely a `.map()` result). Complements
existing mixed-keys and duplicate-keys warnings.

---

## ~~AIO-70: `useRef`, `onMount`, `onCleanup` not exported from main `aio` import (MEDIUM)~~ ✅ RESOLVED

**Fixed:** Added re-exports to `browser-air.ts` for all AIR renderer primitives:
`createContext`, `useContext`, `useRef`, `onMount`, `onCleanup`, `mount`,
`hydrate`, `h`, `signal`, `computed`, `effect`, `batch` plus their types
(`MountHandle`, `Context`, `Signal`, `Computed`, `VNode`, `VChild`,
`ComponentFn`). Apps can now import everything from `'aio'`.

---

## AIO-71: Suggestions — ideas to make AIO/AIR best-in-class

**Category:** Enhancement / DX

These aren't bugs — AIO works. These are opportunities to make it genuinely
better than anything else out there.

### 1. `useSignal` shorthand for component-scoped signals (HIGH VALUE)

Currently: `signal()` lives outside components (module scope). `useLocal()` is
for server-disconnected state. There's no idiomatic way to create a
component-scoped signal that auto-disposes on unmount.

```tsx
// Proposed:
const count = useSignal(0); // auto-disposed on unmount
const items = useSignal<Item[]>([]); // typed, scoped to this component instance

// Currently: either module-level signal (shared) or useLocal (object-only, no .value)
```

Why: Solid.js's `createSignal` is component-scoped by default. AIO should match
this ergonomic.

### 2. `afterRender(fn)` hook — post-DOM-update callback (HIGH VALUE)

`effect()` runs immediately (before DOM update). `onMount` runs once. Neither
gives "run code after this render's DOM update" — the most common need for
imperative DOM work (measuring, scrolling, focusing).

```tsx
// Proposed:
afterRender(() => {
  el.scrollTo(0, target); // DOM is guaranteed updated
});

// Currently: requestAnimationFrame(() => { ... }) — works but not framework-managed
```

Why: This is the #1 pattern that forces ugly rAF workarounds. React's
`useLayoutEffect` fills this gap.

### 3. Derived `.patch()` on `useFeature` send (MEDIUM VALUE)

For features with complex state, updating one field requires a dedicated method:

```tsx
// Current — every field change needs a method in the feature:
send.setZoom(120);
send.setScroll(500);
send.setError(null);

// Proposed — generic patch for simple assignments:
send.$patch({ zoom: 120 });
send.$patch({ scrollY: 500, error: null });
```

Why: Reduces boilerplate methods in feature definitions. 80% of methods are just
`(s, val) => { s.field = val }`.

### 4. Built-in `innerHTML` prop with post-render hook (MEDIUM VALUE)

`dangerouslySetInnerHTML` sets content but doesn't let you post-process it.
Common need: set HTML then modify DOM (neutralize links, add highlights). A
combined API:

```tsx
<article
  dangerouslySetInnerHTML={{ __html: html }}
  onInnerHTML={(el) => {
    // Runs after innerHTML is set, before paint
    neutralizeLinks(el);
    highlightMatches(el, query);
  }}
/>;
```

Why: Eliminates the rAF + ref + innerHTML dance that caused our infinite render
loop.

### 5. `@types/react` removal — ship types standalone (LOW VALUE but clean)

AIO-62 added custom JSX types. But apps still need `@types/react` in deno.json
for some type resolution. AIO should be fully self-contained — zero React
footprint, even in types.

### 6. `effect()` should warn on sync signal writes during render (LOW VALUE)

If `effect()` is called in a component body and it synchronously calls `.set()`,
it can trigger unexpected re-renders. Dev-mode warning:

```
[aio] Warning: effect() in <Article> called signal.set() synchronously during render.
This may cause unnecessary re-renders. Use batch() or move to onMount().
```

### 7. Feature method error context (LOW VALUE)

When a method throws, include the method name and feature name in the error:

```
// Current:
[REDUCE_ERROR] mdview 'ownKeys' on proxy: trap returned extra keys...

// Better:
[REDUCE_ERROR] mdview.navigateTo() failed: 'ownKeys' on proxy...
  Triggered by: send.navigateTo("./other.md", 300)
```

### 8. Hot module replacement for features (ASPIRATIONAL)

When a feature's methods change during dev, hot-swap them without losing state.
esbuild supports HMR boundaries — AIO could register features as HMR-aware
modules.

Why: Currently, any code change reloads the entire app and loses state. Feature
HMR would make dev iteration instant.

---

## AIO-72: Practical API improvements — "React syntax, AIO magic" (SUGGESTIONS)

**Category:** DX / API Design

**Goal:** A React developer should be able to write AIO code on day one using
familiar patterns. AIO should eliminate what's unnecessary, automate what it
can, and never force the developer to think about framework internals.

### ~~MUST-HAVE: One import, everything works~~ ✅ DONE

> **Resolved** by `src/air.ts` and `src/react.ts` barrel exports. All AIR
> primitives (`useRef`, `onMount`, `onCleanup`, `effect`, `computed`, `signal`,
> `batch`) are now re-exported from `aio/air` and `aio/react` — no more deep
> internal imports.

```tsx
// Current — two imports, one into framework internals:
import { useFeature, useLocal } from "aio";
import {
  onCleanup,
  onMount,
  useRef,
} from "../../../../dep/aio/src/aio-renderer.ts";

// Expected — one import, everything a component needs:
import {
  batch,
  computed,
  effect,
  onCleanup,
  onMount,
  signal,
  useFeature,
  useLocal,
  useRef,
} from "aio";
```

This is AIO-70 but worth repeating: if I can't import it from `'aio'`, it
doesn't exist for the developer.

### ~~MUST-HAVE: `useState` alias for `useLocal`~~ ✅ DONE

> **Resolved** by `src/compat.ts` — exports `useState` backed by signals,
> providing the familiar `[value, setter]` tuple over `signal(initial)`.

```tsx
// React muscle memory — should just work in AIO:
const [count, setCount] = useState(0);
const [open, setOpen] = useState(false);

// AIO implementation: thin wrapper over signal
function useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const sig = signal(initial);
  return [sig.value, sig.set]; // .value auto-tracks, .set updates
}
```

`useLocal` stays for object state with `.patch()`. `useState` covers the 90%
case of simple values. React devs feel at home instantly.

### ~~MUST-HAVE: `useEffect` alias for common effect patterns~~ ✅ DONE

> **Resolved** by `src/compat.ts` — exports `useEffect` mapped to
> `onMount`/`effect` with return-cleanup support.

```tsx
// Should work — alias to effect() with onCleanup integration:
useEffect(() => {
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler); // cleanup
});

// AIO already has this via effect() — just needs the alias + export
```

No dependency arrays needed (AIO auto-tracks). The return-cleanup pattern should
work. This is purely a naming/export issue — the machinery exists.

### ~~NICE-TO-HAVE: `useCallback` and `useMemo` as no-ops~~ ✅ DONE

> **Resolved** by `src/compat.ts` — both exported as zero-cost pass-throughs:
> `useCallback` returns the function, `useMemo` calls and returns the factory
> result.

```tsx
// These should compile and run, even though AIO doesn't need them:
const handler = useCallback(() => send.increment(), []); // just returns the function
const total = useMemo(() => items.length, [items]); // just calls the function

// AIO implementation:
const useCallback = <T,>(fn: T, _deps?: unknown[]) => fn;
const useMemo = <T,>(fn: () => T, _deps?: unknown[]) => fn();
```

Zero runtime cost. Zero confusion for React migrants. The linter could
optionally suggest removing them.

### NICE-TO-HAVE: Familiar event handler names

AIO uses native DOM events (`onInput`, `onKeydown`). React uses camelCase
(`onChange`, `onKeyDown`). Both should work:

```tsx
// React habit:
<input onChange={handler} onKeyDown={handler} />

// AIO native:
<input onInput={handler} onKeydown={handler} />

// Both should work — AIO normalizes at the vdom layer
```

Note: `onChange` vs `onInput` is a real semantic difference (React's onChange
fires on every keystroke, DOM's doesn't). AIO should document this clearly and
ideally make `onChange` behave like React's (fire on every input) for a smoother
migration.

### NICE-TO-HAVE: Auto-cleanup for event listeners in `onMount`

Pattern we wrote 4 times in MdviewPage:

```tsx
onMount(() => {
  const handler = (e: KeyboardEvent) => { ... }
  document.addEventListener('keydown', handler)
  onCleanup(() => document.removeEventListener('keydown', handler))
})
```

Could be simplified:

```tsx
// Proposed helper:
onMount(() => {
  // Returns cleanup automatically:
  useEventListener(document, 'keydown', (e) => { ... })
  useEventListener(document, 'wheel', (e) => { ... }, { passive: false })
  // All cleaned up automatically on unmount
})
```

### WISH: Smart `dangerouslySetInnerHTML` with post-render callback

```tsx
// Current — manual rAF dance:
const elRef = useRef(null!);
requestAnimationFrame(() => {
  elRef.current.innerHTML = html;
  neutralizeLinks(elRef.current);
});
return <article ref={elRef} />;

// Proposed — declarative with post-process hook:
return (
  <article
    dangerouslySetInnerHTML={{ __html: html }}
    onContentReady={(el) => neutralizeLinks(el)}
  />
);
```

The renderer calls `onContentReady` after setting innerHTML, in the same
microtask — no rAF needed, no timing issues.

### WISH: Type-safe `send` from `useFeature`

```tsx
// Current — send methods are Record<string, (...args: unknown[]) => void>
send.navigateTo(href, scrollY); // no type checking on args

// Proposed — infer method signatures from feature definition:
send.navigateTo(href, scrollY); // TS error if wrong arg types
send.nonExistent(); // TS error — method doesn't exist
```

The feature definition has full type info
(`methods: { navigateTo(s: State, path: string, scrollY: number) }`). The send
proxy should propagate those types minus the first `state` arg.

### Core principle: React ↔ AIR migration should be mechanical

**React → AIR:** Take React code, delete what AIR handles automatically. It
should compile and run. No rewriting, no renaming, no restructuring.

**AIR → React:** Add back what React needs (dep arrays, memo wrappers,
useCallback). Again mechanical — no architectural changes.

**In practice this breaks because of:**

1. **Different names for same thing:** `useLocal` vs `useState`, `onMount` vs
   `useEffect(fn, [])`, `onCleanup` vs useEffect return. A React dev doesn't
   know to look for `onMount` — they type `useEffect` and get "not found".

2. **Different event semantics:** React's `onChange` fires on every keystroke.
   DOM's `onChange` fires on blur. AIR uses DOM semantics. A migrated React form
   silently breaks — inputs don't update as you type. This is the #1 migration
   trap.

3. **Missing no-ops:** React code has `useCallback`, `useMemo`, `React.memo`
   everywhere. In AIR these are unnecessary but they shouldn't ERROR — they
   should just work (as no-ops) so migrated code compiles immediately. The
   linter can suggest removing them later.

4. **Import paths:** React:
   `import { useState, useEffect, useRef } from 'react'`. AIR: some from
   `'aio'`, some from deep paths. Migration requires hunting for import sources.

5. **State API shape:** React `const [val, setVal] = useState(0)`. AIR
   `const s = useLocal(0); s.local; s.set()`. Array destructuring vs object —
   every useState line needs rewriting.

6. **Effect cleanup pattern:** React
   `useEffect(() => { setup(); return () => cleanup() }, [])`. AIR separates
   into `onMount(() => { setup(); onCleanup(() => cleanup()) })`. Nesting is
   different.

**The fix is NOT "make AIR identical to React"** — AIR is genuinely better
(auto-tracking, no stale closures, no dep arrays). The fix is:

- **Accept React syntax as valid AIR:** `useState`, `useEffect`, `useCallback`,
  `useMemo`, `React.memo`, `onChange` should all work. Under the hood, AIR
  handles them better. The developer discovers AIR's advantages naturally — they
  don't need to learn a new API to get started.
- **AIR-specific APIs are additive:** `useLocal.patch()`, `signal()`,
  `computed()`, `effect()` are AIR extras. Available but never required. A React
  developer can be productive without knowing they exist.
- **Linter guides migration:** `aiol` can suggest: "useCallback is unnecessary
  in AIR — remove for cleaner code" or "dependency array in useEffect is ignored
  — AIR auto-tracks". Gradual, not forced.

### Concrete compatibility layer

```tsx
// These should ALL work in AIR, imported from 'aio':

// React-compatible (thin wrappers):
const [count, setCount] = useState(0)              // → signal under hood
const [items, setItems] = useState<Item[]>([])      // → signal
useEffect(() => { ... return cleanup }, [])          // → onMount + onCleanup
useEffect(() => { ... return cleanup })              // → effect + cleanup
const ref = useRef<HTMLElement>(null)                // → AIR useRef
const memoized = useMemo(() => expensive(), [dep])   // → just calls fn (auto-tracked)
const handler = useCallback(() => send.inc(), [])    // → just returns fn

// AIR-native (available but optional):
const count = signal(0)                              // module-scoped reactive
const doubled = computed(() => count.value * 2)      // auto-tracked derived
effect(() => { ... })                                // auto-tracked side effect
const search = useLocal({ query: '', open: false })  // object state with .patch()
search.patch({ query: 'test' })                      // partial update
```

### Migration test

The ultimate test: take any React component from a tutorial, paste it into an
AIR app, change the import from `'react'` to `'aio'`. It should:

1. **Compile** — no missing exports, no type errors
2. **Run correctly** — same behavior, same output
3. **Be optimizable** — linter suggests removing unnecessary hooks

If this test fails for any standard React pattern, that's a bug.

### Summary table

| Priority | What                                            | Why                                       |
| -------- | ----------------------------------------------- | ----------------------------------------- |
| MUST     | Single `'aio'` import for all hooks             | Can't use what you can't import           |
| MUST     | `useState(init)` → `[value, setter]`            | Array destructuring compat, zero rewrite  |
| MUST     | `useEffect(fn, deps?)` accepting React patterns | Most-used hook, must just work            |
| MUST     | `useCallback`/`useMemo` as working no-ops       | Migrated code compiles instantly          |
| MUST     | `onChange` on inputs = fires every keystroke    | #1 silent migration bug                   |
| NICE     | `useEventListener` helper                       | Eliminates add/remove/cleanup boilerplate |
| NICE     | Linter rules for "unnecessary in AIR"           | Guides cleanup, not forced                |
| WISH     | `onContentReady` on innerHTML elements          | Kills the rAF post-render pattern         |
| WISH     | Type-safe `send` methods                        | Full end-to-end type safety               |
