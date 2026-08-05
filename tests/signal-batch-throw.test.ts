// tests/signal-batch-throw.test.ts — "a committed write is always published".
//
// batch() used to skip its flush when fn() threw. The writes fn() made before
// throwing are COMMITTED (the signal holds the new value) — skipping the flush
// undoes nothing, it only hides it: subscribers stay queued and the view keeps
// rendering pre-write state. Every DOM event handler runs inside a batch
// (src/air/vdom-props.ts, renderer-hydrate.ts) and so does every server-state
// apply (src/state/state-signals.ts, state-message.ts — where the delta path
// CATCHES the throw, asks for a resync, and the resync's identical values are
// then skipped by `Object.is`: a permanently stale UI with nothing logged).
import { assertEquals, assertThrows } from "@std/assert";
import { batch, computed, effect, signal } from "../src/state/signal.ts";

Deno.test("batch: a write committed before a throw still notifies", () => {
  const a = signal(0);
  let seen = -1;
  effect(() => {
    seen = a.value;
  });
  assertEquals(seen, 0);

  assertThrows(
    () =>
      batch(() => {
        a.set(1);
        throw new Error("handler blew up");
      }),
    Error,
    "handler blew up",
  );

  assertEquals(a.peek(), 1, "the write is committed — nothing rolled it back");
  assertEquals(
    seen,
    1,
    "…so subscribers must have seen it: a signal whose value moved while its " +
      "subscribers still hold the old one is a silent divergence, and the " +
      "next write of the SAME value is skipped by Object.is, so it never heals",
  );
});

Deno.test("batch: the throw is not swallowed by the flush", () => {
  const a = signal(0);
  effect(() => {
    a.value;
    // an effect that itself throws must not mask the original error
    if (a.peek() === 1) throw new Error("effect error");
  });
  assertThrows(
    () =>
      batch(() => {
        a.set(1);
        throw new Error("original");
      }),
    Error,
    "original",
  );
});

Deno.test("batch: a throw does not leave a computed stale for later readers", () => {
  const a = signal(1);
  const double = computed(() => a.value * 2);
  let seen = -1;
  effect(() => {
    seen = double.value;
  });
  assertEquals(seen, 2);

  try {
    batch(() => {
      a.set(5);
      throw new Error("boom");
    });
  } catch { /* expected */ }

  assertEquals(double.peek(), 10, "computed recomputes from the committed dep");
  assertEquals(seen, 10, "and its dependent effect was told");
});

Deno.test("batch: an inner throw does not defer the outer batch's other writes", () => {
  const a = signal(0);
  const b = signal(0);
  let runs = 0;
  effect(() => {
    a.value;
    b.value;
    runs++;
  });
  assertEquals(runs, 1);

  batch(() => {
    a.set(1);
    try {
      batch(() => {
        b.set(2);
        throw new Error("inner");
      });
    } catch { /* swallowed by the caller, as app code does */ }
  });

  assertEquals([a.peek(), b.peek()], [1, 2]);
  assertEquals(runs, 2, "one coalesced notification covering BOTH writes");
});

Deno.test("batch: nothing to flush after a throw with no writes", () => {
  const a = signal(0);
  let runs = 0;
  effect(() => {
    a.value;
    runs++;
  });
  try {
    batch(() => {
      throw new Error("boom");
    });
  } catch { /* expected */ }
  assertEquals(runs, 1, "no spurious re-run");
});
