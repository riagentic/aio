// An async method's `s` is a live view of state. It used to stay live FOREVER:
// a `setTimeout`, an event listener, a `.then` nobody awaited — any callback
// that outlived the method could still assign through it, and the write
// COMMITTED: persisted, broadcast, `ok: true`, and not a line in any log.
// Immer revokes a sync method's draft the moment the method returns; the async
// view refused nothing. Now the view is sealed when the call settles, and a
// late write throws by cell, method and path — dev, prod and every harness.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testCell } from "../src/testing/cell-test.ts";

const late: { error?: string } = {};

const counter = cell("counter", {
  state: { count: 0, log: [] as string[] },
  methods: {
    async bump(s) {
      await new Promise((r) => setTimeout(r, 1));
      s.count = 1;
      setTimeout(() => {
        try {
          s.count = 4242;
        } catch (e) {
          late.error = String(e);
        }
      }, 5);
    },
    async bumpLive(s) {
      const view = s.$live;
      await new Promise((r) => setTimeout(r, 1));
      setTimeout(() => {
        try {
          view.log.push("late");
        } catch (e) {
          late.error = String(e);
        }
      }, 5);
    },
  },
});

testCell(
  counter,
  "a write after the method settled throws by name and lands nowhere",
  async (t) => {
    late.error = undefined;
    await t.send.bump();
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(t.state.count, 1, "the late write did not commit");
    assertStringIncludes(
      late.error ?? "(no error)",
      "[counter:bump] write after the method finished: s.count",
    );
    assertStringIncludes(late.error ?? "", "outlived bump()");
  },
);

testCell(counter, "s.$live is sealed with the method too", async (t) => {
  late.error = undefined;
  await t.send.bumpLive();
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(t.state.log, [], "the late push did not commit");
  assertStringIncludes(
    late.error ?? "(no error)",
    "[counter:bumpLive] write after the method finished",
  );
});
