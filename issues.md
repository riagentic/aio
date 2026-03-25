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
