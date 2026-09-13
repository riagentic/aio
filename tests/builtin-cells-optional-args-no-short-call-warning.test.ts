// builtin-cells-optional-args-no-short-call-warning.test.ts — aio's own cells
// do not trip aio's own "missing argument" warning on their documented calls.
//
// The short-call guard (`_warnShortCall`) reads `fn.length`, which counts a
// TypeScript `opts?` parameter as required and stops only at a signature
// default. `updates.apply()` (docs/deploy/updates.md) and
// `feedback.report(title)` were declared with `?`, so the documented calls
// warned "declares N argument(s) and this call passed M — … writes a row whose
// declared field is simply gone" — a false alarm pointing at correct app code.
import { assertEquals } from "@std/assert";
import { testCell } from "../src/cell-test.ts";
import { log } from "../src/diagnostics/logger-api.ts";
import { installUpdatesRuntime, updates } from "../src/updates.ts";
import {
  createFeedbackCell,
  installFeedbackRuntime,
} from "../src/state/feedback-cell.ts";

type Def = Parameters<typeof testCell>[0];

function captureShortCall(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = log.warn.bind(log);
  // deno-lint-ignore no-explicit-any
  log.warn = ((a: string, b?: string) => {
    const m = String(b ?? a);
    if (m.includes("this call passed")) lines.push(m);
  }) as any;
  return { lines, restore: () => void (log.warn = orig) };
}

testCell(
  updates as unknown as Def,
  "updates.apply() with no options does not warn about a missing argument",
  async (t) => {
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      currentUnknown: null,
      exposed: false,
      check: () => Promise.resolve({ kind: "current", reason: "latest" }),
      apply: () => Promise.resolve(),
      setChannel: () => Promise.resolve(),
    });
    const w = captureShortCall();
    try {
      await t.send.apply!();
    } finally {
      w.restore();
      installUpdatesRuntime(null);
    }
    assertEquals(w.lines, []);
  },
);

testCell(
  createFeedbackCell() as unknown as Def,
  "feedback.report(title) does not warn about missing body/contact",
  async (t) => {
    const captured: unknown[] = [];
    installFeedbackRuntime({
      capture: (r) => {
        captured.push(r);
        return Promise.resolve({
          id: "r1",
          path: "/dev/null",
          createdAt: new Date(0).toISOString(),
          delivered: false,
        });
      },
      count: () => Promise.resolve(1),
    });
    const w = captureShortCall();
    try {
      await t.send.report!("the save button does nothing");
    } finally {
      w.restore();
      installFeedbackRuntime(null);
    }
    assertEquals(w.lines, []);
    assertEquals(captured.length, 1);
  },
);
