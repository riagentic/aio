// A cancelOn trigger is a claim on ONE binding's in-flight calls, and it used
// to outlive the binding.
//
// `registerCancelOn` runs on every compose; nothing ever undid it. So the
// registry only grew — one entry per cell name for the life of the process —
// and, worse, the NEXT app to use a name inherited the dead app's triggers:
// a method aborted by an action its own cell never listed. Every sequential
// test, every dev restart and every second `testServer()` walks this path.
import { assertEquals } from "@std/assert";
import {
  _cancelTriggerCount,
  _resetMethodCancel,
} from "../src/state/method-cancel.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("cancelOn: triggers are released with the cells that registered them", async () => {
  _resetMethodCancel();
  assertEquals(_cancelTriggerCount(), 0);

  for (let round = 0; round < 5; round++) {
    // A fresh def each round is the realistic shape: a factory that returns
    // `cell(name, …)`, a dev restart re-evaluating the module, a test file
    // booting its own cells.
    const c = cell(`cancel_round_${round}`, {
      cancelOn: { work: "self" },
      state: { n: 0 },
      methods: {
        async work(s: Any) {
          await tick();
          if (s.$signal.aborted) return;
          s.n++;
        },
      },
    } as Any);
    const h = await bootCells([c]);
    await (c as Any).work();
    h.dispose();
  }
  // Five rounds used to leave five permanent trigger edges behind.
  assertEquals(
    _cancelTriggerCount(),
    0,
    "closing an app left its cancelOn triggers in the registry",
  );
});

Deno.test("cancelOn: a new app does not inherit a dead app's triggers", async () => {
  _resetMethodCancel();
  // App 1: `reset` cancels a running `work()`.
  const first = cell("cancel_inherit", {
    cancelOn: { work: ["cancel_inherit:reset"] },
    state: { n: 0 },
    methods: {
      async work(s: Any) {
        await tick();
        await tick();
        if (s.$signal.aborted) return;
        s.n = 1;
      },
      reset(s: Any) {
        s.n = 0;
      },
    },
  } as Any);
  const h1 = await bootCells([first]);
  h1.dispose();

  // App 2: SAME cell name, and `work()` lists no triggers at all.
  const second = cell("cancel_inherit", {
    state: { n: 0 },
    methods: {
      async work(s: Any) {
        await tick();
        await tick();
        if (s.$signal.aborted) return;
        s.n = 1;
      },
      reset(s: Any) {
        s.n = 0;
      },
    },
  } as Any);
  const h2 = await bootCells([second]);
  try {
    const p = (second as Any).work();
    await tick();
    (second as Any).reset();
    await p;
    // Without the release, app 1's trigger aborted app 2's work() — a method
    // cancelled by an action its own cell never mentions.
    assertEquals((second as Any).n, 1);
  } finally {
    h2.dispose();
  }
});
