import { assertEquals } from "@std/assert";
import {
  applyPatches,
  enablePatches,
  type Patch,
  produceWithPatches,
} from "immer";

enablePatches();

Deno.test("produceWithPatches: simple field change", () => {
  const state = { count: 0, label: "test" };
  const [next, patches] = produceWithPatches(state, (d) => {
    d.count = 1;
  });
  assertEquals(next, { count: 1, label: "test" });
  assertEquals(patches.length, 1);
  assertEquals(patches[0]!.op, "replace");
  assertEquals(patches[0]!.path, ["count"]);
  assertEquals(patches[0]!.value, 1);
});

Deno.test("produceWithPatches: no change produces empty patches", () => {
  const state = { count: 0 };
  const [next, patches] = produceWithPatches(state, (_d) => {});
  assertEquals(patches.length, 0);
  assertEquals(next, state);
});

Deno.test("applyPatches: round-trip produces identical state", () => {
  const server = { count: 0, items: [{ id: "a", val: 1 }] };
  const [nextServer, patches] = produceWithPatches(server, (d) => {
    d.count = 5;
    d.items[0]!.val = 99;
    d.items.push({ id: "b", val: 2 });
  });
  const client = { count: 0, items: [{ id: "a", val: 1 }] };
  const nextClient = applyPatches(client, patches);
  assertEquals(nextClient, nextServer);
});

Deno.test("applyPatches: deletion round-trip", () => {
  const server = { a: 1, b: 2, c: 3 } as Record<string, unknown>;
  const [nextServer, patches] = produceWithPatches(server, (d) => {
    delete d.c;
  });
  const client = { a: 1, b: 2, c: 3 } as Record<string, unknown>;
  const nextClient = applyPatches(client, patches);
  assertEquals(nextClient, nextServer);
});

Deno.test("produceWithPatches: nested object change", () => {
  const state = { meta: { views: 100, likes: 50 }, name: "test" };
  const [, patches] = produceWithPatches(state, (d) => {
    d.meta.views = 101;
  });
  assertEquals(patches.length, 1);
  assertEquals(patches[0]!.path, ["meta", "views"]);
});

Deno.test("produceWithPatches: array element update by index", () => {
  const state = {
    orders: [{ id: "A", price: 10 }, { id: "B", price: 20 }],
  };
  const [, patches] = produceWithPatches(state, (d) => {
    d.orders[0]!.price = 11;
  });
  assertEquals(patches.length, 1);
  assertEquals(patches[0]!.path, ["orders", 0, "price"]);
});

Deno.test("produceWithPatches: array push", () => {
  const state = { items: [{ id: "A" }] };
  const [, patches] = produceWithPatches(state, (d) => {
    d.items.push({ id: "B" });
  });
  assertEquals(patches.length, 1);
  assertEquals(patches[0]!.op, "add");
});

// ── handleMessage integration tests ────────────────────────────────

import {
  _getState,
  _injectState,
  _reset,
  getFeatureSignal,
  handleMessage,
} from "../src/state-core.ts";

Deno.test("handleMessage: $patches replace op updates state + feature signal", () => {
  _reset();
  // First inject initial state
  _injectState({ counter: { count: 0 }, user: { name: "Alice" } });

  const result = handleMessage({
    $patches: [{ op: "replace", path: ["counter", "count"], value: 5 }],
  });

  assertEquals(result, "delta");
  assertEquals(_getState().counter.count, 5);
  assertEquals(getFeatureSignal("counter").peek().count, 5);
  // user feature unchanged
  assertEquals(_getState().user.name, "Alice");
  _reset();
});

Deno.test("handleMessage: $patches add op for arrays", () => {
  _reset();
  _injectState({ items: { list: [{ id: "a" }] } });

  const result = handleMessage({
    $patches: [{ op: "add", path: ["items", "list", 1], value: { id: "b" } }],
  });

  assertEquals(result, "delta");
  assertEquals(_getState().items.list.length, 2);
  assertEquals(_getState().items.list[1].id, "b");
  _reset();
});

Deno.test("handleMessage: $patches remove op", () => {
  _reset();
  _injectState({ data: { a: 1, b: 2 } });

  const result = handleMessage({
    $patches: [{ op: "remove", path: ["data", "b"] }],
  });

  assertEquals(result, "delta");
  assertEquals(_getState().data.a, 1);
  assertEquals(_getState().data.b, undefined);
  _reset();
});

Deno.test("handleMessage: empty $patches returns noop", () => {
  _reset();
  _injectState({ x: { val: 1 } });

  const result = handleMessage({ $patches: [] });
  assertEquals(result, "noop");
  _reset();
});

Deno.test("handleMessage: $patches before initial state returns dropped", () => {
  _reset();
  // Don't inject initial state — _initialStateReceived is false

  const result = handleMessage({
    $patches: [{ op: "replace", path: ["foo", "bar"], value: 1 }],
  });

  assertEquals(result, "dropped");
  _reset();
});

Deno.test("handleMessage: $patches affecting multiple features", () => {
  _reset();
  _injectState({ feat1: { a: 1 }, feat2: { b: 2 } });

  const result = handleMessage({
    $patches: [
      { op: "replace", path: ["feat1", "a"], value: 10 },
      { op: "replace", path: ["feat2", "b"], value: 20 },
    ],
  });

  assertEquals(result, "delta");
  assertEquals(getFeatureSignal("feat1").peek().a, 10);
  assertEquals(getFeatureSignal("feat2").peek().b, 20);
  _reset();
});
