// A diagnostic event must never vanish.
//
// Client-side diagnostics exist to SURFACE silent failures, and they were the
// silent failure. `window._aioDiag` is the optional dev overlay, defined by
// `healthOverlayScript()` in `server-html-scripts.ts` — which nothing injects
// into any shell. Every sink was written out by hand as
// `if (typeof _w._aioDiag === "function") _w._aioDiag(ev)`, four times over
// (`_diagEmit` plus the WS, IPC and AIR command routers), so with no overlay
// present — which is every page — each one took the `else` branch and dropped
// the event on the floor without a word.
//
// Contract now: ONE sink. Overlay when the page has one, console otherwise,
// and `_diagEmit` keeps its 5s-per-type dedup so the fallback cannot turn a
// repeating condition into a wall of identical lines.
import { assert, assertEquals } from "@std/assert";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Capture console output for one call. */
function captured(fn: () => void): { level: string; text: string }[] {
  const out: { level: string; text: string }[] = [];
  const orig = {
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  console.error = (...a: unknown[]) =>
    out.push({ level: "error", text: a.join(" ") });
  console.warn = (...a: unknown[]) =>
    out.push({ level: "warn", text: a.join(" ") });
  console.info = (...a: unknown[]) =>
    out.push({ level: "info", text: a.join(" ") });
  try {
    fn();
  } finally {
    console.error = orig.error;
    console.warn = orig.warn;
    console.info = orig.info;
  }
  return out;
}

/** The module captures `window` into `_w` at import time, so one has to exist
 *  for that instant — but ONLY for that instant. `deno test tests/` runs every
 *  file in one process, and four places in `src/` branch on
 *  `typeof window !== "undefined"` to decide "browser"; a `window` left on the
 *  global sends them down the browser path in a runtime with no `document`,
 *  and later, unrelated files fail with "document is not defined". A test
 *  fixture must never be more permissive than production — install it, import,
 *  put the global back exactly as it was. */
async function loadDiag() {
  const had = "window" in globalThis;
  if (!had) (globalThis as Any).window = globalThis;
  try {
    return await import(
      `../src/protocol/protocol-diagnostics.ts#${crypto.randomUUID()}`
    );
  } finally {
    if (!had) delete (globalThis as Any).window;
  }
}

Deno.test("diag: with no overlay, an event reaches the console instead of vanishing", async () => {
  const { _deliverDiag } = await loadDiag();
  delete (globalThis as Any)._aioDiag;

  const lines = captured(() =>
    _deliverDiag({
      type: "loop:stall",
      severity: "error",
      message: "event loop blocked",
      hint: "look for a runaway reducer",
    })
  );

  assertEquals(lines.length, 1, "the event must be reported somewhere");
  assertEquals(lines[0]!.level, "error", "severity picks the console channel");
  assert(lines[0]!.text.includes("loop:stall"), lines[0]!.text);
  assert(
    lines[0]!.text.includes("look for a runaway reducer"),
    "the hint travels with it — it is the actionable half",
  );
});

Deno.test("diag: severity maps to the matching console channel", async () => {
  const { _deliverDiag } = await loadDiag();
  delete (globalThis as Any)._aioDiag;
  for (
    const [severity, level] of [
      ["error", "error"],
      ["warning", "warn"],
      ["info", "info"],
    ] as const
  ) {
    // Distinct types: delivery dedups per type (5s), and that is part of the
    // contract this file pins.
    const lines = captured(() =>
      _deliverDiag({ type: `t-${severity}`, severity, message: "m" })
    );
    assertEquals(lines[0]?.level, level, `severity ${severity}`);
  }
});

Deno.test("diag: an overlay, when present, still wins and the console stays quiet", async () => {
  const { _deliverDiag } = await loadDiag();
  const seen: unknown[] = [];
  (globalThis as Any)._aioDiag = (ev: unknown) => seen.push(ev);
  try {
    const lines = captured(() =>
      _deliverDiag({ type: "t", severity: "error", message: "m" })
    );
    assertEquals(seen.length, 1, "the overlay receives the event");
    assertEquals(lines.length, 0, "…and it is not double-reported");
  } finally {
    delete (globalThis as Any)._aioDiag;
  }
});

Deno.test("diag: a throwing overlay must not take the transport down with it", async () => {
  const { _deliverDiag } = await loadDiag();
  (globalThis as Any)._aioDiag = () => {
    throw new Error("overlay blew up");
  };
  try {
    // The sink runs inside frame routing — a throw here would kill the
    // connection over a diagnostic, which is the tail wagging the dog. And a
    // buggy overlay must not EAT the event either: it falls through to the
    // console, because the sink whose job is surfacing silent failures must
    // not have one of its own.
    const lines = captured(() =>
      _deliverDiag({ type: "t", severity: "error", message: "m" })
    );
    assertEquals(
      lines.length,
      1,
      "a throwing overlay falls through to the console",
    );
  } finally {
    delete (globalThis as Any)._aioDiag;
  }
});

Deno.test("diag: dedup lives at DELIVERY, so transport-routed frames cannot flood", async () => {
  // The WS/IPC/AIR routers call _deliverDiag directly (server-sent `diag`
  // frames never pass _diagEmit) — a repeating server diagnostic must dedup
  // at the sink itself, not only in the client-side emit wrapper.
  const { _deliverDiag } = await loadDiag();
  delete (globalThis as Any)._aioDiag;
  const lines = captured(() => {
    for (let i = 0; i < 5; i++) {
      _deliverDiag({
        type: "srv:pressure",
        severity: "warning",
        message: `p${i}`,
      });
    }
  });
  assertEquals(lines.length, 1, "same type within 5s delivers once");
});

Deno.test("diag: _diagEmit dedups per type so the fallback cannot flood", async () => {
  const { _diagEmit } = await loadDiag();
  delete (globalThis as Any)._aioDiag;

  const lines = captured(() => {
    for (let i = 0; i < 5; i++) {
      _diagEmit({
        type: "state:shape",
        severity: "warning",
        source: "client",
        message: `drop ${i}`,
      });
    }
    // A DIFFERENT type is a different condition and must still get through.
    _diagEmit({
      type: "loop:stall",
      severity: "warning",
      source: "client",
      message: "other",
    });
  });

  assertEquals(
    lines.map((l) => l.text.includes("state:shape")).filter(Boolean).length,
    1,
    "five occurrences of one condition report once (5s window)",
  );
  assert(
    lines.some((l) => l.text.includes("loop:stall")),
    "a different event type is not suppressed by another's dedup",
  );
});
