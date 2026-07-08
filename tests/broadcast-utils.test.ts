// Tests for broadcast-utils.ts — subscription-aware filtering
import { assertEquals } from "@std/assert";
import {
  filterPatchesBySubs,
  filterStateBySubs,
  parseSubs,
  type PatchEntry,
} from "../src/protocol/broadcast-utils.ts";

// ── filterStateBySubs ──────────────────────────────────────────────

Deno.test("filterStateBySubs: null subs returns state as-is", () => {
  const state = { counter: { count: 1 }, auth: { user: "x" } };
  assertEquals(filterStateBySubs(state, null), state);
});

Deno.test("filterStateBySubs: filters to subscribed top-level keys", () => {
  const state = { counter: { count: 1 }, auth: { user: "x" }, logs: [] };
  const subs = new Set(["counter", "auth"]);
  assertEquals(filterStateBySubs(state, subs), {
    counter: { count: 1 },
    auth: { user: "x" },
  });
});

Deno.test("filterStateBySubs: dotted sub extracts top-level key", () => {
  const state = { counter: { count: 1 }, auth: { user: "x" } };
  const subs = new Set(["counter.count"]);
  assertEquals(filterStateBySubs(state, subs), { counter: { count: 1 } });
});

Deno.test("filterStateBySubs: empty subs returns empty object", () => {
  const state = { counter: { count: 1 } };
  assertEquals(filterStateBySubs(state, new Set()), {});
});

Deno.test("filterStateBySubs: missing key in state is skipped", () => {
  const state = { counter: { count: 1 } };
  const subs = new Set(["nonexistent"]);
  assertEquals(filterStateBySubs(state, subs), {});
});

Deno.test("filterStateBySubs: duplicate top-level from multiple dotted subs", () => {
  const state = { counter: { count: 1, total: 5 } };
  const subs = new Set(["counter.count", "counter.total"]);
  const result = filterStateBySubs(state, subs);
  assertEquals(result, { counter: { count: 1, total: 5 } });
});

// ── filterPatchesBySubs ────────────────────────────────────────────

Deno.test("filterPatchesBySubs: null subs returns all patches", () => {
  const patches: PatchEntry[] = [
    { cell: "counter", ops: [{ op: "replace", path: ["count"], value: 1 }] },
    { cell: "auth", ops: [{ op: "replace", path: ["user"], value: "x" }] },
  ];
  assertEquals(filterPatchesBySubs(patches, null), patches);
});

Deno.test("filterPatchesBySubs: filters to matching cells", () => {
  const patches: PatchEntry[] = [
    { cell: "counter", ops: [{ op: "replace", path: ["count"], value: 1 }] },
    { cell: "auth", ops: [{ op: "replace", path: ["user"], value: "x" }] },
    { cell: "logs", ops: [{ op: "add", path: ["0"], value: "entry" }] },
  ];
  const subs = new Set(["counter", "logs"]);
  const result = filterPatchesBySubs(patches, subs);
  assertEquals(result.length, 2);
  assertEquals(result[0]!.cell, "counter");
  assertEquals(result[1]!.cell, "logs");
});

Deno.test("filterPatchesBySubs: dotted sub matches cell prefix", () => {
  const patches: PatchEntry[] = [
    { cell: "counter", ops: [{ op: "replace", path: ["count"], value: 1 }] },
  ];
  const subs = new Set(["counter.count"]);
  assertEquals(filterPatchesBySubs(patches, subs).length, 1);
});

Deno.test("filterPatchesBySubs: empty subs filters everything", () => {
  const patches: PatchEntry[] = [
    { cell: "counter", ops: [{ op: "replace", path: ["count"], value: 1 }] },
  ];
  assertEquals(filterPatchesBySubs(patches, new Set()).length, 0);
});

Deno.test("filterPatchesBySubs: no match returns empty", () => {
  const patches: PatchEntry[] = [
    { cell: "counter", ops: [{ op: "replace", path: ["count"], value: 1 }] },
  ];
  const subs = new Set(["auth"]);
  assertEquals(filterPatchesBySubs(patches, subs).length, 0);
});

// ── parseSubs ──────────────────────────────────────────────────────

Deno.test("parseSubs: wildcard returns null", () => {
  assertEquals(parseSubs(JSON.stringify(["*"])), null);
});

Deno.test("parseSubs: string array returns Set", () => {
  const result = parseSubs(JSON.stringify(["counter", "auth"]));
  assertEquals(result instanceof Set, true);
  assertEquals(result!.size, 2);
  assertEquals(result!.has("counter"), true);
  assertEquals(result!.has("auth"), true);
});

Deno.test("parseSubs: filters non-string entries", () => {
  const result = parseSubs(JSON.stringify(["counter", 42, null, "auth"]));
  assertEquals(result!.size, 2);
});

Deno.test("parseSubs: non-array returns undefined", () => {
  assertEquals(parseSubs(JSON.stringify({ foo: 1 })), undefined);
});

Deno.test("parseSubs: invalid JSON returns undefined", () => {
  assertEquals(parseSubs("not json"), undefined);
});

Deno.test("parseSubs: empty array returns empty Set", () => {
  const result = parseSubs(JSON.stringify([]));
  assertEquals(result instanceof Set, true);
  assertEquals(result!.size, 0);
});
