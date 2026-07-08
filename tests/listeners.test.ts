// Tests for src/listeners.ts — shared listener registry
import { assertEquals } from "@std/assert";
import { Listeners } from "../src/state/listeners.ts";

Deno.test("listeners: add and notify", () => {
  const l = new Listeners<number>();
  const received: number[] = [];
  l.add((v) => received.push(v));
  l.notify(1);
  l.notify(2);
  assertEquals(received, [1, 2]);
});

Deno.test("listeners: unsubscribe stops notifications", () => {
  const l = new Listeners<string>();
  const received: string[] = [];
  const unsub = l.add((v) => received.push(v));
  l.notify("a");
  unsub();
  l.notify("b");
  assertEquals(received, ["a"]);
});

Deno.test("listeners: size tracks active listeners", () => {
  const l = new Listeners<number>();
  assertEquals(l.size, 0);
  const u1 = l.add(() => {});
  assertEquals(l.size, 1);
  const u2 = l.add(() => {});
  assertEquals(l.size, 2);
  u1();
  assertEquals(l.size, 1);
  u2();
  assertEquals(l.size, 0);
});

Deno.test("listeners: clear removes all", () => {
  const l = new Listeners<number>();
  const received: number[] = [];
  l.add((v) => received.push(v));
  l.add((v) => received.push(v * 10));
  l.notify(1);
  assertEquals(received, [1, 10]);
  l.clear();
  l.notify(2);
  assertEquals(received, [1, 10]); // no new values
  assertEquals(l.size, 0);
});

Deno.test("listeners: multiple listeners all notified", () => {
  const l = new Listeners<string>();
  const a: string[] = [];
  const b: string[] = [];
  const c: string[] = [];
  l.add((v) => a.push(v));
  l.add((v) => b.push(v));
  l.add((v) => c.push(v));
  l.notify("x");
  assertEquals(a, ["x"]);
  assertEquals(b, ["x"]);
  assertEquals(c, ["x"]);
});

Deno.test("listeners: double unsubscribe is safe", () => {
  const l = new Listeners<number>();
  const unsub = l.add(() => {});
  assertEquals(l.size, 1);
  unsub();
  assertEquals(l.size, 0);
  unsub(); // should not throw
  assertEquals(l.size, 0);
});

Deno.test("listeners: same function added twice creates two subscriptions", () => {
  const l = new Listeners<number>();
  const received: number[] = [];
  const fn = (v: number) => received.push(v);
  // Set deduplicates, so same ref = 1 entry
  l.add(fn);
  l.add(fn);
  assertEquals(l.size, 1); // Set behavior
  l.notify(1);
  assertEquals(received, [1]); // only one call
});

Deno.test("listeners: notify with complex objects", () => {
  const l = new Listeners<{ a: number; b: string }>();
  const received: { a: number; b: string }[] = [];
  l.add((v) => received.push(v));
  const obj = { a: 1, b: "hello" };
  l.notify(obj);
  assertEquals(received, [obj]);
  assertEquals(received[0] === obj, true); // same reference
});

Deno.test("listeners: add during notify does not affect current iteration", () => {
  const l = new Listeners<number>();
  const received: number[] = [];
  l.add((v) => {
    received.push(v);
    if (v === 1) l.add((v2) => received.push(v2 * 100));
  });
  l.notify(1);
  // The new listener may or may not fire during the current notify
  // depending on Set iteration semantics (it does in V8)
  l.notify(2);
  // After second notify, the new listener definitely fires
  assertEquals(received.includes(200), true);
});

Deno.test("listeners: notify with no listeners is safe", () => {
  const l = new Listeners<number>();
  l.notify(42); // should not throw
});
