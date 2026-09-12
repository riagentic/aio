// dev-overlay.ts — the errors a page makes, ON the page, in dev.
//
// THE REPORT. One app's MediaPipe call failed on every single frame, and the
// only evidence was a counter in a panel the author happened to have written
// (report 3 §12.4, report 7 §8.7). Everything the framework knew was in the
// console and in `client.log` — both of which you have to be looking at, and
// neither of which you are looking at while you are looking at the page.
//
// The seam already existed and nothing filled it: `_deliverDiag` has called
// `window._aioDiag` since alpha52, with a comment saying "overlay when the page
// has one, console otherwise" — and the console branch was the only one that
// ever ran, "since nothing injects it".
//
// FOUR RULES, all of them load-bearing:
//
//  1. DEV ONLY, and observe-only even there. It renders what already happened
//     and changes nothing — category (a) of the dev/prod rule. A production
//     page never carries it.
//  2. NO AIR. The renderer is one of the things that breaks, and an overlay
//     that needs a working renderer to report a broken one reports nothing.
//     Plain DOM: no signals, no JSX, no dependency on anything it might be
//     reporting about.
//  3. IT COUNTS. A per-frame failure is ONE problem, not two thousand lines.
//     Identical reports collapse into a count, which is what makes the overlay
//     usable for the exact case that motivated it.
//  4. IT NEVER SWALLOWS THE PAGE. Bottom-anchored, collapsed to one small
//     button, and `pointer-events: none` everywhere it is not a control — a
//     diagnostic that blocks the UI it is diagnosing has replaced one problem
//     with another.

import { isDevMode } from "../state/dev-flag.ts";

type Entry = {
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  count: number;
  ts: number;
};

const MAX_ENTRIES = 20;
const ID = "aio-dev-overlay";

let _entries: Entry[] = [];
let _root: HTMLElement | null = null;
let _list: HTMLElement | null = null;
let _badge: HTMLElement | null = null;
let _open = false;
let _installed = false;

/** Are we in a real browser document? This runtime also loads under Deno (SSR,
 *  tests) and in a worker, where there is nothing to attach to. */
function _doc(): Document | null {
  const d = (globalThis as { document?: Document }).document;
  return d && typeof d.createElement === "function" ? d : null;
}

function _style(el: HTMLElement, css: Record<string, string>): void {
  for (const [k, v] of Object.entries(css)) el.style.setProperty(k, v);
}

function _ensureRoot(): HTMLElement | null {
  if (_root?.isConnected) return _root;
  const doc = _doc();
  if (!doc?.body) return null;
  const root = doc.createElement("div");
  root.id = ID;
  root.setAttribute("data-aio-dev", "overlay");
  _style(root, {
    position: "fixed",
    inset: "auto 0 0 0",
    "z-index": "2147483647",
    font: "12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
    // The page underneath stays clickable — only the controls take events.
    "pointer-events": "none",
    display: "flex",
    "flex-direction": "column",
    "align-items": "flex-start",
  });

  const badge = doc.createElement("button");
  badge.type = "button";
  _style(badge, {
    "pointer-events": "auto",
    margin: "0 0 0 8px",
    padding: "4px 10px",
    border: "0",
    "border-radius": "6px 6px 0 0",
    background: "#b3261e",
    color: "#fff",
    font: "inherit",
    "font-weight": "600",
    cursor: "pointer",
  });
  badge.addEventListener("click", () => {
    _open = !_open;
    _render();
  });

  const list = doc.createElement("div");
  _style(list, {
    "pointer-events": "auto",
    display: "none",
    width: "100%",
    "max-height": "40vh",
    "overflow-y": "auto",
    background: "#1b1b1f",
    color: "#e6e1e5",
    "border-top": "2px solid #b3261e",
    padding: "6px 0",
  });

  root.append(badge, list);
  doc.body.append(root);
  _root = root;
  _badge = badge;
  _list = list;
  return root;
}

function _render(): void {
  const root = _ensureRoot();
  if (!root || !_badge || !_list) return;
  const doc = _doc();
  if (!doc) return;
  const total = _entries.reduce((n, e) => n + e.count, 0);
  if (total === 0) {
    _style(root, { display: "none" });
    return;
  }
  _style(root, { display: "flex" });
  const worst = _entries.some((e) => e.severity === "error")
    ? "#b3261e"
    : "#7a5900";
  _style(_badge, { background: worst });
  _badge.textContent = `${_open ? "[-]" : "[+]"} aio: ${total} ${
    total === 1 ? "problem" : "problems"
  }`;
  _style(_list, {
    display: _open ? "block" : "none",
    "border-top-color": worst,
  });
  if (!_open) return;

  _list.textContent = "";
  for (const e of _entries) {
    const row = doc.createElement("div");
    _style(row, {
      padding: "6px 12px",
      "border-bottom": "1px solid #ffffff14",
      "white-space": "pre-wrap",
      "word-break": "break-word",
    });
    const head = doc.createElement("div");
    _style(head, {
      color: e.severity === "error" ? "#f2b8b5" : "#ffd8a8",
      "font-weight": "600",
    });
    head.textContent = e.count > 1 ? `${e.title}  x${e.count}` : e.title;
    row.append(head);
    if (e.detail) {
      const det = doc.createElement("div");
      _style(det, { color: "#cac4d0", "margin-top": "2px" });
      det.textContent = e.detail;
      row.append(det);
    }
    _list.append(row);
  }

  const clear = doc.createElement("button");
  clear.type = "button";
  _style(clear, {
    margin: "6px 12px",
    padding: "3px 10px",
    border: "1px solid #ffffff33",
    "border-radius": "4px",
    background: "transparent",
    color: "#e6e1e5",
    font: "inherit",
    cursor: "pointer",
  });
  clear.textContent = "clear";
  clear.addEventListener("click", () => {
    _entries = [];
    _open = false;
    _render();
  });
  _list.append(clear);
}

/** Record one problem. Identical ones collapse into a count — the per-frame
 *  failure that motivated this is ONE problem, and two thousand rows of it is
 *  the same silence in a different font. @internal */
export function _report(
  severity: Entry["severity"],
  title: string,
  detail = "",
): void {
  const key = `${severity} ${title} ${detail}`;
  const existing = _entries.find((e) =>
    `${e.severity} ${e.title} ${e.detail}` === key
  );
  if (existing) {
    existing.count++;
    existing.ts = Date.now();
  } else {
    // Newest FIRST, and bounded: an unbounded list is a memory leak in a page
    // that is already misbehaving.
    _entries.unshift({ severity, title, detail, count: 1, ts: Date.now() });
    if (_entries.length > MAX_ENTRIES) _entries.length = MAX_ENTRIES;
    // A NEW kind of problem opens the panel; a repeat of one already listed
    // does not, or the page becomes unusable under the very condition this
    // exists to report.
    _open = true;
  }
  _render();
}

/** Install the dev error overlay. Idempotent, and a no-op outside dev or
 *  outside a document. */
export function installDevOverlay(): void {
  if (_installed || !isDevMode()) return;
  const doc = _doc();
  if (!doc) return;
  _installed = true;

  const w = globalThis as unknown as {
    _aioDiag?: (ev: Record<string, unknown>) => void;
    addEventListener?: (t: string, f: (e: never) => void) => void;
  };

  // THE seam `_deliverDiag` has been calling since alpha52. CHAINED, not
  // replaced: an app (or a test) that installed its own handler keeps it.
  const prev = w._aioDiag;
  w._aioDiag = (ev: Record<string, unknown>) => {
    try {
      const sev = ev.severity === "error"
        ? "error"
        : ev.severity === "warning"
        ? "warning"
        : "info";
      _report(
        sev,
        `${ev.type ?? "diagnostic"} - ${ev.message ?? ""}`,
        typeof ev.hint === "string" ? `-> ${ev.hint}` : "",
      );
    } catch {
      // aio-ok: a malformed event must not break the diagnostic channel it
      // arrived on, and `_deliverDiag` falls back to the console when this
      // throws, so the report is not lost either.
    }
    prev?.(ev);
  };

  w.addEventListener?.("error", (e: ErrorEvent) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
    _report("error", `${e.message}${where}`, e.error?.stack ?? "");
  });
  w.addEventListener?.("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r = e.reason;
    _report(
      "error",
      `Unhandled rejection: ${r instanceof Error ? r.message : String(r)}`,
      r instanceof Error ? (r.stack ?? "") : "",
    );
  });
}

/** @internal Test seam — forget everything and detach. */
// aio-ok: a test-only seam; the product installs once and never uninstalls
export function _resetDevOverlay(): void {
  _entries = [];
  _open = false;
  _installed = false;
  _root?.remove();
  _root = null;
  _list = null;
  _badge = null;
}

/** @internal What the overlay is currently showing. */
// aio-ok: a test-only seam; nothing in src/ reads its own overlay back
export function _overlayEntries(): ReadonlyArray<Readonly<Entry>> {
  return _entries.map((e) => ({ ...e }));
}
