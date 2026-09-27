// A dispatch loop is reported ONCE, as DISPATCH_LOOP.
//
// An async effect that awaited a dispatch the overflow guard dropped rejected
// with the DISPATCH_LOOP error, and the effect runner re-reported it as
// "[EFFECT_ASYNC_ERROR] … async method threw after it started" — a second
// report of the same loop, with the wrong diagnosis and the wrong fix.
import { assertEquals } from "@std/assert";
import { createDispatch } from "../src/state/dispatch.ts";
import type { AioError } from "../src/diagnostics/error.ts";

Deno.test("dispatch: a loop an async effect awaited is reported only as DISPATCH_LOOP", async () => {
  const errors: AioError[] = [];
  let state = 0;
  let again: ((a: { type: string }) => Promise<unknown>) | null = null;
  const dispatch = createDispatch<number, { type: string }, { type: string }>({
    reduce: (s) => ({ state: s + 1, effects: [{ type: "LOOP" }] }),
    // async: returns the follow-up's promise, which the guard rejects
    execute: async () => {
      await again!({ type: "c:spin" });
    },
    getState: () => state,
    setState: (s) => void (state = s),
    onDone: () => {},
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
    reportOpts: { onError: (e) => void errors.push(e) },
  });
  again = dispatch;
  await dispatch({ type: "c:spin" }).catch(() => {}); // aio-ok: rejected by the guard
  await new Promise((r) => setTimeout(r, 50)); // let every effect settle
  // A BUDGET_* line is a wall-clock observation (a loaded machine is slow), not
  // a diagnosis of the loop — the claim is one loop report, never a second one.
  assertEquals(
    errors.map((e) => e.code).filter((c) => !c.startsWith("BUDGET_")),
    ["DISPATCH_LOOP"],
  );
});
