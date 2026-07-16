// Test-time schedule firing (risoto): ui.advance(ms) / bootCells advance fire
// schedule.after/every deterministically — toast auto-dismiss, debounce,
// backoff, poll are now unit-testable without real timers.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { cell } from "../src/state/cell-create.ts";
import { schedule } from "../src/state/schedule.ts";
import { bootCells, testUI } from "../src/testing/cell-test.ts";

const toast = cell("toast", {
  state: { msg: "" },
  methods: {
    push(s: { msg: string }, m: string) {
      s.msg = m;
      return [
        schedule.after("dismiss", 3000, { type: "toast:clear", payload: {} }),
      ];
    },
    clear(s: { msg: string }) {
      s.msg = "";
    },
  },
});
const T = toast as unknown as {
  push: (m: string) => Promise<void>;
  msg: string;
};

Deno.test("ui.advance fires the scheduled auto-dismiss", async () => {
  const ui = await testUI(() => h("div", null, T.msg), {
    document: new Window().document as any,
  });
  await T.push("hello");
  await ui.settle();
  assertEquals(T.msg, "hello");
  await ui.advance(2999);
  assertEquals(T.msg, "hello");
  await ui.advance(1);
  assertEquals(T.msg, "");
  await ui.dispose();
});
Deno.test("bootCells + advance (no DOM)", async () => {
  const hb = await bootCells([toast as any]);
  await T.push("x");
  await hb.settle();
  assertEquals(T.msg, "x");
  await hb.advance(3000);
  assertEquals(T.msg, "");
  hb.dispose();
});
