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
