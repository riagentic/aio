// Tests for broadcast-utils.ts — subscription-aware filtering
import { assert, assertEquals } from "@std/assert";
import {
  filterPatchesBySubs,
  filterStateBySubs,
  MAX_SUB_LEN,
  MAX_SUBS,
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

// ── the subs frame is client-supplied, and was unbounded ─────────────
//
// One frame could declare a million subscription paths. The parsed Set is held
// per CONNECTION and walked on EVERY broadcast, so the cost is permanent and
// per-client — anonymous-reachable on a public app, while the `op` handler
// directly below it in server-ws.ts validates rigorously.

Deno.test("parseSubs: a frame past the path cap is refused, loudly", () => {
  const said: string[] = [];
  const w = console.warn, e = console.error;
  console.warn = (...a: unknown[]) => said.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => said.push(a.map(String).join(" "));
  try {
    const flood = Array.from({ length: MAX_SUBS + 1 }, (_, i) => `c${i}`);
    assertEquals(
      parseSubs(flood),
      undefined,
      "an oversized subs frame must be refused, not truncated: a client " +
        "that thinks it is subscribed to something it is not gets a UI that " +
        "silently stops updating",
    );
    // A million-string frame is the real shape — and must not be walked.
    assertEquals(parseSubs(new Array(1_000_000).fill("c")), undefined);
    // Even with the wildcard in it: the frame itself is the abuse.
    assertEquals(parseSubs([...flood, "*"]), undefined);
    assert(
      said.some((m) => m.includes("subs frame refused")),
      `a silent cap is the same defect one level down: ${JSON.stringify(said)}`,
    );
  } finally {
    console.warn = w;
    console.error = e;
  }
});

Deno.test("parseSubs: a path past the length cap is refused", () => {
  const w = console.warn, e = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    assertEquals(parseSubs(["ok", "x".repeat(MAX_SUB_LEN + 1)]), undefined);
    // The honest cases keep working, in both spellings.
    assertEquals(
      parseSubs(["todos", "todos.items"]),
      new Set(["todos", "todos.items"]),
    );
    assertEquals(parseSubs('["todos"]'), new Set(["todos"]));
    assertEquals(parseSubs(["*"]), null);
    assertEquals(parseSubs("not json"), undefined);
    assertEquals(
      parseSubs(Array.from({ length: MAX_SUBS }, (_, i) => `c${i}`))?.size,
      MAX_SUBS,
      "the cap itself is allowed — an off-by-one here breaks real clients",
    );
  } finally {
    console.warn = w;
    console.error = e;
  }
});
