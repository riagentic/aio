// A registered call is settled by the executor that runs the method — unless
// the method never runs. A refusal at the dispatch door (time travel paused,
// dispatch closed or draining, queue overflow, a reducer throw) rejects the
// DISPATCH promise and nothing else; every site did
// `void dispatch(...).catch(() => {})` and returned the registration, so a
// sync caller heard the refusal instantly while an async caller waited the
// full call ceiling and was then told the method "may still be running" —
// about a method that had never started.
//
// `dispatchTracked` is the one place that starts a tracked call, and it
// settles the registration with the door's own rejection. Table over the ways
// a dispatch can refuse: async rejection, synchronous throw, non-Error
// rejection — and the one way it must NOT interfere: a dispatch that resolves,
// where the executor still owns the settlement.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  _resetCallTimeouts,
  _setCallTimeouts,
  dispatchTracked,
  resetPending,
  resolveCall,
} from "../src/state/cell-impl.ts";
import { createAioError } from "../src/diagnostics/error.ts";

type A = { type: string; payload?: { _callId?: string } };

const refusals: {
  kind: string;
  dispatch: (a: A) => unknown;
  expect: RegExp;
}[] = [
  {
    kind: "time travel paused (async rejection, AioError)",
    dispatch: () =>
      Promise.reject(
        createAioError("DISPATCH_CLOSED", "time travel is paused — dropped", {
          actionType: "jobs:__exec",
        }),
      ),
    expect: /paused/,
  },
  {
    kind: "dispatch draining",
    dispatch: () =>
      Promise.reject(
        createAioError("DISPATCH_DRAINING", "dispatch is draining — refused", {
          actionType: "jobs:__exec",
        }),
      ),
    expect: /draining/,
  },
  {
    kind: "dispatch closed / sealed",
    dispatch: () =>
      Promise.reject(
        createAioError("DISPATCH_CLOSED", "dispatch after close() — dropped", {
          actionType: "jobs:__exec",
        }),
      ),
    expect: /close\(\)/,
  },
  {
    kind: "queue overflow",
    dispatch: () =>
      Promise.reject(
        createAioError("QUEUE_OVERFLOW", "dispatch queue depth exceeded", {
          actionType: "jobs:__exec",
        }),
      ),
    expect: /queue depth/,
  },
  {
    kind: "reducer threw (REDUCE_ERROR)",
    dispatch: () =>
      Promise.reject(
        createAioError("REDUCE_ERROR", new Error("boom in reduce"), {
          actionType: "jobs:__exec",
        }),
      ),
    expect: /boom in reduce/,
  },
  {
    kind: "synchronous throw from dispatch()",
    dispatch: () => {
      throw new Error("threw before queueing");
    },
    expect: /threw before queueing/,
  },
  {
    kind: "non-Error rejection is wrapped, not lost",
    dispatch: () => Promise.reject("a bare string"),
    expect: /a bare string/,
  },
];

for (const row of refusals) {
  Deno.test(`dispatchTracked: ${row.kind} settles the caller at once, with the door's message`, async () => {
    resetPending();
    _resetCallTimeouts();
    const t0 = performance.now();
    const err = await assertRejects(
      () => dispatchTracked(row.dispatch, { type: "jobs:__exec" }, "c1"),
    );
    const took = performance.now() - t0;
    assert(
      took < 100,
      `settled in ${
        took.toFixed(1)
      }ms — the caller must hear the refusal now, not at the ${30_000}ms ceiling`,
    );
    const msg = String((err as Error).message ?? err);
    assert(row.expect.test(msg), `carries the door's reason, got: ${msg}`);
    assert(
      !/may still be running/.test(msg),
      `"may still be running" is only true of a method that RAN, got: ${msg}`,
    );
  });
}

Deno.test("dispatchTracked: a dispatch that resolves leaves the settlement to the executor", async () => {
  resetPending();
  _resetCallTimeouts();
  let settled = false;
  const p = dispatchTracked(
    () => Promise.resolve("reduce prefix, not the value"),
    { type: "jobs:__exec" },
    "c2",
    "jobs:run",
  );
  p.then(() => (settled = true), () => (settled = true));
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(settled, false, "still pending — the method is running");
  resolveCall("c2", 42);
  assertEquals(await p, 42, "the executor's value, not the dispatch result");
});

Deno.test("dispatchTracked: the executor's throw still reaches the awaiter", async () => {
  resetPending();
  _resetCallTimeouts();
  const p = dispatchTracked(
    () => Promise.resolve(),
    { type: "jobs:__exec" },
    "c3",
    "jobs:run",
  );
  resolveCall("c3", undefined, new Error("the disk said no"));
  const err = await assertRejects(() => p);
  assertEquals((err as Error).message, "the disk said no");
});

Deno.test("dispatchTracked: a fire-and-forget refused call raises no unhandled rejection", async () => {
  resetPending();
  _resetCallTimeouts();
  dispatchTracked(
    () => Promise.reject(new Error("refused")),
    { type: "jobs:__exec" },
    "c4",
  ); // deliberately not awaited, not caught
  await new Promise((r) => setTimeout(r, 30));
  assert(true, "reaching here without an unhandled rejection is the assertion");
});

Deno.test("dispatchTracked: a refusal that beats the ceiling wins over it (no double settle)", async () => {
  resetPending();
  _setCallTimeouts(50);
  try {
    const err = await assertRejects(() =>
      dispatchTracked(
        () => Promise.reject(new Error("refused at the door")),
        { type: "jobs:__exec" },
        "c5",
        "jobs:run",
      )
    );
    assertEquals((err as Error).message, "refused at the door");
    await new Promise((r) => setTimeout(r, 80)); // ceiling would have fired
  } finally {
    _resetCallTimeouts();
  }
});
