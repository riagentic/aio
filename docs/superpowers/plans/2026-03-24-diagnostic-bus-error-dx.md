# Diagnostic Bus & Error DX Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all silent failures and opaque error messages in aio — every
failure is visible, diagnosable, and actionable in dev mode.

**Architecture:** Three layers: (1) Smart Module Loader replaces raw `import()`
with pre-validate-then-import, (2) Diagnostic Bus provides a unified event
channel for all silent failures with a browser health overlay, (3) Silent
Failure Remediation wires 18 code sites into the bus. `reportAioError()`
auto-emits to the bus so existing error sites get bus visibility for free.

**Tech Stack:** TypeScript, Deno 2.6+, esbuild (dev transpile), browser DOM APIs

**Spec:** `docs/superpowers/specs/2026-03-24-diagnostic-bus-error-dx-design.md`

---

## File Structure

| File                       | Action | Responsibility                                                          |
| -------------------------- | ------ | ----------------------------------------------------------------------- |
| `src/diagnostic-bus.ts`    | Create | Bus types, ring buffer, emit/subscribe — works in both server + browser |
| `src/error.ts`             | Modify | Add `PERSIST_ERROR` code, bridge `reportError()` → `diagEmit()`         |
| `src/server-html.ts`       | Modify | Smart module loader, classifier pattern, health overlay DOM             |
| `src/server.ts`            | Modify | Per-file error map, stale cleanup, `__diag:` WS forwarding              |
| `src/browser.ts`           | Modify | Bus integration, `__diag:` handler, browser-side `diagEmit` calls       |
| `src/dispatch.ts`          | Modify | Standalone `diagEmit` for invalid effect (3.9)                          |
| `src/feature-compose.ts`   | Modify | `reportAioError` for init (3.5), `diagEmit` for machine guard (3.7)     |
| `src/aio.ts`               | Modify | `reportAioError` for persist (3.6), `diagEmit` for 3.8, 3.11, 3.14      |
| `src/diagnostics/types.ts` | Modify | Add `diagnosticBus` option                                              |
| `src/diagnostics/mod.ts`   | Modify | Subscribe bus for structured logging                                    |
| `src/vitals/mod.ts`        | Modify | Emit vitals alerts to bus                                               |

---

### Task 1: Create Diagnostic Bus

**Files:**

- Create: `src/diagnostic-bus.ts`
- Test: `src/diagnostic-bus.test.ts`

- [ ] **Step 1: Write the failing test for bus core**

```ts
// src/diagnostic-bus.test.ts
import { assertEquals } from "@std/assert";
import {
  diagEmit,
  diagRecent,
  diagSubscribe,
  initDiagnosticBus,
} from "./diagnostic-bus.ts";

Deno.test("diagEmit is no-op when bus not initialized (prod)", () => {
  initDiagnosticBus(false); // explicit prod mode
  diagEmit({
    type: "test",
    severity: "error",
    source: "test",
    message: "should not appear",
  });
  assertEquals(diagRecent().length, 0);
});

Deno.test("diagEmit stores events when dev mode enabled", () => {
  initDiagnosticBus(true);
  diagEmit({
    type: "test-event",
    severity: "warning",
    source: "test",
    message: "hello",
  });
  const recent = diagRecent();
  assertEquals(recent.length, 1);
  assertEquals(recent[0].type, "test-event");
  assertEquals(recent[0].severity, "warning");
  assertEquals(typeof recent[0].ts, "number");
});

Deno.test("diagSubscribe receives events and unsubscribe works", () => {
  initDiagnosticBus(true);
  const received: string[] = [];
  const unsub = diagSubscribe((ev) => received.push(ev.type));
  diagEmit({ type: "a", severity: "info", source: "test", message: "" });
  unsub();
  diagEmit({ type: "b", severity: "info", source: "test", message: "" });
  assertEquals(received, ["a"]);
});

Deno.test("ring buffer caps at 200 entries", () => {
  initDiagnosticBus(true);
  for (let i = 0; i < 250; i++) {
    diagEmit({
      type: `evt-${i}`,
      severity: "info",
      source: "test",
      message: `msg ${i}`,
    });
  }
  const recent = diagRecent();
  assertEquals(recent.length, 200);
  // Oldest should be evt-50 (first 50 evicted)
  assertEquals(recent[0].type, "evt-50");
  assertEquals(recent[199].type, "evt-249");
});

Deno.test("dedup: same type within 5s window is skipped", () => {
  initDiagnosticBus(true);
  diagEmit({ type: "dup", severity: "info", source: "test", message: "first" });
  diagEmit({
    type: "dup",
    severity: "info",
    source: "test",
    message: "second",
  });
  const recent = diagRecent().filter((e) => e.type === "dup");
  assertEquals(recent.length, 1);
  assertEquals(recent[0].message, "first");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test src/diagnostic-bus.test.ts` Expected: FAIL — module
`./diagnostic-bus.ts` not found

- [ ] **Step 3: Implement diagnostic-bus.ts**

```ts
// src/diagnostic-bus.ts — Diagnostic event bus for surfacing silent failures
// Works in both server (Deno) and browser runtimes — no platform-specific APIs.

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticEvent = {
  type: string;
  severity: DiagnosticSeverity;
  source: string;
  message: string;
  detail?: unknown;
  ts: number;
  hint?: string;
  docLink?: string;
};

export type DiagnosticListener = (event: DiagnosticEvent) => void;

const RING_CAP = 200;
const DEDUP_WINDOW = 5_000;

let _listeners = new Set<DiagnosticListener>();
let _ring: DiagnosticEvent[] = [];
let _head = 0;
let _count = 0;
let _dev = false;
const _lastEmitByType = new Map<string, number>();

export function initDiagnosticBus(dev: boolean): void {
  _dev = dev;
  _ring = [];
  _head = 0;
  _count = 0;
  _listeners = new Set();
  _lastEmitByType.clear();
}

export function diagEmit(
  event: Omit<DiagnosticEvent, "ts">,
): void {
  if (!_dev) return;
  const now = Date.now();
  const last = _lastEmitByType.get(event.type);
  if (last && now - last < DEDUP_WINDOW) return;
  _lastEmitByType.set(event.type, now);

  const full: DiagnosticEvent = { ...event, ts: now };
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
  return [..._ring.slice(_head), ..._ring.slice(0, _head)];
}

export function isDiagDev(): boolean {
  return _dev;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/diagnostic-bus.test.ts` Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/diagnostic-bus.ts src/diagnostic-bus.test.ts
git commit -m "feat: diagnostic bus — ring buffer, dedup, emit/subscribe"
```

---

### Task 2: Bridge reportError → Diagnostic Bus

**Files:**

- Modify: `src/error.ts`
- Test: `src/error.test.ts` (add test case)

- [ ] **Step 1: Add PERSIST_ERROR to AioErrorCode union**

In `src/error.ts`, add `"PERSIST_ERROR"` to the `AioErrorCode` type (after
`"BUDGET_EFFECT"`).

- [ ] **Step 2: Add PERSIST_ERROR to CODE_TO_SOURCE mapping**

Add: `PERSIST_ERROR: "persist"` to the `CODE_TO_SOURCE` record. Add `"persist"`
to `AioErrorSource` union type.

- [ ] **Step 3: Add PERSIST_ERROR tip to generateTip**

```ts
case "PERSIST_ERROR":
  return "Tip: State persist failed — changes are in memory but will be lost on restart. Check disk space and file permissions.";
```

- [ ] **Step 4: Add diagEmit bridge at the end of reportError()**

After the `countError` call (line ~443), before the outer catch, add:

```ts
// Diagnostic bus bridge — auto-surface errors in health overlay
try {
  const { diagEmit: _emit } = await import("./diagnostic-bus.ts");
  // Lazy: no-op if bus not initialized
} catch { /* bus not available */ }
```

Wait — `reportError` is sync. We can't use dynamic import. Instead, use a setter
pattern:

```ts
// At module level, after imports:
let _diagEmitFn: ((ev: Omit<DiagnosticEvent, "ts">) => void) | null = null;

/** Wire the diagnostic bus into reportError. Called once during init. */
export function setDiagEmit(
  fn: (ev: Omit<DiagnosticEvent, "ts">) => void,
): void {
  _diagEmitFn = fn;
}
```

Then at the end of `reportError()`, before the outer catch:

```ts
// Diagnostic bus bridge
if (_diagEmitFn) {
  const isWarn = WARN_CODES.has(err.code);
  _diagEmitFn({
    type: err.code.toLowerCase().replace(/_/g, "-"),
    severity: isWarn ? "warning" : "error",
    source: err.source,
    message: err.message,
    detail: { code: err.code, ...err.context },
    hint: generateTip(err),
  });
}
```

- [ ] **Step 5: Write test for the bridge**

Add to `src/error.test.ts`:

```ts
Deno.test("reportError emits to diagnostic bus when wired", () => {
  const captured: { type: string; severity: string }[] = [];
  setDiagEmit((ev) => captured.push({ type: ev.type, severity: ev.severity }));
  const err = createAioError("REDUCE_ERROR", "test", { actionType: "foo:bar" });
  reportError(err);
  assertEquals(captured.length, 1);
  assertEquals(captured[0].type, "reduce-error");
  assertEquals(captured[0].severity, "error");
  setDiagEmit(
    null as unknown as typeof setDiagEmit extends (fn: infer F) => void ? F
      : never,
  );
});
```

- [ ] **Step 6: Run tests**

Run: `deno test src/error.test.ts` Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/error.ts src/error.test.ts
git commit -m "feat: bridge reportError to diagnostic bus, add PERSIST_ERROR code"
```

---

### Task 3: Smart Module Loader (Layer 1)

**Files:**

- Modify: `src/server-html.ts:80-222` (generateHTML + classifyBrowserError)
- Modify: `src/server.ts:1300-1336` (per-file error map)
- Test: `src/server-html.test.ts` (add classifier test)

- [ ] **Step 1: Add "Failed to fetch dynamically imported module" classifier**

In `src/server-html.ts`, in `classifyBrowserError()` (line 226), add as the
FIRST check before the existing `missingModule` pattern:

```ts
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

- [ ] **Step 2: Write test for the new classifier**

```ts
Deno.test("classifyBrowserError: dynamic import failed", () => {
  const result = classifyBrowserError(
    "TypeError: Failed to fetch dynamically imported module: http://localhost:8090/App.tsx",
  );
  assertEquals(result.classification, "dynamic-import-failed");
  assertEquals(result.label, "Module Load Error");
  assert(result.fix.includes("transpile errors"));
});
```

- [ ] **Step 3: Run test**

Run: `deno test src/server-html.test.ts` Expected: PASS

- [ ] **Step 4: Replace raw import() with smart loader in generateHTML**

In `src/server-html.ts`, replace the dev `<script type="module">` block (lines
156-219).

The new block adds:

1. `AioLoadError` class (proper Error subclass, not plain object)
2. Pre-fetch validation (check HTTP status, detect `throw new Error(...)`)
3. Blob URL import (avoids double-fetch)
4. Rich catch block with layered error rendering

Replace the try/catch block starting at line 156 with:

```ts
class AioLoadError extends Error {
  constructor(msg, detail) {
    super(msg)
    this.name = 'AioLoadError'
    this._aio = true
    Object.assign(this, detail)
  }
}
const moduleUrl = '/App.tsx?v=' + Date.now()
try {
  const pre = await fetch(moduleUrl)
  if (!pre.ok) {
    throw new AioLoadError(
      'Module pre-validation failed (HTTP ' + pre.status + ')',
      { status: pre.status, body: await pre.text() }
    )
  }
  const src = await pre.text()
  if (src.trimStart().startsWith('throw new Error(')) {
    const msg = src.match(/throw new Error\\("(.+)"\\)/s)?.[1]
      ?.replace(/\\\\n/g, '\\n')?.replace(/\\\\"/g, '"') ?? src
    throw new AioLoadError('Transpile error', { status: 200, transpileError: true, body: msg })
  }
  const blob = new Blob([src], { type: 'application/javascript' })
  const blobUrl = URL.createObjectURL(blob)
  try {
    const { default: App } = await import(blobUrl)
    createRoot(document.getElementById('root')).render(createElement(App))
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
} catch (e) {
  console.error('[aio] App load failed:', e)
  let label = 'Runtime Error', fixText = ''
  function mkMessage(text) {
    return '<div style="color:#f1fa8c;margin-bottom:.75rem;white-space:pre-wrap">' + esc(text) + '</div>'
  }
  let body = ''
  if (e && e._aio) {
    if (e.status === 404) {
      label = 'File Not Found'
      body = mkMessage('App.tsx does not exist')
      fixText = 'Create src/App.tsx with a default export React component.'
    } else if (e.transpileError) {
      label = 'Build Error'
      try {
        const r = await fetch('/__aio/error')
        const errData = r.ok ? await r.json() : null
        body = errData?.errors?.length ? mkBuildErrors(errData.errors) : mkMessage(e.body)
      } catch { body = mkMessage(e.body) }
    } else {
      label = 'Server Error (' + e.status + ')'
      body = mkMessage(e.body || e.message)
      fixText = 'Check terminal for server errors.'
    }
  } else {
    const r = await fetch('/__aio/error').catch(() => null)
    const errData = r?.ok ? await r.json().catch(() => null) : null
    const hasServerErr = errData?.errors?.length
    label = hasServerErr ? 'Build Error' : 'Runtime Error'
    body = hasServerErr ? mkBuildErrors(errData.errors) : mkStack(e?.stack)
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
```

Keep the existing `mkBuildErrors`, `mkStack`, `mkFix`, `esc` helper functions
and the overlay HTML rendering unchanged (they work with the new
label/body/fixText variables).

- [ ] **Step 5: Replace global lastErrorData with per-file map in server.ts**

In `src/server.ts`, find `let lastError` and `let lastErrorData` declarations.
Replace with:

```ts
let lastError = "";
const errorMap = new Map<
  string,
  {
    errors: Array<
      {
        text: string;
        file?: string;
        line?: number;
        col?: number;
        lineText?: string;
      }
    >;
    ts: number;
  }
>();
```

In the transpile catch block (~line 1307-1330), replace
`lastErrorData = { ... }` with:

```ts
errorMap.set(filename, {
  errors: rawMsgs.length
    ? rawMsgs.map((m) => ({
      text: m.text,
      file: m.location?.file ?? filename,
      line: m.location?.line,
      col: m.location?.column,
      lineText: m.location?.lineText,
    }))
    : [{ text: formatted }],
  ts: Date.now(),
});
// Cleanup stale entries (> 60s)
const staleThreshold = Date.now() - 60_000;
for (const [f, e] of errorMap) {
  if (e.ts < staleThreshold) errorMap.delete(f);
}
```

In the successful transpile path (~line 1305-1306), replace
`lastErrorData = null` with:

```ts
errorMap.delete(filename);
```

In the `/__aio/error` endpoint (~line 852-856), replace the response with:

```ts
const cutoff = Date.now() - 30_000;
const allErrors = [...errorMap.values()]
  .filter((e) => e.ts > cutoff)
  .flatMap((e) => e.errors);
return new Response(JSON.stringify({ errors: allErrors }), {
  headers: { "Content-Type": "application/json" },
});
```

- [ ] **Step 6: Run linter and type check**

Run: `deno lint src/server-html.ts src/server.ts && deno check src/server.ts`
Expected: PASS (no errors)

- [ ] **Step 7: Commit**

```bash
git add src/server-html.ts src/server.ts src/server-html.test.ts
git commit -m "feat: smart module loader — pre-validate imports, per-file errors, rich overlay"
```

---

### Task 4: Health Overlay DOM

**Files:**

- Modify: `src/server-html.ts` (generateHTML — add health overlay to dev
  template)

- [ ] **Step 1: Add health overlay DOM to the dev HTML template**

In `src/server-html.ts`, in the `generateHTML` function, inside the dev
`<script type="module">` block, AFTER the error catch block and BEFORE the
closing `</script>`, add the health indicator code:

```ts
// ── Health Overlay (diagnostic bus client) ──
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
  transition: "background .3s",
  boxShadow: "0 0 4px rgba(0,0,0,.3)",
});
document.body.appendChild(_diagDot);
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
let _diagEvents = [], _diagUnread = 0;
_diagDot.onclick = () => {
  const show = _diagPanel.style.display === "none";
  _diagPanel.style.display = show ? "block" : "none";
  if (show) {
    _diagUnread = 0;
    _updateDiagDot();
  }
};
function _updateDiagDot() {
  const hasErr = _diagEvents.some((e) => e.severity === "error");
  const hasWarn = _diagEvents.some((e) => e.severity === "warning");
  _diagDot.style.background = hasErr ? "#e25" : hasWarn ? "#ea0" : "#2a2";
  _diagBadge.style.display = _diagUnread > 0 ? "block" : "none";
  _diagBadge.textContent = String(_diagUnread);
}
function _renderDiagPanel() {
  const cutoff = Date.now() - 60000;
  _diagEvents = _diagEvents.filter((e) => e.ts > cutoff);
  _diagPanel.innerHTML = _diagEvents.length === 0
    ? '<div style="padding:10px;color:#555">No recent diagnostics</div>'
    : _diagEvents.map((ev) => {
      const c = ev.severity === "error"
        ? "#e25"
        : ev.severity === "warning"
        ? "#ea0"
        : "#888";
      const age = Math.round((Date.now() - ev.ts) / 1000);
      return '<div style="padding:6px 10px;border-bottom:1px solid #2a2a2a">' +
        '<span style="color:' + c + '">\\u25CF</span> ' +
        "<b>" + esc(ev.type) + '</b> <span style="color:#555">' + age +
        "s ago</span>" +
        '<div style="color:#aaa;margin:2px 0">' + esc(ev.message) + "</div>" +
        (ev.hint
          ? '<div style="color:#98c379;font-size:11px">\\u2192 ' +
            esc(ev.hint) + "</div>"
          : "") +
        "</div>";
    }).join("");
  if (!_diagEvents.length) {
    _diagDot.style.display = "none";
    _diagPanel.style.display = "none";
  }
}
window._aioDiag = function (ev) {
  _diagEvents.push(ev);
  _diagUnread++;
  _diagDot.style.display = "block";
  _updateDiagDot();
  if (_diagPanel.style.display !== "none") _renderDiagPanel();
};
setInterval(() => {
  if (_diagPanel.style.display !== "none") _renderDiagPanel();
}, 10000);
```

The `window._aioDiag` function is called from `browser.ts` when receiving
`__diag:` messages.

- [ ] **Step 2: Verify HTML generates without syntax errors**

Run: `deno check src/server-html.ts` Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server-html.ts
git commit -m "feat: health overlay — diagnostic dot/panel in dev mode"
```

---

### Task 5: Server-Side WS Forwarding

**Files:**

- Modify: `src/server.ts` (WS message handling, `__diag:` forwarding)

- [ ] **Step 1: Add WS prefix registry comment**

At the top of the WS message handling section in `src/server.ts` (near the
`ws.onmessage` handler), add a comment documenting all prefixes:

```ts
// WS message prefix registry:
//   __reload     — trigger page reload
//   __css        — CSS-only hot reload
//   __boot:<id>  — boot ID for session tracking
//   __tt:<json>  — time-travel state
//   __vitals:<json> — vital signs data
//   __diag:<json>   — diagnostic bus events (dev only)
```

- [ ] **Step 2: Subscribe diagnostic bus and forward to dev clients**

In the server startup path (where `prod` is known and WS connections are
managed), after the bus is initialized, add forwarding. Find the section where
WS connections are stored (look for `connSet` or dev client tracking).

```ts
// Forward diagnostic events to dev browsers
if (!prod) {
  diagSubscribe((ev) => {
    const msg = "__diag:" + JSON.stringify(ev);
    for (const [ws] of connections) {
      try {
        ws.send(msg);
      } catch { /* client gone */ }
    }
  });
}
```

- [ ] **Step 3: Initialize diagnostic bus during server startup**

Near the start of the `serve()` function:

```ts
import { diagSubscribe, initDiagnosticBus } from "./diagnostic-bus.ts";

// Inside serve():
initDiagnosticBus(!prod);
```

- [ ] **Step 4: Wire setDiagEmit into server initialization**

After initializing the bus, wire the error bridge:

```ts
import { setDiagEmit } from "./error.ts";
import { diagEmit } from "./diagnostic-bus.ts";

// Inside serve(), after initDiagnosticBus:
if (!prod) {
  setDiagEmit(diagEmit);
}
```

- [ ] **Step 5: Run type check**

Run: `deno check src/server.ts` Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat: diagnostic bus WS forwarding, error bridge wiring"
```

---

### Task 6: Browser-Side Bus Integration

**Files:**

- Modify: `src/browser.ts` (WS message handler, `__diag:` receive, local diag
  calls)

- [ ] **Step 1: Add `__diag:` handler in WS message processing**

In `src/browser.ts`, in the WS `onmessage` handler (where `__tt:`, `__boot:`,
etc. are checked), add BEFORE the JSON.parse state message handling:

```ts
if (line.startsWith("__diag:")) {
  try {
    const ev = JSON.parse(line.slice(7));
    if (typeof window._aioDiag === "function") window._aioDiag(ev);
  } catch { /* ignore malformed diag */ }
  return;
}
```

Also add the same in the IPC message handler (same pattern for IPC messages).

- [ ] **Step 2: Add browser-side _diagEmit helper**

Near the top of `browser.ts`, add a helper for browser-side diagnostic events:

```ts
/** Emit a diagnostic event to the health overlay (dev mode only, with 5s dedup) */
const _diagLastEmit = new Map<string, number>();
function _diagEmit(ev: {
  type: string;
  severity: "error" | "warning" | "info";
  source: string;
  message: string;
  detail?: unknown;
  hint?: string;
}): void {
  if (typeof window._aioDiag !== "function") return;
  const now = Date.now();
  const last = _diagLastEmit.get(ev.type);
  if (last && now - last < 5000) return; // 5s dedup window
  _diagLastEmit.set(ev.type, now);
  window._aioDiag({ ...ev, ts: now });
}
```

- [ ] **Step 3: Run type check**

Run: `deno check src/browser.ts` Expected: PASS after adding the required global
type declaration.

Add near the top of `browser.ts` (after existing imports):

```ts
declare global {
  interface Window {
    _aioDiag?: (ev: unknown) => void;
  }
}
```

This IS required — TypeScript will error on `window._aioDiag` without it.

- [ ] **Step 4: Commit**

```bash
git add src/browser.ts
git commit -m "feat: browser diagnostic bus — __diag: handler, _diagEmit helper"
```

---

### Task 7: Silent Failure Remediation — Browser (3.1, 3.2, 3.12, 3.13, 3.16)

**Files:**

- Modify: `src/browser.ts`

- [ ] **Step 1: Fix 3.1 — Action queue overflow (browser.ts _send)**

In the `_send()` function, where actions are silently dropped (the `else`
branches around line 808-814), add `_diagEmit` calls. See spec section 3.1 for
exact code.

Replace silent drops:

```ts
} else {
  _diagEmit({
    type: "action-dropped",
    severity: "warning",
    source: "browser",
    message: `Action '${action.type}' dropped — offline queue full (${OFFLINE_MAX_QUEUE})`,
    detail: { actionType: action.type, queueSize: _offlineQueue.length },
    hint: "Check network connection. Actions are queued when disconnected but the queue has a limit.",
  });
}
```

And for the never-connected queue full case:

```ts
} else {
  _diagEmit({
    type: "action-dropped",
    severity: "warning",
    source: "browser",
    message: `Action '${action.type}' dropped — connect queue full (${WS_MAX_QUEUE})`,
    detail: { actionType: action.type, queueSize: _queue.length },
    hint: "Server may be slow to respond. Check terminal for errors.",
  });
}
```

- [ ] **Step 2: Fix 3.2 — WS/IPC JSON parse failure**

In the catch block at ~line 596-597, after the existing `console.warn`, add:

```ts
_diagEmit({
  type: "state-sync-error",
  severity: "error",
  source: "browser",
  message: "Failed to parse state message from server",
  detail: { error: String(err), rawLength: line?.length },
  hint:
    "Server sent malformed state. Check for serialization bugs on the server side.",
});
```

- [ ] **Step 3: Fix 3.12 — Delta patch key stripped**

In `_applyPatch()`, in the `_SAFE_KEYS.has(k)` check at line 36, add:

```ts
if (_SAFE_KEYS.has(k)) {
  _diagEmit({
    type: "state-key-stripped",
    severity: "warning",
    source: "browser",
    message: `State key '${k}' stripped — reserved JavaScript property name`,
    detail: { key: k },
    hint: `Rename this state key. Reserved names: ${
      [..._SAFE_KEYS].join(", ")
    }`,
  });
  continue;
}
```

- [ ] **Step 4: Fix 3.13 — IndexedDB failures**

In the IndexedDB helper functions (~lines 116-170), add `_diagEmit` with
severity `info` in the catch blocks. Example for `_loadOfflineQueue`:

```ts
} catch (e) {
  _diagEmit({
    type: "offline-storage-error",
    severity: "info",
    source: "browser",
    message: "IndexedDB operation failed — offline persistence unavailable",
    detail: { error: String(e) },
    hint: "Offline action queue will use memory only. Check browser storage quota.",
  });
}
```

- [ ] **Step 5: Fix 3.16 — State updating with no listeners**

In `_notify()` (~line 469), add a check:

```ts
function _notify() {
  _stateVersion++;
  _listeners.notify(_state);
  if (_stateVersion > 5 && _listeners.size === 0) {
    _diagEmit({
      type: "state-no-listeners",
      severity: "warning",
      source: "browser",
      message: "State is updating but no React components are subscribed",
      hint:
        "Make sure your App component calls useAio() or useFeature() to subscribe to state.",
    });
  }
}
```

- [ ] **Step 6: Run type check and lint**

Run: `deno check src/browser.ts && deno lint src/browser.ts` Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/browser.ts
git commit -m "feat: browser silent failure remediation — 5 sites emit diagnostics"
```

---

### Task 8: Silent Failure Remediation — Server (3.5, 3.7, 3.8, 3.9, 3.11, 3.14)

**Files:**

- Modify: `src/feature-compose.ts` (3.5 init, 3.7 machine guard)
- Modify: `src/dispatch.ts` (3.9 invalid effect)
- Modify: `src/aio.ts` (3.6 persist, 3.8 beforeReduce, 3.11 UDS, 3.14 onStart)

- [ ] **Step 1: Verify 3.5 — Feature init already calls reportAioError**

`feature-compose.ts` line ~741 already calls
`_reportError(createAioError("INIT_ERROR", ...))`. The `_reportError` callback
is wired to `reportAioError` in `aio.ts` line ~985. Once the bus bridge (Task 2)
is wired, this auto-emits to the bus.

**Verification only:** read the file, confirm the `INIT_ERROR` path exists. No
code change needed.

- [ ] **Step 2: Fix 3.7 — Machine guard silent drop (feature-compose.ts)**

In the machine guard block (~line 245-254), after the existing log.warn/debug,
add:

```ts
import { diagEmit } from "./diagnostic-bus.ts";

// After the log line:
diagEmit({
  type: "action-guarded",
  severity: "info",
  source: "feature-compose",
  message:
    `'${action.type}' blocked — machine '${featureName}' in '${currentStatus}' (allowed: ${
      allowed || "none"
    })`,
  detail: { featureName, actionType: action.type, machineState: currentStatus },
  hint:
    "This action is not allowed in the current machine state. May be intentional (guard) or a bug.",
});
```

- [ ] **Step 3: Fix 3.9 — Invalid effect skipped (dispatch.ts)**

In `dispatch.ts`, at the invalid effect warning (~line 316-321), add after
`log.warn`:

```ts
import { diagEmit } from "./diagnostic-bus.ts";

diagEmit({
  type: "effect-invalid",
  severity: "warning",
  source: "dispatch",
  message: `Invalid effect skipped (missing .type) from action '${
    tag(current)
  }'`,
  detail: { actionType: tag(current) },
  hint:
    "Effects must be plain objects with a .type string. Check your reducer return value.",
});
```

- [ ] **Step 4: Fix 3.6 — Persist failures (aio.ts — ALL persist catch blocks)**

There are 5+ persist catch blocks in `aio.ts`. Add
`reportAioError("PERSIST_ERROR", ...)` to ALL of them:

1. **KV multi-save** (~line 1568) — `catch` in the batch KV set loop
2. **KV single-save** (~line 1592) — `catch` in single KV set
3. **stateForDB** (~line 1596) — `catch` in state serialization for DB
4. **SQLite sync** (~line 1552) — `catch` in `syncTables()`
5. **flushPersist** (~lines 1620, 1636-1646) — `catch` in shutdown flush

For each, add:

```ts
const err = createAioError("PERSIST_ERROR", e, {});
reportAioError(err, reportOpts);
```

This ensures ALL persist paths surface in the diagnostic bus.

- [ ] **Step 5: Fix 3.8 — beforeReduce null filter (aio.ts)**

In `aio.ts`, where `beforeReduce` returns null (~line 1661-1662), add:

```ts
if (filtered === null) {
  diagEmit({
    type: "action-filtered",
    severity: "info",
    source: "middleware",
    message: `Action '${
      (a as { type?: string }).type
    }' filtered by beforeReduce`,
    detail: { actionType: (a as { type?: string }).type },
    hint:
      "A middleware or beforeReduce hook returned null, dropping this action.",
  });
  return { state: s, effects: [] };
}
```

- [ ] **Step 6: Fix 3.11 — UDS write failure (aio.ts)**

Find `.catch(() => {})` on UDS writer (~line 707). Replace with:

```ts
.catch((e: unknown) => {
  diagEmit({
    type: "transport-error",
    severity: "warning",
    source: "server",
    message: "UDS write failed — message not delivered to renderer",
    detail: { error: String(e) },
    hint: "Electron IPC pipe may be broken. Check if renderer process is running.",
  });
})
```

- [ ] **Step 7: Fix 3.14 — onStart hook failure (aio.ts)**

Find `onStart` catch block (~line 2220-2225). Add after existing handling:

```ts
diagEmit({
  type: "hook-start-failed",
  severity: "error",
  source: "lifecycle",
  message: "onStart hook threw — app may be in broken state",
  detail: { error: String(e) },
  hint:
    "Check your onStart callback. The app will continue running but may not be fully initialized.",
});
```

- [ ] **Step 8: Run type check on all modified files**

Run: `deno check src/feature-compose.ts src/dispatch.ts src/aio.ts` Expected:
PASS

- [ ] **Step 9: Commit**

```bash
git add src/feature-compose.ts src/dispatch.ts src/aio.ts
git commit -m "feat: server-side silent failure remediation — 7 sites emit diagnostics"
```

---

### Task 9: Diagnostics Module Integration

**Files:**

- Modify: `src/diagnostics/types.ts`
- Modify: `src/diagnostics/mod.ts`
- Modify: `src/vitals/mod.ts`

- [ ] **Step 1: Add diagnosticBus to DiagnosticsOptions**

In `src/diagnostics/types.ts`, add to the `DiagnosticsOptions` type:

```ts
diagnosticBus?: boolean;
```

Add `diagnosticBus: true` to `DEV_DEFAULTS` and `diagnosticBus: false` to
`PROD_DEFAULTS`.

- [ ] **Step 2: Subscribe bus in diagnostics/mod.ts**

In `initDiagnostics()`, after existing setup, add:

```ts
import { diagSubscribe } from "../diagnostic-bus.ts";

// After crash handler setup:
if (opts.diagnosticBus !== false) {
  diagSubscribe((ev) => {
    if (ev.severity === "error") log.error("diag", ev.message);
    else if (ev.severity === "warning") log.warn("diag", ev.message);
  });
}
```

- [ ] **Step 3: Emit vitals alerts to bus**

In `src/vitals/mod.ts`, in the alert firing path (`fireAlert` or equivalent),
add:

```ts
import { diagEmit } from "../diagnostic-bus.ts";

// When a vitals alert fires:
diagEmit({
  type: "vitals-alert",
  severity: alert.severity === "frozen" ? "error" : "warning",
  source: "vitals",
  message: /* existing alert message */,
  hint: /* first hint message if available */,
});
```

- [ ] **Step 4: Run type check**

Run:
`deno check src/diagnostics/types.ts src/diagnostics/mod.ts src/vitals/mod.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/types.ts src/diagnostics/mod.ts src/vitals/mod.ts
git commit -m "feat: diagnostics + vitals integrate with diagnostic bus"
```

---

### Task 10: Integration Test + Final Verification

**Files:**

- Create: `src/diagnostic-bus-integration.test.ts`

- [ ] **Step 1: Write integration test for bus → reportError bridge**

```ts
import { assertEquals } from "@std/assert";
import {
  diagRecent,
  diagSubscribe,
  initDiagnosticBus,
} from "./diagnostic-bus.ts";
import { createAioError, reportError, setDiagEmit } from "./error.ts";
import { diagEmit } from "./diagnostic-bus.ts";

Deno.test("reportError auto-emits to diagnostic bus", () => {
  initDiagnosticBus(true);
  setDiagEmit(diagEmit);
  const captured: string[] = [];
  diagSubscribe((ev) => captured.push(ev.type));

  const err = createAioError("REDUCE_ERROR", "test reduce failure", {
    featureName: "counter",
    actionType: "counter:increment",
  });
  reportError(err);

  assertEquals(captured.length, 1);
  assertEquals(captured[0], "reduce-error");

  const recent = diagRecent();
  assertEquals(recent.length >= 1, true);
  assertEquals(recent[recent.length - 1].source, "reduce");
});
```

- [ ] **Step 2: Write test for PERSIST_ERROR code**

```ts
Deno.test("PERSIST_ERROR emits correct bus event", () => {
  initDiagnosticBus(true);
  setDiagEmit(diagEmit);
  const captured: string[] = [];
  diagSubscribe((ev) => captured.push(ev.type));

  const err = createAioError("PERSIST_ERROR", "disk full", {});
  reportError(err);

  assertEquals(captured.includes("persist-error"), true);
});
```

- [ ] **Step 3: Run all tests**

Run:
`deno test src/diagnostic-bus.test.ts src/diagnostic-bus-integration.test.ts src/error.test.ts`
Expected: All PASS

- [ ] **Step 4: Run full lint + type check**

Run:
`deno lint src/ && deno check src/aio.ts src/server.ts src/browser.ts src/dispatch.ts src/feature-compose.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/diagnostic-bus-integration.test.ts
git commit -m "test: diagnostic bus integration tests"
```

---

### Task 11: Documentation Update

**Files:**

- Modify: `docs/debugging.md`
- Modify: `docs/changelog.md`

- [ ] **Step 1: Add diagnostic bus section to debugging.md**

Add a new section "Diagnostic Bus & Health Overlay" covering:

- What the health overlay shows (dot colors, panel content)
- How to read diagnostic events
- List of event types and what they mean
- How to disable (`diagnostics: { dev: { diagnosticBus: false } }`)

- [ ] **Step 2: Add changelog entry**

Add unreleased entry:

```markdown
- **Diagnostic bus** — unified event channel for all silent failures, visible
  via health overlay (green/yellow/red dot, click to expand). 18
  previously-silent failure points now surface as dev-mode diagnostics.
- **Smart module loader** — replaces raw `import()` with
  pre-validate-then-import. Shows root cause (404, transpile error, server
  error) instead of generic "Failed to fetch dynamically imported module".
  Per-file error storage replaces global.
- **New error code:** `PERSIST_ERROR` for state persistence failures.
```

- [ ] **Step 3: Commit**

```bash
git add docs/debugging.md docs/changelog.md
git commit -m "docs: diagnostic bus, smart module loader, PERSIST_ERROR"
```
