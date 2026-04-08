// tests/live-proxy.test.ts
// Tests for createLiveProxy traps: has, ownKeys, getOwnPropertyDescriptor

import { assertEquals } from "@std/assert";
import { createBatcher, createLiveProxy } from "../src/cell-impl.ts";

function makeProxy<S extends Record<string, unknown>>(state: S) {
  let current = state;
  const batcher = createBatcher("test", () => {});
  const proxy = createLiveProxy<S>(
    "test",
    "test",
    "testMethod",
    () => current,
    batcher,
  );
  return {
    proxy,
    setState: (s: S) => {
      current = s;
    },
  };
}

// ── ownKeys / Object.keys ─────────────────────────────────────────

Deno.test("liveProxy: Object.keys returns state keys", () => {
  const { proxy } = makeProxy({ a: 1, b: 2, c: 3 });
  assertEquals(Object.keys(proxy), ["a", "b", "c"]);
});

Deno.test("liveProxy: spread operator copies all properties", () => {
  const { proxy } = makeProxy({ x: 10, y: 20 });
  const copy = { ...proxy };
  assertEquals(copy, { x: 10, y: 20 });
});

// ── has / in operator ─────────────────────────────────────────────

Deno.test("liveProxy: 'in' operator detects existing key", () => {
  const { proxy } = makeProxy({ name: "test" });
  assertEquals("name" in proxy, true);
});

Deno.test("liveProxy: 'in' operator returns false for missing key", () => {
  const { proxy } = makeProxy({ name: "test" });
  assertEquals("missing" in proxy, false);
});

// ── getOwnPropertyDescriptor ──────────────────────────────────────

Deno.test("liveProxy: Object.entries works", () => {
  const { proxy } = makeProxy({ a: 1, b: 2 });
  const entries = Object.entries(proxy);
  assertEquals(entries, [["a", 1], ["b", 2]]);
});

Deno.test("liveProxy: JSON.stringify works", () => {
  const { proxy } = makeProxy({ count: 42, name: "test" });
  const json = JSON.parse(JSON.stringify(proxy));
  assertEquals(json, { count: 42, name: "test" });
});

// ── Nested proxy traps ────────────────────────────────────────────

Deno.test("liveProxy: nested spread works", () => {
  const { proxy } = makeProxy({ nested: { a: 1, b: 2 } });
  const nested = proxy.nested as Record<string, unknown>;
  const copy = { ...nested };
  assertEquals(copy, { a: 1, b: 2 });
});

Deno.test("liveProxy: array .map() works via has trap", () => {
  const { proxy } = makeProxy({ items: [{ id: "a" }, { id: "b" }] });
  const items = proxy.items as Array<{ id: string }>;
  const ids = items.map((item) => item.id);
  assertEquals(ids, ["a", "b"]);
});

// ── Fresh reads ───────────────────────────────────────────────────

Deno.test("liveProxy: ownKeys reflects state changes", () => {
  const { proxy, setState } = makeProxy({ a: 1 } as Record<string, unknown>);
  assertEquals(Object.keys(proxy), ["a"]);
  setState({ a: 1, b: 2 });
  assertEquals(Object.keys(proxy), ["a", "b"]);
});

// ── AIO-77: Batcher method isolation ─────────────────────────────

Deno.test("batcher: concurrent methods dispatch separate actions", async () => {
  const actions: { type: string }[] = [];
  const batcher = createBatcher(
    "feat",
    (a) => actions.push(a as typeof actions[0]),
  );

  batcher.add("fetchPrices", { path: ["prices"], value: [100] });
  // Different method → flushes "fetchPrices" synchronously, queues "updateUI"
  batcher.add("updateUI", { path: ["ui", "tab"], value: "chart" });

  assertEquals(
    actions.length,
    1,
    "first batch flushed synchronously on method change",
  );
  assertEquals(actions[0]!.type, "feat:__setFetchPrices");

  await new Promise<void>((r) => queueMicrotask(r));

  assertEquals(actions.length, 2, "second batch flushed via microtask");
  assertEquals(actions[1]!.type, "feat:__setUpdateUI");
});

Deno.test("batcher: same method batches into one action", async () => {
  const actions: { type: string }[] = [];
  const batcher = createBatcher(
    "feat",
    (a) => actions.push(a as typeof actions[0]),
  );

  batcher.add("update", { path: ["a"], value: 1 });
  batcher.add("update", { path: ["b"], value: 2 });

  await new Promise<void>((r) => queueMicrotask(r));

  assertEquals(actions.length, 1, "same method should batch into one action");
  assertEquals(actions[0]!.type, "feat:__setUpdate");
});
