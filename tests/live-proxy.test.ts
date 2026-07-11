// tests/live-proxy.test.ts
// Tests for createLiveProxy traps: has, ownKeys, getOwnPropertyDescriptor

import { assertEquals } from "@std/assert";
import { createBatcher, createLiveProxy } from "../src/state/cell-impl.ts";

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

// ── Read-your-writes (the async-method stale-read footgun, fixed) ────
// `s.x = 5; use(s.x)` inside an async method must behave like sync code:
// reads see committed state with THIS batch's pending writes overlaid, and
// what you read is exactly what commits (overlay replays applyMutations).

Deno.test("liveProxy RYW: scalar read-after-write returns the new value", () => {
  const { proxy } = makeProxy({ n: 0 as number, other: "x" });
  proxy.n = 5;
  assertEquals(proxy.n, 5);
  proxy.n = proxy.n + 1; // increment through the proxy
  assertEquals(proxy.n, 6);
  assertEquals(proxy.other, "x"); // untouched fields still read committed
});

Deno.test("liveProxy RYW: the dashboard pattern — push reads freshly-set fields", () => {
  const { proxy } = makeProxy({
    cpu: 0 as number,
    history: [] as { cpu: number }[],
  });
  proxy.cpu = 42;
  proxy.history.push({ cpu: proxy.cpu });
  assertEquals(proxy.history.length, 1);
  assertEquals(proxy.history[0]!.cpu, 42);
});

Deno.test("liveProxy RYW: array mutator return values see pending state", () => {
  const { proxy } = makeProxy({ items: [1, 2] as number[] });
  proxy.items.push(3);
  assertEquals(proxy.items.length, 3);
  assertEquals(proxy.items.pop(), 3); // pops the value pushed a line ago
  assertEquals(proxy.items.length, 2);
});

Deno.test("liveProxy RYW: read methods (map/filter/includes) see pending writes", () => {
  const { proxy } = makeProxy({ items: [1] as number[] });
  proxy.items.push(2);
  assertEquals(proxy.items.includes(2), true);
  assertEquals(proxy.items.map((x) => x * 10), [10, 20]);
});

Deno.test("liveProxy RYW: keys/in/spread/JSON see pending set + delete", () => {
  const { proxy } = makeProxy(
    { a: 1, b: 2 } as Record<string, number | undefined>,
  );
  proxy.c = 3;
  delete proxy.b;
  assertEquals("c" in proxy, true);
  assertEquals("b" in proxy, false);
  assertEquals(Object.keys(proxy).sort(), ["a", "c"]);
  assertEquals(JSON.parse(JSON.stringify(proxy)), { a: 1, c: 3 });
});

Deno.test("liveProxy RYW: nested object writes are readable", () => {
  const { proxy } = makeProxy({ obj: { a: 1, b: 2 } });
  proxy.obj.a = 10;
  assertEquals(proxy.obj.a, 10);
  assertEquals(proxy.obj.b, 2);
});

Deno.test("liveProxy RYW: what you read is exactly what commits", async () => {
  // Full loop: batched dispatch applies the same mutations the reads showed.
  const committed: Record<string, unknown> = { cpu: 0, history: [] };
  let dispatched: { mutations: unknown[] } | null = null;
  const batcher = createBatcher("m", (a) => {
    dispatched = a.payload as { mutations: unknown[] };
  });
  const proxy = createLiveProxy(
    "m",
    "m",
    "poll",
    () => committed as Record<string, unknown>,
    batcher,
  ) as { cpu: number; history: { cpu: number }[] };
  proxy.cpu = 7;
  proxy.history.push({ cpu: proxy.cpu });
  const seen = JSON.parse(JSON.stringify(proxy));
  await new Promise((r) => setTimeout(r, 0)); // let the microtask flush
  const { applyMutations } = await import("../src/state/cell-impl.ts");
  applyMutations(
    committed,
    (dispatched as unknown as { mutations: never[] }).mutations,
  );
  assertEquals(committed, seen); // read view === committed outcome
});

Deno.test("liveProxy RYW: external commits stay visible (still live)", () => {
  const { proxy, setState } = makeProxy({ n: 0 as number, m: 0 as number });
  proxy.n = 1;
  setState({ n: 0, m: 99 }); // another dispatch commits mid-method
  assertEquals(proxy.m, 99); // live read of the external change
  assertEquals(proxy.n, 1); // my pending write still overlays
});
