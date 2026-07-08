import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FlowHistory } from "../src/state/flow.ts";

Deno.test("FlowHistory — tracks steps with status", () => {
  const history = new FlowHistory(50);
  const s0 = history.push("test:validate");
  const s1 = history.push("test:submit");
  history.markOk(s0);
  history.markError(s1);
  assertEquals(history.entries(), [
    { step: 0, action: "test:validate", status: "ok" },
    { step: 1, action: "test:submit", status: "error" },
  ]);
});

Deno.test("FlowHistory — caps at max entries", () => {
  const history = new FlowHistory(5);
  for (let i = 0; i < 10; i++) history.push(`action${i}`);
  const entries = history.entries();
  assertEquals(entries.length, 5);
  assertEquals(entries[0]!.step, 5); // oldest evicted
});

Deno.test("FlowHistory — entries returns copy", () => {
  const history = new FlowHistory(50);
  history.push("test:a");
  const e1 = history.entries();
  history.push("test:b");
  const e2 = history.entries();
  assertEquals(e1.length, 1);
  assertEquals(e2.length, 2);
});

Deno.test("FlowHistory — new steps start as pending", () => {
  const history = new FlowHistory(50);
  history.push("test:a");
  assertEquals(history.entries()[0]!.status, "pending");
});
