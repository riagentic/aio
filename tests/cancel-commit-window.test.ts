// Cancellation is not an excuse to stop answering for what already committed.
//
// A cancelled transactional call took an early exit that discarded its buffer
// and resolved — the ONE exit that skipped `batcher.settled()`. So a write-set
// an earlier `s.$commit()` had already dispatched and the store had REFUSED
// resolved its caller as if it had landed: the exact class `settled()` was
// added to kill, reachable through the cancellation path it did not cover.
//
// (The same commit sequence also holds the call's AbortController tracked past
// the method body now: `untrack()` used to run on a `.finally` in FRONT of
// `guardCommit`/`flush`/`settled`, so a trigger landing in that window found
// nothing to abort. That window is one microtask wide and is not
// deterministically constructible in-process; what IS observable is below.)
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";
import { notifyMethodCancel } from "../src/state/method-cancel.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("cancelOn: a cancelled call still reports a $commit the store refused", async () => {
  let openA!: () => void, openB!: () => void;
  const g1 = new Promise<void>((r) => openA = r);
  const g2 = new Promise<void>((r) => openB = r);
  const c = cell("cancel_settled", {
    // `warn` so the mid-method $commit is not stopped by conflict detection —
    // the point here is what happens to a write-set the STORE refuses.
    transaction: { conflict: "warn" },
    cancelOn: { run: ["cancel_settled:stop"] },
    state: { list: [] as Any, n: 0 },
    methods: {
      async run(s: Any) {
        const l = s.list;
        await g1; // …`clear()` runs here: `list` is no longer an array
        l.push(1); // a `push` op recorded against `list`
        s.$commit(); // dispatched — and refused at the commit
        await g2; // …the cancel trigger fires here
        s.n = 1;
      },
      clear(s: Any) {
        s.list = null;
      },
      stop(_s: Any) {},
    },
  } as Any);
  const h = await bootCells([c]);
  try {
    const outcome = (c as Any).run().then(
      () => "resolved",
      (e: unknown) => `rejected:${String(e)}`,
    );
    await Promise.resolve();
    (c as Any).clear();
    openA();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    notifyMethodCancel("cancel_settled:stop");
    openB();
    const r = await outcome;
    // It used to be "resolved": the caller was told its published write had
    // landed, and only a console line said otherwise.
    assertEquals(r.startsWith("rejected:"), true, r);
    assertEquals(r.includes("REFUSED at commit"), true, r);
  } finally {
    h.dispose();
  }
});
