# AIO Diagnostic Bus & Error DX Overhaul — Design Spec

**Date:** 2026-03-24 **Status:** Draft **Scope:** Three-layer error DX overhaul

**Review Status:** Revised after spec review — addressed C1 (dual notification),
C2 (error objects), C3 (double fetch), I1-I7 improvements, S1-S4 suggestions.

---

## Problem

AIO has two failure modes that destroy developer experience:

1. **Opaque errors** — `TypeError: Failed to fetch dynamically imported module`
   tells the developer nothing. The real cause (transpile error, missing import,
   syntax error) is buried.
2. **Silent failures** — app loads, UI renders, but nothing works. No errors in
   console, no overlay, no indication. Actions silently dropped (queue overflow,
   machine guard, beforeReduce null), state sync silently fails (WS parse error,
   delta patch strips keys), effects silently vanish (structuredClone failure,
   invalid type). **18 identified silent failure points.**

Both violate the error infrastructure principle: _"errors are never swallowed."_

## Mission

**Every failure — loud or silent — must be visible, diagnosable, and actionable
in dev mode. Zero silent failures. Zero generic error messages. Every error
shows root cause + fix hint.**

---

## Architecture — Three Layers

```
Layer 1: Smart Module Loader     → fixes opaque import errors
Layer 2: Diagnostic Bus + Overlay → infrastructure for surfacing ALL silent failures
Layer 3: Silent Failure Fixes     → 18 code sites emit to the bus instead of swallowing
```

Each layer is independently useful and ships incrementally.

---

## Layer 1: Smart Module Loader

### Problem

`server-html.ts:157` does a raw `import('/App.tsx?v=...')`. When this fails, the
browser throws a generic
`TypeError: Failed to fetch dynamically imported module`. The current
`classifyBrowserError()` has no pattern for this — it falls through to
`"unknown"` with no fix.

The actual root cause could be:

- Server not running (network error)
- File not found (404)
- Transpile error (server returns `throw new Error(...)` as JS)
- Runtime error in module body (import succeeds but module throws during
  evaluation)
- Missing npm import (no import map entry)
- Circular dependency (timeout)

### Design

Replace the raw `import()` in the HTML template with a
**pre-validate-then-import** flow:

```
1. fetch('/App.tsx?v=...') as text
2. Check HTTP status:
   - 404 → "App.tsx not found — create src/App.tsx"
   - 500 → extract server error from response
   - 200 but body contains 'throw new Error(' → extract transpile error
   - 200 clean → proceed to import()
3. If import() still fails → fetch /__aio/error for structured data
4. Render rich error with: root cause → what you see → how to fix
```

### Changes

**`server-html.ts` — HTML template (`generateHTML`)**

Replace lines 156-219 with smart loader:

```ts
// Inside the dev <script type="module"> block:
class AioLoadError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "AioLoadError";
    this._aio = true;
    Object.assign(this, detail); // { status, body, transpileError }
  }
}
const moduleUrl = "/App.tsx?v=" + Date.now();
try {
  // Pre-validate: fetch as text to detect server-side errors before import()
  const pre = await fetch(moduleUrl);
  if (!pre.ok) {
    throw new AioLoadError(
      "Module pre-validation failed (HTTP " + pre.status + ")",
      { status: pre.status, body: await pre.text() },
    );
  }
  const src = await pre.text();
  // Detect server-injected throw (transpile error wrapped as JS)
  if (src.trimStart().startsWith("throw new Error(")) {
    const msg = src.match(/throw new Error\("(.+)"\)/s)?.[1]
      ?.replace(/\\n/g, "\n")?.replace(/\\"/g, '"') ?? src;
    throw new AioLoadError("Transpile error", {
      status: 200,
      transpileError: true,
      body: msg,
    });
  }
  // Source is clean — import via Blob URL to avoid double-fetch
  // (fetch() and import() use separate caches; Blob URL guarantees single fetch)
  // Note: stack traces show blob: URLs instead of file URLs in this path,
  // but the error overlay maps them back via /__aio/error structured data.
  const blob = new Blob([src], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const { default: App } = await import(blobUrl);
    createRoot(document.getElementById("root")).render(createElement(App));
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
} catch (e) {
  // ... rich error rendering (see below)
}
```

**Note on Blob URL trade-off:** Blob URLs eliminate the double-fetch problem but
lose the original file URL in stack traces. For dev mode this is acceptable
because: (a) transpile errors are caught before import and show file:line from
esbuild, (b) runtime errors in module body are rare and the developer can check
DevTools Sources. If this proves problematic, we can fall back to the
double-fetch approach (fetch + import same URL) with a comment acknowledging the
cost is acceptable for dev-only code.

**`server-html.ts` — `classifyBrowserError()`**

Add new pattern at the top of the function:

```ts
// "Failed to fetch dynamically imported module" — browser's generic import error
if (message.includes("Failed to fetch dynamically imported module")) {
  return {
    classification: "dynamic-import-failed",
    label: "Module Load Error",
    fix:
      "The browser could not load App.tsx. Check the terminal for transpile errors, " +
      "or verify the dev server is running (deno task dev).",
  };
}
```

**`server-html.ts` — rich error renderer**

Enhance the catch block to handle `_aio`-tagged errors (from pre-validation)
separately from generic errors:

```ts
catch (e) {
  console.error('[aio] App load failed:', e)
  let label, body, fixText

  if (e && e._aio) { // AioLoadError from pre-validation
    // Pre-validation caught the real error
    if (e.status === 404) {
      label = 'File Not Found'
      body = mkMessage('App.tsx does not exist')
      fixText = 'Create src/App.tsx with a default export React component.'
    } else if (e.transpileError) {
      label = 'Build Error'
      // Fetch structured error data from server
      const r = await fetch('/__aio/error')
      const errData = r.ok ? await r.json().catch(() => null) : null
      body = errData?.errors?.length ? mkBuildErrors(errData.errors) : mkMessage(e.body)
      fixText = '' // build errors are self-explanatory with file:line:col
    } else {
      label = 'Server Error'
      body = mkMessage('Server returned HTTP ' + e.status + ':\n' + e.body)
      fixText = 'Check terminal for server errors.'
    }
  } else {
    // Runtime error during module evaluation or import
    const r = await fetch('/__aio/error')
    const errData = r.ok ? await r.json().catch(() => null) : null
    const hasServerErr = errData?.errors?.length
    label = hasServerErr ? 'Build Error' : 'Runtime Error'
    body = hasServerErr ? mkBuildErrors(errData.errors) : mkStack(e?.stack)
    // Classify for fix hint
    try {
      const cr = await fetch('/__aio/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: e?.message, stack: e?.stack })
      })
      if (cr.ok) {
        const c = await cr.json()
        if (c.fix) fixText = c.fix
        if (c.label) label = c.label
      }
    } catch {}
  }
  // Render overlay (same styling as current, with label/body/fixText)
  // ...
}
```

**`server.ts` — per-file error storage**

Replace the global `lastErrorData` with a per-file map:

```ts
// Before: let lastErrorData: { errors: ... } | null = null
// After:
const errorMap = new Map<string, { errors: EsbuildMessage[]; ts: number }>()

// In transpile catch:
errorMap.set(filename, { errors: [...], ts: Date.now() })

// In /__aio/error endpoint:
// Return all recent errors (last 30s), not just the last one
const cutoff = Date.now() - 30_000
const allErrors = [...errorMap.values()]
  .filter(e => e.ts > cutoff)
  .flatMap(e => e.errors)
return new Response(JSON.stringify({ errors: allErrors }), ...)

// On successful transpile, clear that file's errors:
errorMap.delete(filename)

// Periodic cleanup: on each transpile, evict stale entries (> 60s)
const staleThreshold = 60_000
for (const [f, e] of errorMap) {
  if (Date.now() - e.ts > staleThreshold) errorMap.delete(f)
}
```

---

## Layer 2: Diagnostic Bus + Health Overlay

### Problem

When the app loads but doesn't work, there is **zero indication** of what went
wrong. Actions silently dropped, state sync silently failed, effects silently
vanished.

### Design: `DiagnosticBus`

A lightweight, synchronous event emitter that lives in both server and browser
runtimes. All silent failure points emit structured events to the bus. In dev
mode, the browser overlay subscribes and shows accumulated warnings.

**In prod, the bus is a runtime no-op** — `diagEmit` returns immediately when
`_dev` is false. This is a cheap boolean check, not a compile-time tree-shake.
The bus code is present in the bundle but does zero work. If zero-bundle-size is
needed later, we can add esbuild `define: { '__AIO_DEV__': 'false' }` — but the
runtime guard is sufficient for v1.

### Integration with `reportAioError`

**Key design decision:** `reportAioError()` in `src/error.ts` auto-emits to the
diagnostic bus. This means code sites that already call `reportAioError` do NOT
need a separate `diagEmit` call. Only truly new events (browser-side drops,
state sync errors, etc. that have no corresponding `AioErrorCode`) use
standalone `diagEmit`.

```ts
// src/error.ts — inside reportError(), add at the end:
diagEmit({
  type: codeToEventType(err.code), // e.g. REDUCE_ERROR → 'reduce-failed'
  severity: codeToSeverity(err.code),
  source: err.source,
  message: err.message,
  detail: { code: err.code, ...err.context },
  hint: getTip(err.code, err.context),
});
```

This eliminates dual notification. The bus is the **subscriber** of the error
pipeline, not parallel to it. Layer 3 items 3.3, 3.4, 3.5, 3.6, 3.10, 3.15, 3.18
already call `reportAioError` and will automatically appear on the bus. Only
items 3.1, 3.2, 3.7, 3.8, 3.9, 3.11, 3.12, 3.13, 3.14, 3.16, 3.17 need
standalone `diagEmit` calls (these are browser-side or have no existing
`AioErrorCode`).

### Types

```ts
// src/diagnostic-bus.ts

type DiagnosticSeverity = "error" | "warning" | "info";

type DiagnosticEvent = {
  type: string; // e.g. 'action-dropped', 'state-sync-error', 'effect-dropped'
  severity: DiagnosticSeverity;
  source: string; // e.g. 'dispatch', 'browser', 'feature-compose'
  message: string; // human-readable
  detail?: unknown; // structured data (action type, queue depth, etc.)
  ts: number; // Date.now()
  hint?: string; // actionable fix suggestion
  docLink?: string; // link to specific error docs section
};
```

### Bus Implementation

**Single file `src/diagnostic-bus.ts`** — works in both server and browser
runtimes. No Deno APIs used (only `Date.now()`, arrays, callbacks). Browser
imports the same file.

```ts
// src/diagnostic-bus.ts

type DiagnosticListener = (event: DiagnosticEvent) => void;

const RING_CAP = 200;
const DEDUP_WINDOW = 5_000; // don't emit same type more than once per 5s

let _listeners = new Set<DiagnosticListener>();
let _ring: DiagnosticEvent[] = [];
let _head = 0;
let _count = 0;
let _dev = false;
let _lastEmitByType = new Map<string, number>();

export function initDiagnosticBus(dev: boolean): void {
  _dev = dev;
}

export function diagEmit(event: Omit<DiagnosticEvent, "ts">): void {
  if (!_dev) return;
  // Dedup: skip if same type emitted within window
  const now = Date.now();
  const last = _lastEmitByType.get(event.type);
  if (last && now - last < DEDUP_WINDOW) return;
  _lastEmitByType.set(event.type, now);

  const full: DiagnosticEvent = { ...event, ts: now };
  // Circular ring buffer — O(1) insert, no shift()
  _ring[_head] = full;
  _head = (_head + 1) % RING_CAP;
  if (_count < RING_CAP) _count++;

  for (const fn of _listeners) fn(full);
}

export function diagSubscribe(fn: DiagnosticListener): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

export function diagRecent(): DiagnosticEvent[] {
  if (_count < RING_CAP) return _ring.slice(0, _count);
  // Circular: head..end + start..head
  return [..._ring.slice(_head), ..._ring.slice(0, _head)];
}
```

### Server → Browser Forwarding

Server-side diagnostic events are forwarded to connected dev browsers via the
existing WS using the `__diag:` message prefix.

**WS message prefix registry** (documented in `server.ts`):

- `__reload` — trigger page reload
- `__css` — CSS-only hot reload
- `__boot:<id>` — boot ID for session tracking
- `__tt:<json>` — time-travel state
- `__vitals:<json>` — vital signs data
- `__diag:<json>` — diagnostic bus events (**new**)

```ts
// server.ts — subscribe to bus, forward to dev clients:
if (!prod) {
  diagSubscribe((ev) => {
    const msg = "__diag:" + JSON.stringify(ev);
    for (const ws of devClients) {
      try {
        ws.send(msg);
      } catch { /* client gone */ }
    }
  });
}
```

Browser receives and feeds into its local bus instance:

```ts
// browser.ts — in WS message handler:
if (line.startsWith("__diag:")) {
  try {
    const ev = JSON.parse(line.slice(7));
    _diagBus.push(ev); // local ring buffer
    _renderHealthIndicator();
  } catch {}
  return;
}
```

### Health Overlay

Three UI states, non-intrusive:

**1. Healthy (green dot)** — corner indicator, 8px circle, position: fixed
bottom-right. Visible only when at least one diagnostic event has been received
(so it doesn't appear on apps with zero issues). Click to expand panel.

**2. Warnings (yellow dot + count badge)** — same position, pulsing yellow dot
with count of unread warnings. Click to expand.

**3. Errors (red dot + count badge)** — same, red, for error-severity events.

**Expanded panel** — slide-up from bottom-right, max 400px wide, 300px tall,
scrollable list of recent events. Each event shows:

- Severity icon (colored dot)
- Type + source
- Message
- Hint (if present, green text)
- Timestamp (relative, e.g. "2s ago")
- Dismiss button per event

**Panel is dev-mode only.** Injected by `generateHTML` in the template,
alongside the existing error overlay code. Uses the same dark theme.

The panel does NOT replace the full-page error overlay for fatal errors (Layer
1). It supplements it for non-fatal issues that accumulate while the app is
running.

**DOM implementation sketch** (injected by `generateHTML` in the dev template):

```ts
// Health indicator — 8px fixed dot, bottom-right corner
const _diagDot = document.createElement("div");
Object.assign(_diagDot.style, {
  position: "fixed",
  bottom: "12px",
  right: "12px",
  zIndex: "99999",
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  background: "#2a2",
  cursor: "pointer",
  display: "none",
  transition: "background .3s, transform .3s",
  boxShadow: "0 0 4px rgba(0,0,0,.3)",
});
document.body.appendChild(_diagDot);

// Count badge — positioned above dot
const _diagBadge = document.createElement("div");
Object.assign(_diagBadge.style, {
  position: "absolute",
  top: "-8px",
  right: "-4px",
  fontSize: "9px",
  background: "#e25",
  color: "#fff",
  borderRadius: "6px",
  padding: "0 3px",
  lineHeight: "14px",
  display: "none",
});
_diagDot.appendChild(_diagBadge);

// Panel — slide-up, max 400x300, dark theme
const _diagPanel = document.createElement("div");
Object.assign(_diagPanel.style, {
  position: "fixed",
  bottom: "28px",
  right: "12px",
  zIndex: "99998",
  width: "400px",
  maxHeight: "300px",
  overflow: "auto",
  background: "#1a1a1a",
  border: "1px solid #333",
  borderRadius: "8px",
  font: "12px/1.6 monospace",
  color: "#ccc",
  display: "none",
  boxShadow: "0 4px 16px rgba(0,0,0,.5)",
});
document.body.appendChild(_diagPanel);

let _diagEvents = []; // local ring buffer
let _unread = 0;

_diagDot.onclick = () => {
  const show = _diagPanel.style.display === "none";
  _diagPanel.style.display = show ? "block" : "none";
  if (show) {
    _unread = 0;
    _updateDot();
  }
};

function _renderHealthIndicator() {
  if (!_diagEvents.length) return;
  _diagDot.style.display = "block";
  _updateDot();
  _renderPanel();
}

function _updateDot() {
  const hasErr = _diagEvents.some((e) => e.severity === "error");
  const hasWarn = _diagEvents.some((e) => e.severity === "warning");
  _diagDot.style.background = hasErr ? "#e25" : hasWarn ? "#ea0" : "#2a2";
  _diagBadge.style.display = _unread > 0 ? "block" : "none";
  _diagBadge.textContent = String(_unread);
}

function _renderPanel() {
  const cutoff = Date.now() - 60_000; // auto-dismiss > 60s
  _diagEvents = _diagEvents.filter((e) => e.ts > cutoff);
  _diagPanel.innerHTML = _diagEvents.map((ev) => {
    const color = ev.severity === "error"
      ? "#e25"
      : ev.severity === "warning"
      ? "#ea0"
      : "#888";
    const age = Math.round((Date.now() - ev.ts) / 1000);
    return '<div style="padding:6px 10px;border-bottom:1px solid #2a2a2a">' +
      '<span style="color:' + color + '">\u25CF</span> ' +
      "<b>" + esc(ev.type) + '</b> <span style="color:#555">' + age +
      "s ago</span>" +
      '<div style="color:#aaa;margin:2px 0">' + esc(ev.message) + "</div>" +
      (ev.hint
        ? '<div style="color:#98c379;font-size:11px">\u2192 ' + esc(ev.hint) +
          "</div>"
        : "") +
      "</div>";
  }).join("");
}

// Auto-refresh panel every 10s to update relative timestamps
setInterval(() => {
  if (_diagPanel.style.display !== "none") _renderPanel();
}, 10_000);
```

### Diagnostic Bus → Existing Infrastructure Integration

**Error pipeline bridge** (Layer 2 ↔ error.ts): `reportAioError()` auto-emits to
the bus. This means all existing `AioError` events (reduce, effect, flow, hook,
init, destroy, queue, dispatch, memory, vitals) automatically surface in the
health overlay. No dual calls needed.

**Diagnostics module** (diagnostics/mod.ts): optionally subscribes to the bus
for structured logging to log files:

```ts
// diagnostics/mod.ts — optional integration
if (opts.diagnosticBus !== false) {
  diagSubscribe((ev) => {
    if (ev.severity === "error") log.error("diag", ev.message);
    else if (ev.severity === "warning") log.warn("diag", ev.message);
  });
}
```

**Vitals** (vitals/mod.ts): already has its own alert system (`fireAlert()`).
The vitals alerts should also emit to the bus for unified visibility:

```ts
// vitals/mod.ts — in fireAlert():
diagEmit({
  type: "vitals-alert",
  severity: alert.severity === "frozen" ? "error" : "warning",
  source: "vitals",
  message: alert.message,
  hint: alert.hints?.[0]?.message,
});
```

---

## Layer 3: Silent Failure Remediation

### Priority Order

Each fix replaces a silent catch/drop with a `diagEmit()` call. Ordered by
severity.

### CRITICAL — Must Ship

#### 3.1 Action Queue Overflow (`browser.ts:803-814`)

**Current:** Actions silently dropped when WS queue > 100 or offline queue

> 100. **Fix:**

```ts
// browser.ts _send() — where actions are currently silently dropped:
} else if (!_wasConnected && _queue.length < WS_MAX_QUEUE) {
  _queue.push(action)
} else if (_wasConnected) {
  if (_offlineQueue.length < OFFLINE_MAX_QUEUE) {
    _offlineQueue.push(action)
    _saveOfflineAction(action).catch(() => {})
  } else {
    // NEW: emit instead of silent drop
    _diagEmit({
      type: 'action-dropped', severity: 'warning', source: 'browser',
      message: `Action '${action.type}' dropped — offline queue full (${OFFLINE_MAX_QUEUE})`,
      detail: { actionType: action.type, queueSize: _offlineQueue.length },
      hint: 'Check network connection. Actions are queued when disconnected but the queue has a limit.',
    })
  }
} else {
  // NEW: emit instead of silent drop
  _diagEmit({
    type: 'action-dropped', severity: 'warning', source: 'browser',
    message: `Action '${action.type}' dropped — connect queue full (${WS_MAX_QUEUE})`,
    detail: { actionType: action.type, queueSize: _queue.length },
    hint: 'Server may be slow to respond. Check terminal for errors.',
  })
}
```

#### 3.2 WS/IPC JSON Parse Failure (`browser.ts:596-597`)

**Current:** `console.warn("[aio] bad state message:", err)` — state not
updated. **Fix:**

```ts
} catch (err) {
  console.warn('[aio] bad state message:', err)
  _diagEmit({
    type: 'state-sync-error', severity: 'error', source: 'browser',
    message: 'Failed to parse state message from server',
    detail: { error: String(err), rawLength: line?.length },
    hint: 'Server sent malformed state. This usually indicates a serialization bug on the server side.',
  })
}
```

#### 3.3 Reduce Error — Action Dropped (`dispatch.ts` reduce catch)

**Current:** `reportAioError` called — already has error infrastructure.
**Fix:** No standalone `diagEmit` needed. `reportAioError` auto-emits to bus
(see Layer 2 integration). The bus event type mapping: `REDUCE_ERROR` →
`reduce-failed`, severity `error`. Hint from existing `getTip()`: checks for
wrong machine state, undefined property access.

#### 3.4 Effects Dropped — structuredClone Failure (`dispatch.ts` clone catch)

**Current:** `reportAioError` called with `EFFECT_ERROR`. **Fix:** Auto-emits
via `reportAioError` → bus bridge. Mapped as `effect-error`, severity `error`.
Ensure the existing tip for `EFFECT_ERROR` includes the structuredClone hint:
_"Effects contain non-cloneable values (Immer draft refs, functions). Return
plain objects."_

#### 3.5 Feature Init Failure (`feature-compose.ts` init catch)

**Current:** Error logged but **no `reportAioError` call** — only `log.error()`.
**Fix:** Add `reportAioError` with `INIT_ERROR` code (which auto-emits to bus):

```ts
const err = createAioError("INIT_ERROR", e, { featureName });
reportAioError(err, _reportOpts);
```

This gives us bus emission, `onError` hook, TT marking, and console formatting —
all from one call. The existing `INIT_ERROR` tip should include: _"Feature
continues accepting actions but may behave incorrectly."_

#### 3.6 Persist Failure (`aio.ts` persist catch)

**Current:** Error caught but **no `reportAioError` call**. **Fix:** Add a new
`AioErrorCode`: `PERSIST_ERROR` (source: `'persist'`).

```ts
const err = createAioError("PERSIST_ERROR", e, {});
reportAioError(err, _reportOpts);
```

Add `PERSIST_ERROR` to the `AioErrorCode` union in `src/error.ts`, with:

- Source: `'persist'`
- Tip: _"Failed to persist state. Changes are in memory but will be lost on
  restart. Check disk space and file permissions."_

### HIGH — Should Ship

#### 3.7 Machine Guard Silent Drop (`feature-compose.ts:236-254`)

**Current:** In prod mode, only `log.debug`. Action silently ignored. **Fix:**

```ts
diagEmit({
  type: "action-guarded",
  severity: "info",
  source: "feature-compose",
  message:
    `'${action.type}' blocked — machine '${featureName}' is in '${currentStatus}' (allowed: ${
      allowed || "none"
    })`,
  detail: {
    featureName,
    actionType: action.type,
    machineState: currentStatus,
    allowed,
  },
  hint:
    `This action is not allowed in the current machine state. This may be intentional (guard) or a bug (wrong state).`,
});
```

#### 3.8 beforeReduce Null Filter (`aio.ts:1659-1673`)

**Current:** Action silently dropped when beforeReduce returns null. **Fix:**

```ts
if (filtered === null) {
  diagEmit({
    type: "action-filtered",
    severity: "info",
    source: "middleware",
    message: `Action '${
      (a as { type?: string }).type
    }' filtered out by beforeReduce`,
    detail: { actionType: (a as { type?: string }).type },
    hint:
      "A middleware or beforeReduce hook returned null, dropping this action. Check your middleware chain.",
  });
  return null;
}
```

#### 3.9 Invalid Effect Skipped (`dispatch.ts:312-321`)

**Current:** `log.warn()` and skip. **Fix:**

```ts
diagEmit({
  type: "effect-invalid",
  severity: "warning",
  source: "dispatch",
  message: `Invalid effect skipped (missing .type string) from action '${
    tag(current)
  }'`,
  detail: {
    actionType: tag(current),
    effect: JSON.stringify(effect)?.slice(0, 200),
  },
  hint:
    "Effects must be plain objects with a .type string property. Check your reducer return value.",
});
```

#### 3.10 Queue Overflow — Server Side (`dispatch.ts` queue check)

**Current:** `reportAioError` called with `QUEUE_OVERFLOW`. **Fix:** Auto-emits
via bus bridge. No standalone `diagEmit` needed. Ensure existing
`QUEUE_OVERFLOW` tip includes: _"Too many actions queued — likely infinite
dispatch loop or very slow reducer."_

#### 3.11 UDS Write Failure (`aio.ts:707`)

**Current:** `.catch(() => {})` — completely swallowed. **Fix:**

```ts
writer.write(encoded).catch((e) => {
  diagEmit({
    type: "transport-error",
    severity: "warning",
    source: "server",
    message: "UDS write failed — message not delivered to renderer",
    detail: { error: String(e) },
    hint:
      "Electron IPC pipe may be broken. Check if the renderer process is still running.",
  });
});
```

#### 3.12 Delta Patch Key Stripped (`browser.ts:36, 46`)

**Current:** `_SAFE_KEYS` silently skipped, no indication. **Fix:**

```ts
if (_SAFE_KEYS.has(k)) {
  _diagEmit({
    type: "state-key-stripped",
    severity: "warning",
    source: "browser",
    message: `State key '${k}' stripped — reserved name (${
      [..._SAFE_KEYS].join(", ")
    })`,
    detail: { key: k },
    hint:
      `Rename this state key. '${k}' is a reserved JavaScript property name.`,
  });
  continue;
}
```

### MEDIUM — Nice to Have

#### 3.13 IndexedDB Failures (`browser.ts:116-170`)

Add `_diagEmit` with severity `info` to all catch blocks. These are best-effort
operations, but the developer should know if offline persistence isn't working.

#### 3.14 onStart Hook Failure (`aio.ts:2220-2225`)

Add `diagEmit` when `onStart` throws — app boots in potentially broken state.

#### 3.15 Dispatch Loop Overflow (`dispatch.ts` iteration check)

Already has `reportAioError` with `DISPATCH_LOOP`. Auto-emits via bus bridge. No
change.

#### 3.16 State Not Updating — No Listeners (`browser.ts:467-471`)

This is harder to detect. Add a dev-mode check: if `_state` has been updated 5+
times but `_listeners.size === 0`, emit a warning:

```ts
if (_dev && _stateVersion > 5 && _listeners.size === 0) {
  _diagEmit({
    type: "state-no-listeners",
    severity: "warning",
    source: "browser",
    message:
      "State is updating but no React components are subscribed (useAio not mounted?)",
    hint:
      "Make sure your App component calls useAio() or useFeature() to subscribe to state.",
  });
}
```

#### 3.17 WS Reconnect Without Full State Sync Validation

After reconnect and receiving new state, if state is identical to stale state,
emit info event suggesting the server may not be sending updates.

#### 3.18 Effect Timeout Abandoned (`dispatch.ts` timeout path)

Already has `reportAioError` with `EFFECT_TIMEOUT`. Auto-emits via bus bridge.
Ensure the existing `EFFECT_TIMEOUT` tip includes: _"The underlying promise may
still resolve and cause unexpected state changes."_

---

## File Map

| File                       | Action     | Purpose                                                                                     |
| -------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `src/diagnostic-bus.ts`    | **Create** | DiagnosticBus — types, ring buffer, emit/subscribe (single file, both runtimes)             |
| `src/error.ts`             | **Modify** | Add `PERSIST_ERROR` code, add `diagEmit` bridge in `reportError()`                          |
| `src/server-html.ts`       | **Modify** | Smart module loader (AioLoadError, Blob URL), health overlay HTML + DOM                     |
| `src/server.ts`            | **Modify** | Per-file error map, stale cleanup, `__diag:` WS forwarding, prefix registry comment         |
| `src/browser.ts`           | **Modify** | Bus integration, `__diag:` handler, emit on silent failures (3.1, 3.2, 3.12, 3.13, 3.16)    |
| `src/dispatch.ts`          | **Modify** | No new `diagEmit` calls (auto via reportAioError); fix 3.9 invalid effect (standalone emit) |
| `src/feature-compose.ts`   | **Modify** | Add `reportAioError` for init (3.5), standalone `diagEmit` for machine guard (3.7)          |
| `src/aio.ts`               | **Modify** | Add `reportAioError` for persist (3.6), standalone `diagEmit` for 3.8, 3.11, 3.14           |
| `src/diagnostics/mod.ts`   | **Modify** | Optional bus subscription for structured logging                                            |
| `src/diagnostics/types.ts` | **Modify** | Add `diagnosticBus` option to `DiagnosticsOptions`                                          |

## Testing Strategy

- **Layer 1:** Test each failure mode (404, transpile error, runtime error,
  missing import) produces correct overlay with root cause + fix hint
- **Layer 2:** Test bus emit/subscribe, ring buffer cap, prod no-op behavior
- **Layer 3:** For each of the 18 fixes, test that the failure condition emits
  the correct diagnostic event with correct type, severity, and hint

## Non-Goals

- Prod-mode diagnostic collection (use existing `onError` + logging for that)
- Automatic error recovery (Layer 3 is about visibility, not auto-fix)
- Source map support (separate initiative)
- React error boundaries (separate concern, user-land)

## Backward Compatibility

- Layer 1: The overlay change is internal to the HTML template — no API change
- Layer 2: DiagnosticBus is additive — new opt-in config field `diagnosticBus`
  in `DiagnosticsOptions`
- Layer 3: All changes are additive (adding `diagEmit` calls alongside existing
  behavior). No existing behavior is removed or altered.

## Resolved Questions

1. **Health overlay opt-in/opt-out?** → **On by default in dev, off in prod**
   (consistent with existing diagnostics defaults). Controlled by
   `diagnosticBus` in `DiagnosticsOptions`.
2. **Forward to all browsers or just triggering one?** → **All** — dev mode
   typically has one browser, and multi-tab debugging benefits from seeing all
   events.
3. **Max age for overlay events?** → **60 seconds** — old events auto-dismiss.
4. **Deduplication?** → **5-second window per event type** — prevents flooding
   from high-frequency failures (e.g., delta patch key stripped on every sync
   tick).
5. **Blob URL vs double-fetch for module loading?** → **Blob URL** with
   documented stack trace trade-off. Can fall back to double-fetch if stack
   traces prove critical.
