// An action dispatched while time travel is PAUSED must be REFUSED, not
// silently swallowed.
//
// The drop used to happen inside `reduce`, which returned the state unchanged.
// By then the action had already been accepted, so the caller's promise settled
// as SUCCESS with nothing applied — the app reported that it had done the thing
// it had just discarded. `undo` pauses, so pressing undo in the debug panel put
// every subsequent call into that state.
//
// B-4's contract is that a dropped action REJECTS. The refusal therefore has to
// happen at the dispatch door, the only place that still owns the caller's
// promise; time travel's own restore assigns state directly and never comes
// through it, so undo/redo themselves keep working.
import { assert, assertEquals } from "@std/assert";
import { createDispatch } from "../src/state/dispatch.ts";

type S = { n: number };
type A = { type: string };

function makeDispatch(paused: () => boolean) {
  let state: S = { n: 0 };
  const warnings: string[] = [];
  const d = createDispatch<S, A, never>({
    reduce: (s, a) =>
      a.type === "inc" ? { state: { n: s.n + 1 }, effects: [] } : {
        state: s,
        effects: [],
      },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    log: {
      debug: () => {},
      warn: (m: string) => {
        warnings.push(m);
      },
      error: () => {},
    },
    onDone: () => {},
    debug: false,
    isPaused: paused,
  });
  return { d, get: () => state, warnings };
}

Deno.test("paused: a dispatched action REJECTS instead of resolving", async () => {
  let paused = false;
  const { d, get } = makeDispatch(() => paused);

  await d({ type: "inc" });
  assertEquals(get().n, 1, "an unpaused dispatch applies");

  paused = true;
  let rejected: unknown = null;
  await d({ type: "inc" }).catch((e) => {
    rejected = e;
  });
  assert(
    rejected !== null,
    "a dispatch while paused must REJECT — resolving tells the caller the " +
      "action was applied when it was discarded",
  );
  assertEquals(get().n, 1, "and nothing may be applied");

  // The message must say what actually happened and how to get out of it.
  const msg = String((rejected as { message?: string }).message ?? rejected);
  assert(
    /paused/i.test(msg),
    `the rejection must name the real reason, got: ${msg}`,
  );
});

Deno.test("paused: resuming restores normal dispatch", async () => {
  let paused = true;
  const { d, get } = makeDispatch(() => paused);
  await d({ type: "inc" }).catch(() => {});
  assertEquals(get().n, 0);
  // The gate is read per dispatch, never captured: `record()` returns a new
  // TTState object per action, so a captured value would never see the change.
  paused = false;
  await d({ type: "inc" });
  assertEquals(get().n, 1, "dispatch must work again after resume");
});

Deno.test("paused: the drop is logged once per action type, not per action", async () => {
  const { d, warnings } = makeDispatch(() => true);
  for (let i = 0; i < 5; i++) {
    await d({ type: "tick" }).catch(() => {});
  }
  for (let i = 0; i < 3; i++) {
    await d({ type: "other" }).catch(() => {});
  }
  const paused = warnings.filter((w) => /PAUSED/.test(w));
  assertEquals(
    paused.length,
    2,
    `one warning per action type — a paused app with a 1s clock cell would ` +
      `otherwise fill the log while the developer reads the panel. Got:\n${
        paused.join("\n")
      }`,
  );
});

Deno.test("paused: a fire-and-forget dispatch does not raise an unhandled rejection", async () => {
  // Schedules and effects dispatch without awaiting. The rejection must be
  // pre-caught, or refusing an action would crash the process instead of
  // informing a caller who never existed.
  const { d } = makeDispatch(() => true);
  d({ type: "inc" }); // deliberately not awaited, not caught
  await new Promise((r) => setTimeout(r, 50));
  assert(true, "reaching here without an unhandled rejection is the assertion");
});
