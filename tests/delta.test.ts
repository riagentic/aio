import {
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { _computeDelta, flattenKeys, unflattenPatch } from "../src/server.ts";
import {
  _applyPatch,
  _preserveArrayRefs,
  _rebuildIdMaps,
  _shallowEqual,
} from "../src/browser.ts";

// ── Flat state (v0.4 compatible) ────────────────────────────────

Deno.test("computeDelta: first broadcast (null lastState) → full", () => {
  const result = _computeDelta({ a: 1, b: 2 }, null, {});
  assertEquals(result.kind, "full");
  assertEquals(JSON.parse(result.msg), { a: 1, b: 2 });
  assertEquals(result.newKeyJsons, { a: "1", b: "2" });
});

Deno.test("computeDelta: identical content, different ref → skip", () => {
  const lastKeyJsons = { a: "1", b: "2" };
  const result = _computeDelta({ a: 1, b: 2 }, { a: 1, b: 2 }, lastKeyJsons);
  assertEquals(result.kind, "skip");
  assertEquals(result.msg, "");
});

Deno.test("computeDelta: one of three keys changed → delta patch", () => {
  const lastKeyJsons = { a: "1", b: "2", c: "3" };
  const result = _computeDelta(
    { a: 99, b: 2, c: 3 },
    { a: 1, b: 2, c: 3 },
    lastKeyJsons,
  );
  assertEquals(result.kind, "delta");
  const parsed = JSON.parse(result.msg);
  assertEquals(parsed.$p, { a: 99 });
  assertEquals(parsed.$d, undefined);
});

Deno.test("computeDelta: majority changed → full", () => {
  const lastKeyJsons = { a: "1", b: "2" };
  const result = _computeDelta({ a: 10, b: 20 }, { a: 1, b: 2 }, lastKeyJsons);
  assertEquals(result.kind, "full");
  assertEquals(JSON.parse(result.msg), { a: 10, b: 20 });
});

Deno.test("computeDelta: removed keys → delta with $d", () => {
  // 5 keys, remove 1 → changedCount=1, keys.length=4, 1 < 2.0 → delta
  const lastKeyJsons = { a: "1", b: "2", c: "3", d: "4", e: "5" };
  const result = _computeDelta({ a: 1, b: 2, c: 3, d: 4 }, {
    a: 1,
    b: 2,
    c: 3,
    d: 4,
    e: 5,
  }, lastKeyJsons);
  assertEquals(result.kind, "delta");
  const parsed = JSON.parse(result.msg);
  assertEquals(parsed.$p, {});
  assertEquals(parsed.$d, ["e"]);
});

Deno.test("computeDelta: non-object state → always full", () => {
  const result = _computeDelta([1, 2, 3], [1, 2], {});
  assertEquals(result.kind, "full");
  assertEquals(JSON.parse(result.msg), [1, 2, 3]);
});

Deno.test("computeDelta: null uiState → full", () => {
  const result = _computeDelta(null, { a: 1 }, { a: "1" });
  assertEquals(result.kind, "full");
  assertEquals(result.msg, "null");
});

Deno.test("computeDelta: added new key → delta when under threshold", () => {
  const lastKeyJsons = { a: "1", b: "2", c: "3" };
  const result = _computeDelta(
    { a: 1, b: 2, c: 3, d: 4 },
    { a: 1, b: 2, c: 3 },
    lastKeyJsons,
  );
  assertEquals(result.kind, "delta");
  const parsed = JSON.parse(result.msg);
  assertEquals(parsed.$p, { d: 4 });
});

// ── v0.5 namespaced state (nested feature slices) ───────────────

Deno.test("computeDelta: nested — only changed sub-key sent, not full slice", () => {
  const state1 = {
    counter: { count: 0 },
    mdview: { html: "<h1>big</h1>", scrollY: 0, filePath: "/a.md" },
  };
  const state2 = {
    counter: { count: 0 },
    mdview: { html: "<h1>big</h1>", scrollY: 42, filePath: "/a.md" },
  };
  // Build lastKeyJsons from state1 (flattened)
  const lastKeyJsons: Record<string, string> = {
    "counter.count": "0",
    "mdview.html": '"<h1>big</h1>"',
    "mdview.scrollY": "0",
    "mdview.filePath": '"/a.md"',
  };
  const result = _computeDelta(state2, state1, lastKeyJsons);
  assertEquals(result.kind, "delta");
  const parsed = JSON.parse(result.msg);
  // Only scrollY changed — patch should contain only that, nested under mdview
  assertEquals(parsed.$p.mdview, { scrollY: 42 });
  // counter should not be in the patch
  assertEquals(parsed.$p.counter, undefined);
  // html should NOT be in the patch (unchanged)
  assertEquals(parsed.$p.mdview.html, undefined);
});

Deno.test("computeDelta: nested — unchanged state → skip", () => {
  const state = { counter: { count: 5 }, other: { x: 1 } };
  const lastKeyJsons: Record<string, string> = {
    "counter.count": "5",
    "other.x": "1",
  };
  const result = _computeDelta(state, state, lastKeyJsons);
  assertEquals(result.kind, "skip");
});

Deno.test("computeDelta: nested — multiple sub-keys changed in one feature", () => {
  const state1 = { f: { a: 1, b: 2, c: 3, d: 4, e: 5 } };
  const state2 = { f: { a: 10, b: 2, c: 30, d: 4, e: 5 } };
  const lastKeyJsons: Record<string, string> = {
    "f.a": "1",
    "f.b": "2",
    "f.c": "3",
    "f.d": "4",
    "f.e": "5",
  };
  const result = _computeDelta(state2, state1, lastKeyJsons);
  assertEquals(result.kind, "delta");
  const parsed = JSON.parse(result.msg);
  assertEquals(parsed.$p.f, { a: 10, c: 30 });
});

Deno.test("computeDelta: nested — sub-key removed from feature", () => {
  const state1 = { f: { a: 1, b: 2, c: 3, d: 4, e: 5 } };
  const state2 = { f: { a: 1, b: 2, c: 3, d: 4 } }; // e removed
  const lastKeyJsons: Record<string, string> = {
    "f.a": "1",
    "f.b": "2",
    "f.c": "3",
    "f.d": "4",
    "f.e": "5",
  };
  const result = _computeDelta(state2, state1, lastKeyJsons);
  assertEquals(result.kind, "delta");
  const parsed = JSON.parse(result.msg);
  assertEquals(parsed.$p.f.$d, ["e"]);
});

Deno.test("computeDelta: nested — mixed flat and nested keys", () => {
  const state1 = { version: 1, mode: "dev", counter: { count: 0 }, extra: "x" };
  const state2 = { version: 1, mode: "dev", counter: { count: 5 }, extra: "x" };
  const lastKeyJsons: Record<string, string> = {
    version: "1",
    mode: '"dev"',
    "counter.count": "0",
    extra: '"x"',
  };
  const result = _computeDelta(state2, state1, lastKeyJsons);
  assertEquals(result.kind, "delta");
  const parsed = JSON.parse(result.msg);
  assertEquals(parsed.$p.counter, { count: 5 });
  assertEquals(parsed.$p.version, undefined);
});

Deno.test("computeDelta: nested — newKeyJsons uses dot-notation", () => {
  const state = { counter: { count: 0 }, other: { x: 1 } };
  const result = _computeDelta(state, null, {});
  assertEquals(result.kind, "full");
  assertEquals(result.newKeyJsons["counter.count"], "0");
  assertEquals(result.newKeyJsons["other.x"], "1");
  // Top-level keys should NOT exist (they're flattened)
  assertEquals(result.newKeyJsons["counter"], undefined);
});

// ── Browser-side patch application (applyPatch) ───────────────

/** Replicates the browser-side _applyPatch logic from browser.ts */
const _SAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function applyPatch(
  prev: Record<string, unknown> | null,
  msg: string,
): Record<string, unknown> {
  const data = JSON.parse(msg);
  if (data.$p && typeof data.$p === "object") {
    const next = prev ? { ...prev } : {} as Record<string, unknown>;
    for (const [k, v] of Object.entries(data.$p)) {
      if (_SAFE_KEYS.has(k)) continue;
      if (
        v && typeof v === "object" && !Array.isArray(v) && next[k] &&
        typeof next[k] === "object" && !Array.isArray(next[k])
      ) {
        const sub = v as Record<string, unknown>;
        const merged = { ...(next[k] as Record<string, unknown>), ...sub };
        if (Array.isArray(sub.$d)) {
          for (const sk of sub.$d) {
            if (typeof sk === "string" && !_SAFE_KEYS.has(sk)) {
              delete merged[sk];
            }
          }
          delete merged.$d;
        }
        next[k] = merged;
      } else {
        next[k] = v;
      }
    }
    if (Array.isArray(data.$d)) {
      for (const k of data.$d) {
        if (typeof k === "string" && !_SAFE_KEYS.has(k)) delete next[k];
      }
    }
    return next;
  }
  return data;
}

Deno.test("applyPatch: flat patch replaces top-level keys", () => {
  const prev = { a: 1, b: 2 };
  const result = applyPatch(prev, JSON.stringify({ $p: { a: 99 } }));
  assertEquals(result, { a: 99, b: 2 });
});

Deno.test("applyPatch: nested patch shallow-merges into feature slice", () => {
  const prev = {
    counter: { count: 0 },
    mdview: { html: "<h1>big</h1>", scrollY: 0 },
  };
  const result = applyPatch(
    prev,
    JSON.stringify({ $p: { mdview: { scrollY: 42 } } }),
  );
  assertEquals(result.counter, { count: 0 });
  assertEquals(result.mdview, { html: "<h1>big</h1>", scrollY: 42 });
});

Deno.test("applyPatch: nested deletion removes sub-key", () => {
  const prev = { f: { a: 1, b: 2, c: 3 } };
  const result = applyPatch(prev, JSON.stringify({ $p: { f: { $d: ["b"] } } }));
  assertEquals(result.f, { a: 1, c: 3 });
});

Deno.test("applyPatch: top-level deletion", () => {
  const prev = { a: 1, b: 2, c: 3 };
  const result = applyPatch(prev, JSON.stringify({ $p: {}, $d: ["b"] }));
  assertEquals(result.a, 1);
  assertEquals(result.c, 3);
  assertEquals("b" in result, false);
});

Deno.test("applyPatch: proto-pollution blocked in $p keys", () => {
  const prev = { a: 1 };
  const result = applyPatch(
    prev,
    JSON.stringify({ $p: { __proto__: { polluted: true } } }),
  );
  assertEquals(typeof result.toString, "function");
  assertEquals(result.a, 1);
});

Deno.test("applyPatch: proto-pollution blocked in $d", () => {
  const prev = { a: 1, b: 2 } as Record<string, unknown>;
  const result = applyPatch(
    prev,
    JSON.stringify({ $p: {}, $d: ["__proto__"] }),
  );
  assertEquals(typeof result.toString, "function");
  assertEquals(result.a, 1);
});

Deno.test("applyPatch: proto-pollution blocked in nested $d", () => {
  const prev = { f: { a: 1, constructor: "safe" } };
  const result = applyPatch(
    prev,
    JSON.stringify({ $p: { f: { $d: ["constructor", "__proto__"] } } }),
  );
  assertEquals((result.f as Record<string, unknown>)["constructor"], "safe");
});

Deno.test("applyPatch: null prev creates new state", () => {
  const result = applyPatch(null, JSON.stringify({ $p: { a: 1 } }));
  assertEquals(result, { a: 1 });
});

// ── End-to-end: computeDelta → applyPatch ───────────────────────

Deno.test("e2e: nested delta + patch round-trips correctly", () => {
  const state1 = {
    counter: { count: 0 },
    mdview: { html: "<big>", scrollY: 0, file: "/a" },
  };
  const state2 = {
    counter: { count: 0 },
    mdview: { html: "<big>", scrollY: 42, file: "/a" },
  };
  // Init cache from state1
  const lastKeyJsons: Record<string, string> = {};
  const init = _computeDelta(state1, null, {});
  Object.assign(lastKeyJsons, init.newKeyJsons);
  // Compute delta
  const delta = _computeDelta(state2, state1, lastKeyJsons);
  assertEquals(delta.kind, "delta");
  // Apply patch to state1 on client
  const result = applyPatch(state1, delta.msg);
  assertEquals(result, state2);
});

Deno.test("e2e: flat delta + patch round-trips correctly", () => {
  const state1 = { a: 1, b: 2, c: 3 };
  const state2 = { a: 99, b: 2, c: 3 };
  const init = _computeDelta(state1, null, {});
  const delta = _computeDelta(state2, state1, init.newKeyJsons);
  assertEquals(delta.kind, "delta");
  const result = applyPatch(state1, delta.msg);
  assertEquals(result, state2);
});

Deno.test("computeDelta: removed __proto__ key appears in $d (server-side)", () => {
  // Server DOES include __proto__ in $d — browser-side filtering is the defense
  const lastKeyJsons: Record<string, string> = {};
  lastKeyJsons["__proto__"] = '"polluted"';
  lastKeyJsons["a"] = "1";
  lastKeyJsons["b"] = "2";
  lastKeyJsons["c"] = "3";
  lastKeyJsons["d"] = "4";
  const result = _computeDelta({ a: 1, b: 2, c: 3, d: 4 }, {
    a: 1,
    b: 2,
    c: 3,
    d: 4,
  }, lastKeyJsons);
  if (result.kind === "delta") {
    const parsed = JSON.parse(result.msg);
    assertEquals(Array.isArray(parsed.$d), true);
  }
  assertNotEquals(result.kind, "skip", "should detect removed __proto__ key");
});

// ── Structural sharing (_preserveArrayRefs) ─────────────────────

Deno.test("preserveArrayRefs: identical flat objects → restores all references", () => {
  const old0 = { id: "a", price: 100 };
  const old1 = { id: "b", price: 200 };
  const oldArr = [old0, old1];
  // Simulates JSON round-trip — new objects, same values
  const newArr = [{ id: "a", price: 100 }, { id: "b", price: 200 }];
  const result = _preserveArrayRefs(newArr, oldArr);
  assertStrictEquals(result, oldArr, "entire array ref preserved");
  assertStrictEquals(result[0], old0, "element 0 ref preserved");
  assertStrictEquals(result[1], old1, "element 1 ref preserved");
});

Deno.test("preserveArrayRefs: one element changed → new array, unchanged elements preserved", () => {
  const old0 = { id: "a", price: 100 };
  const old1 = { id: "b", price: 200 };
  const oldArr = [old0, old1];
  const newArr = [{ id: "a", price: 100 }, { id: "b", price: 999 }];
  const result = _preserveArrayRefs(newArr, oldArr);
  assertNotEquals(result, oldArr); // new array — something changed
  assertStrictEquals(result[0], old0, "unchanged element 0 preserved");
  assertNotEquals(result[1], old1); // element 1 changed
  assertEquals(result[1], { id: "b", price: 999 });
});

Deno.test("preserveArrayRefs: different lengths → returns new array as-is", () => {
  const oldArr = [{ id: "a" }];
  const newArr = [{ id: "a" }, { id: "b" }];
  const result = _preserveArrayRefs(newArr, oldArr);
  assertStrictEquals(result, newArr);
});

Deno.test("preserveArrayRefs: primitive elements → exact equality", () => {
  const oldArr = [1, 2, 3];
  const newArr = [1, 2, 3];
  const result = _preserveArrayRefs(newArr, oldArr);
  assertStrictEquals(result, oldArr, "all same primitives → old ref");
});

Deno.test("preserveArrayRefs: primitive changed → new array", () => {
  const oldArr = [1, 2, 3];
  const newArr = [1, 99, 3];
  const result = _preserveArrayRefs(newArr, oldArr);
  assertNotEquals(result, oldArr);
});

// ── _applyPatch structural sharing integration ──────────────────

Deno.test("applyPatch: array sub-key preserves unchanged element refs", () => {
  const member0 = { id: "m0", pnl: 10 };
  const member1 = { id: "m1", pnl: 20 };
  const prev = {
    fleet: { members: [member0, member1], filters: { active: true } },
  };
  // Patch: members array with member1.pnl changed, member0 unchanged
  const patch = {
    $p: { fleet: { members: [{ id: "m0", pnl: 10 }, { id: "m1", pnl: 99 }] } },
  };
  const result = _applyPatch(prev as Record<string, unknown>, patch);
  const fleet = result.fleet as Record<string, unknown>;
  const members = fleet.members as Array<Record<string, unknown>>;
  // member0 should keep reference (unchanged)
  assertStrictEquals(members[0], member0, "unchanged member keeps ref");
  // member1 should be new (changed)
  assertNotEquals(members[1], member1);
  assertEquals(members[1], { id: "m1", pnl: 99 });
  // filters not in patch — should keep reference
  assertStrictEquals(
    fleet.filters,
    (prev.fleet as Record<string, unknown>).filters,
  );
});

Deno.test("applyPatch: all array elements unchanged → array ref preserved", () => {
  const members = [{ id: "a", v: 1 }, { id: "b", v: 2 }];
  const prev = { feat: { members, other: "x" } };
  const patch = {
    $p: { feat: { members: [{ id: "a", v: 1 }, { id: "b", v: 2 }] } },
  };
  const result = _applyPatch(prev as Record<string, unknown>, patch);
  const feat = result.feat as Record<string, unknown>;
  assertStrictEquals(
    feat.members,
    members,
    "entire array ref preserved when content identical",
  );
});

Deno.test("applyPatch: non-array sub-keys still work normally", () => {
  const prev = { feat: { count: 5, label: "hi" } };
  const patch = { $p: { feat: { count: 10 } } };
  const result = _applyPatch(prev as Record<string, unknown>, patch);
  const feat = result.feat as Record<string, unknown>;
  assertEquals(feat.count, 10);
  assertEquals(feat.label, "hi");
});

// ── Identity-keyed array flattening (AIO-12) ────────────────────

Deno.test("flattenKeys: array of objects with id → $id: keys", () => {
  const state = {
    fleet: {
      members: [
        { id: "SOL_15m", price: 100 },
        { id: "BTC_1h", price: 50000 },
      ],
    },
  };
  const flat = flattenKeys(state);
  assertEquals(flat["fleet.members.$id:SOL_15m"], {
    id: "SOL_15m",
    price: 100,
  });
  assertEquals(flat["fleet.members.$id:BTC_1h"], {
    id: "BTC_1h",
    price: 50000,
  });
  assertEquals(flat["fleet.members"], undefined); // no atomic array key
});

Deno.test("flattenKeys: array without id fields → atomic (unchanged)", () => {
  const state = { feat: { items: [1, 2, 3] } };
  const flat = flattenKeys(state);
  assertEquals(flat["feat.items"], [1, 2, 3]);
  assertEquals(flat["feat.items.$id:1"], undefined);
});

Deno.test("flattenKeys: mixed array (some elements missing id) → atomic", () => {
  const state = { feat: { items: [{ id: "a" }, { noId: true }] } };
  const flat = flattenKeys(state);
  assertEquals(flat["feat.items"], [{ id: "a" }, { noId: true }]);
});

Deno.test("flattenKeys: empty array → emitted as atomic key (not dropped)", () => {
  const state = { feat: { items: [] as unknown[] } };
  const flat = flattenKeys(state);
  assertEquals(flat["feat.items"], []);
  assertEquals(Object.keys(flat).filter((k) => k.includes("$id:")).length, 0);
});

Deno.test("flattenKeys: null element in array → atomic fallback", () => {
  const state = { feat: { items: [{ id: "a" }, null] } };
  const flat = flattenKeys(state);
  assertEquals(flat["feat.items"], [{ id: "a" }, null]);
});

// ── unflattenPatch with $id: keys (AIO-12) ──────────────────────

Deno.test("unflattenPatch: $id: changed keys → $arr patch", () => {
  const changed: Record<string, unknown> = {
    "fleet.members.$id:SOL_15m": { id: "SOL_15m", price: 142 },
  };
  const result = unflattenPatch(changed, []);
  const members = (result.$p.fleet as Record<string, unknown>)
    .members as Record<string, unknown>;
  assertEquals(members.$arr, true);
  assertEquals(members["$id:SOL_15m"], { id: "SOL_15m", price: 142 });
});

Deno.test("unflattenPatch: $id: removed keys → $rm array", () => {
  const result = unflattenPatch({}, ["fleet.members.$id:DOGE_5m"]);
  const members = (result.$p.fleet as Record<string, unknown>)
    .members as Record<string, unknown>;
  assertEquals(members.$arr, true);
  assertEquals(members.$rm, ["DOGE_5m"]);
});

Deno.test("unflattenPatch: mixed $id: and scalar keys in same feature", () => {
  const changed: Record<string, unknown> = {
    "fleet.members.$id:SOL_15m": { id: "SOL_15m", price: 142 },
    "fleet.status": "active",
  };
  const result = unflattenPatch(changed, []);
  const fleet = result.$p.fleet as Record<string, unknown>;
  assertEquals(fleet.status, "active");
  const members = fleet.members as Record<string, unknown>;
  assertEquals(members.$arr, true);
  assertEquals(members["$id:SOL_15m"], { id: "SOL_15m", price: 142 });
});

Deno.test("unflattenPatch: $id: changed + $id: removed in same array", () => {
  const changed: Record<string, unknown> = {
    "fleet.members.$id:SOL_15m": { id: "SOL_15m", price: 142 },
  };
  const removed = ["fleet.members.$id:DOGE_5m"];
  const result = unflattenPatch(changed, removed);
  const members = (result.$p.fleet as Record<string, unknown>)
    .members as Record<string, unknown>;
  assertEquals(members.$arr, true);
  assertEquals(members["$id:SOL_15m"], { id: "SOL_15m", price: 142 });
  assertEquals(members.$rm, ["DOGE_5m"]);
});

Deno.test("unflattenPatch: non-$id: keys still work (backward compat)", () => {
  const changed: Record<string, unknown> = { "counter.count": 5 };
  const result = unflattenPatch(changed, []);
  assertEquals((result.$p.counter as Record<string, unknown>).count, 5);
});

// ── _computeDelta with identity arrays (AIO-12) ─────────────────

Deno.test("computeDelta: identity array — one element changed → delta with $arr", () => {
  const state1 = {
    fleet: {
      members: [
        { id: "SOL", price: 100 },
        { id: "BTC", price: 50000 },
        { id: "ETH", price: 3000 },
      ],
    },
  };
  const state2 = {
    fleet: {
      members: [
        { id: "SOL", price: 142 },
        { id: "BTC", price: 50000 },
        { id: "ETH", price: 3000 },
      ],
    },
  };
  const init = _computeDelta(state1, null, {});
  const delta = _computeDelta(state2, state1, init.newKeyJsons);
  assertEquals(delta.kind, "delta");
  const parsed = JSON.parse(delta.msg);
  const members = parsed.$p.fleet.members;
  assertEquals(members.$arr, true);
  assertEquals(members["$id:SOL"], { id: "SOL", price: 142 });
  assertEquals(members["$id:BTC"], undefined); // unchanged — not in patch
  assertEquals(members["$id:ETH"], undefined); // unchanged — not in patch
});

Deno.test("computeDelta: identity array — element added → new $id: key", () => {
  // Use 4-element → 5-element transition so added key is <50% of total (1/5 = 20%)
  const state1 = {
    fleet: {
      members: [
        { id: "SOL", price: 100 },
        { id: "BTC", price: 50000 },
        { id: "ETH", price: 3000 },
        { id: "AVAX", price: 40 },
      ],
    },
  };
  const state2 = {
    fleet: {
      members: [
        { id: "SOL", price: 100 },
        { id: "BTC", price: 50000 },
        { id: "ETH", price: 3000 },
        { id: "AVAX", price: 40 },
        { id: "DOT", price: 8 },
      ],
    },
  };
  const init = _computeDelta(state1, null, {});
  const delta = _computeDelta(state2, state1, init.newKeyJsons);
  assertEquals(delta.kind, "delta");
  const parsed = JSON.parse(delta.msg);
  assertEquals(parsed.$p.fleet.members["$id:DOT"], { id: "DOT", price: 8 });
  assertEquals(parsed.$p.fleet.members["$id:SOL"], undefined); // unchanged
  assertEquals(parsed.$p.fleet.members["$id:BTC"], undefined); // unchanged
});

Deno.test("computeDelta: identity array — element removed → $rm", () => {
  // Use 5-element → 4-element transition so removed key is <50% of total (1/5 = 20%)
  const state1 = {
    fleet: {
      members: [
        { id: "SOL", price: 100 },
        { id: "BTC", price: 50000 },
        { id: "ETH", price: 3000 },
        { id: "AVAX", price: 40 },
        { id: "DOGE", price: 0.1 },
      ],
    },
  };
  const state2 = {
    fleet: {
      members: [
        { id: "SOL", price: 100 },
        { id: "BTC", price: 50000 },
        { id: "ETH", price: 3000 },
        { id: "AVAX", price: 40 },
      ],
    },
  };
  const init = _computeDelta(state1, null, {});
  const delta = _computeDelta(state2, state1, init.newKeyJsons);
  assertEquals(delta.kind, "delta");
  const parsed = JSON.parse(delta.msg);
  assertEquals(parsed.$p.fleet.members.$rm, ["DOGE"]);
});

Deno.test("computeDelta: identity array — no changes → skip", () => {
  const state = { fleet: { members: [{ id: "SOL", price: 100 }] } };
  const init = _computeDelta(state, null, {});
  const delta = _computeDelta(state, state, init.newKeyJsons);
  assertEquals(delta.kind, "skip");
});

Deno.test("computeDelta: identity array — all elements changed → may trigger full state", () => {
  const state1 = {
    fleet: { members: [{ id: "A", v: 1 }, { id: "B", v: 2 }] },
  };
  const state2 = {
    fleet: { members: [{ id: "A", v: 99 }, { id: "B", v: 88 }] },
  };
  const init = _computeDelta(state1, null, {});
  const delta = _computeDelta(state2, state1, init.newKeyJsons);
  // 2 of 2 keys changed → 100% → exceeds 50% threshold → full state
  assertEquals(delta.kind, "full");
});

// ── End-to-end: identity array round-trip (AIO-12) ──────────────

Deno.test("e2e identity array: delta + patch round-trips correctly", () => {
  const state1 = {
    fleet: {
      members: [
        { id: "SOL", price: 100, pnl: 0 },
        { id: "BTC", price: 50000, pnl: 10 },
        { id: "ETH", price: 3000, pnl: -5 },
      ],
      status: "running",
    },
  };
  const state2 = {
    fleet: {
      members: [
        { id: "SOL", price: 142, pnl: 4.2 },
        { id: "BTC", price: 50000, pnl: 10 },
        { id: "ETH", price: 3000, pnl: -5 },
      ],
      status: "running",
    },
  };

  const init = _computeDelta(state1, null, {});
  _rebuildIdMaps(state1 as Record<string, unknown>);

  const delta = _computeDelta(state2, state1, init.newKeyJsons);
  assertEquals(delta.kind, "delta");

  const parsed = JSON.parse(delta.msg);
  const result = _applyPatch(state1 as Record<string, unknown>, parsed);
  assertEquals(result, state2);
});

Deno.test("e2e identity array: element added round-trips", () => {
  const state1 = {
    feat: {
      items: [
        { id: "A", v: 1 },
        { id: "B", v: 2 },
        { id: "C", v: 3 },
        { id: "D", v: 4 },
      ],
    },
  };
  const state2 = {
    feat: {
      items: [
        { id: "A", v: 1 },
        { id: "B", v: 2 },
        { id: "C", v: 3 },
        { id: "D", v: 4 },
        { id: "E", v: 5 },
      ],
    },
  };

  const init = _computeDelta(state1, null, {});
  _rebuildIdMaps(state1 as Record<string, unknown>);

  const delta = _computeDelta(state2, state1, init.newKeyJsons);
  assertEquals(delta.kind, "delta");

  const result = _applyPatch(
    state1 as Record<string, unknown>,
    JSON.parse(delta.msg),
  );
  assertEquals(result, state2);
});

Deno.test("e2e identity array: element removed round-trips", () => {
  const state1 = {
    feat: {
      items: [
        { id: "A", v: 1 },
        { id: "B", v: 2 },
        { id: "C", v: 3 },
        { id: "D", v: 4 },
        { id: "E", v: 5 },
      ],
    },
  };
  const state2 = {
    feat: {
      items: [
        { id: "A", v: 1 },
        { id: "C", v: 3 },
        { id: "D", v: 4 },
        { id: "E", v: 5 },
      ],
    },
  };

  const init = _computeDelta(state1, null, {});
  _rebuildIdMaps(state1 as Record<string, unknown>);

  const delta = _computeDelta(state2, state1, init.newKeyJsons);
  assertEquals(delta.kind, "delta");

  const result = _applyPatch(
    state1 as Record<string, unknown>,
    JSON.parse(delta.msg),
  );
  assertEquals(result, state2);
});

Deno.test("e2e identity array: ref identity preserved for unchanged elements", () => {
  const sol = { id: "SOL", price: 100 };
  const btc = { id: "BTC", price: 50000 };
  const eth = { id: "ETH", price: 3000 };
  const state1 = { fleet: { members: [sol, btc, eth] } };
  const state2 = {
    fleet: { members: [{ id: "SOL", price: 142 }, btc, eth] },
  };

  const init = _computeDelta(state1, null, {});
  _rebuildIdMaps(state1 as Record<string, unknown>);

  const delta = _computeDelta(state2, state1, init.newKeyJsons);
  const result = _applyPatch(
    state1 as Record<string, unknown>,
    JSON.parse(delta.msg),
  );
  const members = (result.fleet as Record<string, unknown>).members as Array<
    Record<string, unknown>
  >;

  assertStrictEquals(
    members[1],
    btc,
    "unchanged BTC element keeps ref identity",
  );
  assertStrictEquals(
    members[2],
    eth,
    "unchanged ETH element keeps ref identity",
  );
  assertNotStrictEquals(members[0], sol, "changed SOL element gets new ref");
});

// ── AIO-31: empty→identity array transition creates contradicting patch ──

Deno.test("AIO-31: unflattenPatch — identity patch suppresses $d for same key", () => {
  // When array transitions from [] (atomic: "ratelimit.providers") to
  // [{id:"a"}] (identity: "ratelimit.providers.$id:a"), _computeDelta sees:
  //   changed = {"ratelimit.providers.$id:a": {id:"a", name:"ProvA"}}
  //   removed = ["ratelimit.providers"]  (old atomic key gone)
  //
  // BUG: unflattenPatch creates both $arr patch AND $d deletion for "providers"
  // FIX: suppress $d when $arr identity patch already exists for same key

  const changed: Record<string, unknown> = {
    "ratelimit.providers.$id:a": { id: "a", name: "ProvA" },
    "ratelimit.providers.$id:b": { id: "b", name: "ProvB" },
  };
  const removed = ["ratelimit.providers"]; // old atomic key

  const result = unflattenPatch(changed, removed);
  const rl = result.$p.ratelimit as Record<string, unknown>;

  // Identity patch must exist
  assertEquals(
    (rl.providers as Record<string, unknown>).$arr,
    true,
    "providers must have $arr identity patch",
  );
  assertEquals(
    (rl.providers as Record<string, unknown>)["$id:a"],
    { id: "a", name: "ProvA" },
    "must have $id:a entry",
  );

  // $d must NOT contain "providers" — identity patch supersedes atomic removal
  const deletions = rl.$d as string[] | undefined;
  const hasProvidersDeletion = deletions?.includes("providers") ?? false;
  assertEquals(
    hasProvidersDeletion,
    false,
    "CRITICAL: $d must NOT delete 'providers' — identity patch supersedes atomic removal",
  );
});

Deno.test("AIO-31: end-to-end — empty array to identity array via _computeDelta + _applyPatch", () => {
  // Full round-trip: server computes delta, browser applies it
  const state1 = {
    ratelimit: {
      providers: [] as unknown[],
      stats: { total: 0 },
    },
  };
  const state2 = {
    ratelimit: {
      providers: [{ id: "a", name: "ProvA" }, { id: "b", name: "ProvB" }],
      stats: { total: 10 },
    },
  };

  // First broadcast → establishes flat keys for empty array
  const init = _computeDelta(state1, null, {});

  // Second broadcast → delta with empty→identity transition
  const delta = _computeDelta(state2, state1, init.newKeyJsons);

  // Apply delta to browser state
  if (delta.kind === "delta") {
    const patch = JSON.parse(delta.msg);
    const result = _applyPatch(state1, patch);

    // providers MUST exist (not undefined from contradicting $d)
    const providers = (result.ratelimit as Record<string, unknown>)
      .providers as unknown[];
    assertNotEquals(
      providers,
      undefined,
      "CRITICAL: providers must NOT be undefined after empty→identity transition",
    );
    assertEquals(Array.isArray(providers), true, "providers must be an array");
    assertEquals(providers.length, 2, "providers must have 2 elements");
    assertEquals(
      (providers[0] as Record<string, unknown>).id,
      "a",
      "first provider must be 'a'",
    );
  } else {
    // If full state was sent instead of delta, that's also acceptable
    // (means the threshold triggered full send — not a failure)
  }
});

// ── Delta round-trip invariant tests ─────────────────────────────────

// Helper: runs state1→state2 through full delta pipeline, asserts result matches state2
function assertDeltaRoundTrip(
  name: string,
  state1: Record<string, unknown>,
  state2: Record<string, unknown>,
) {
  Deno.test(`delta round-trip: ${name}`, () => {
    // Need to rebuild id maps for state1 so _applyPatch can handle identity arrays
    _rebuildIdMaps(state1);
    const init = _computeDelta(state1, null, {});
    const delta = _computeDelta(state2, state1, init.newKeyJsons);

    if (delta.kind === "skip") {
      assertEquals(
        JSON.stringify(state1),
        JSON.stringify(state2),
        "skip means states must be equal",
      );
      return;
    }

    const parsed = JSON.parse(delta.msg);
    if (delta.kind === "full") {
      assertEquals(parsed, state2, `full state must match target`);
      return;
    }

    // delta kind — apply patch and compare
    const result = _applyPatch(state1, parsed);

    // Verify no key from state2 became undefined in result
    for (const [k, v] of Object.entries(state2)) {
      if (v !== undefined) {
        assertNotEquals(
          (result as Record<string, unknown>)[k],
          undefined,
          `key "${k}" must not be undefined after round-trip`,
        );
      }
    }

    // Deep equality check
    assertEquals(
      JSON.parse(JSON.stringify(result)),
      JSON.parse(JSON.stringify(state2)),
      `round-trip must produce target state`,
    );
  });
}

// 1. empty→non-empty identity array
assertDeltaRoundTrip(
  "empty→non-empty identity array",
  { feat: { items: [], count: 0 } },
  { feat: { items: [{ id: "a", v: 1 }, { id: "b", v: 2 }], count: 0 } },
);

// 2. non-empty identity array→empty
assertDeltaRoundTrip(
  "non-empty identity array→empty",
  { feat: { items: [{ id: "a", v: 1 }, { id: "b", v: 2 }], count: 0 } },
  { feat: { items: [], count: 0 } },
);

// 3. identity array element added
assertDeltaRoundTrip(
  "identity array element added",
  { feat: { items: [{ id: "a", v: 1 }, { id: "b", v: 2 }] } },
  {
    feat: {
      items: [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }],
    },
  },
);

// 4. identity array element removed
assertDeltaRoundTrip(
  "identity array element removed",
  {
    feat: {
      items: [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }],
    },
  },
  { feat: { items: [{ id: "a", v: 1 }, { id: "b", v: 2 }] } },
);

// 5. identity array element changed
assertDeltaRoundTrip(
  "identity array element changed",
  { feat: { items: [{ id: "a", v: 1 }, { id: "b", v: 2 }] } },
  { feat: { items: [{ id: "a", v: 99 }, { id: "b", v: 2 }] } },
);

// 6. nested object sub-key changed
assertDeltaRoundTrip(
  "nested object sub-key changed",
  { a: { x: 1, y: 2, z: 3 }, b: { m: 10 } },
  { a: { x: 1, y: 99, z: 3 }, b: { m: 10 } },
);

// 7. top-level key added
assertDeltaRoundTrip(
  "top-level key added",
  { a: { x: 1 } },
  { a: { x: 1 }, b: { y: 2 } },
);

// 8. sub-key deletion
assertDeltaRoundTrip(
  "sub-key deletion",
  { f: { a: 1, b: 2, c: 3, d: 4, e: 5 } },
  { f: { a: 1, c: 3, e: 5 } },
);

// 9. mixed: add + remove + modify
assertDeltaRoundTrip(
  "mixed: add + remove + modify",
  { feat: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } },
  { feat: { a: 99, c: 3, d: 4, e: 5, f: 6, g: 7 } },
);

// 10. multiple features changed
assertDeltaRoundTrip(
  "multiple features changed",
  { feat1: { x: 1, y: 2 }, feat2: { items: [{ id: "a", v: 1 }] } },
  { feat1: { x: 1, y: 99 }, feat2: { items: [{ id: "a", v: 42 }] } },
);

// ── AIO-33: mutation-proof delta detection ─────────────────────────
// When freezeState=false (production), state objects are mutable. If a shared
// nested object is mutated in-place (same reference, different content),
// _computeDelta must still detect the change via JSON comparison — not skip it
// due to reference equality.

Deno.test("AIO-33: _computeDelta detects in-place mutation (same ref, different content)", () => {
  // Simulate structural sharing: state_v1 and state_v2 share the same member object
  const sharedMember = { id: "BTC", phase: "ENTERING" };
  const state_v1 = { fleet: { members: [sharedMember], stats: { count: 1 } } };

  // First broadcast — establish baseline
  const init = _computeDelta(state_v1, null, {});
  assertEquals(init.kind, "full");

  // Simulate in-place mutation (freezeState=false): same reference, content changed
  sharedMember.phase = "IDLE";
  // state_v2 has the SAME member reference as state_v1 (structural sharing)
  const state_v2 = { fleet: { members: [sharedMember], stats: { count: 1 } } };

  // _computeDelta must detect the change despite same reference
  const delta = _computeDelta(state_v2, state_v1, init.newKeyJsons);
  assertNotEquals(
    delta.kind,
    "skip",
    "must not skip — content changed even though ref is same",
  );

  // The delta must include the updated member
  if (delta.kind === "delta") {
    const parsed = JSON.parse(delta.msg);
    const arrPatch = parsed.$p?.fleet?.members;
    assertEquals(arrPatch?.$arr, true, "must be identity array patch");
    assertEquals(
      arrPatch?.["$id:BTC"]?.phase,
      "IDLE",
      "must carry updated phase",
    );
  } else {
    // Full state is also acceptable — it contains the correct data
    const parsed = JSON.parse(delta.msg);
    assertEquals(parsed.fleet.members[0].phase, "IDLE");
  }
});

Deno.test("AIO-33: _computeDelta detects mutation on non-identity nested key", () => {
  const sharedStats = { avg: 10, max: 100 };
  const state_v1 = { feat: { stats: sharedStats, name: "test" } };
  const init = _computeDelta(state_v1, null, {});

  // Mutate in-place
  sharedStats.avg = 99;
  const state_v2 = { feat: { stats: sharedStats, name: "test" } };

  const delta = _computeDelta(state_v2, state_v1, init.newKeyJsons);
  assertNotEquals(
    delta.kind,
    "skip",
    "must detect in-place mutation of nested object",
  );
});

// ── AIO-33: Simulated delta desync recovery via forced resync ─────

Deno.test("AIO-33: simulated delta desync — stale lastKeyJsons recovers on forced resync", () => {
  // Scenario: server's lastKeyJsons has idle (thinks client has it), but
  // client actually has ENTERING (lost message). Without resync, the
  // server would never re-send the change.
  const state = {
    fleet: {
      members: [
        { id: "BCH", phase: "idle" },
        { id: "SOL", phase: "idle" },
      ],
    },
  };

  // Simulate stale lastKeyJsons that matches current state (as if delta was
  // already sent successfully — but client never received it)
  const flat = flattenKeys(state as Record<string, unknown>);
  const staleKeyJsons: Record<string, string> = {};
  for (const k of Object.keys(flat)) {
    staleKeyJsons[k] = JSON.stringify(flat[k]);
  }

  // Normal delta: server thinks nothing changed → skip
  const delta = _computeDelta(state, state, staleKeyJsons);
  assertEquals(delta.kind, "skip", "without resync, delta is skip (desynced)");

  // Forced resync: reset lastState to null, lastKeyJsons to {} (simulates
  // the broadcastCount >= 100 reset in broadcastState)
  const resyncDelta = _computeDelta(state, null, {});
  assertEquals(resyncDelta.kind, "full", "forced resync sends full state");

  // Full state contains the correct data — browser replaces state
  const parsed = JSON.parse(resyncDelta.msg);
  assertEquals(parsed.fleet.members[0].phase, "idle");
  assertEquals(parsed.fleet.members[1].phase, "idle");
});

Deno.test("AIO-33: lastKeyJsons not updated on failed send — next broadcast retries", () => {
  // Scenario: delta computed, message NOT sent (send failed). lastKeyJsons
  // should NOT advance so the next broadcast re-detects the change.
  const state_v1 = {
    fleet: { members: [{ id: "BCH", phase: "ENTERING" }] },
  };
  const init = _computeDelta(state_v1, null, {});
  // Client has state_v1, server has lastKeyJsons from init

  const state_v2 = {
    fleet: { members: [{ id: "BCH", phase: "idle" }] },
  };
  const delta = _computeDelta(state_v2, state_v1, init.newKeyJsons);
  assertNotEquals(delta.kind, "skip", "change detected");

  // Simulate: send FAILED — don't update lastKeyJsons (keep init.newKeyJsons)
  // Next broadcast should re-detect the same change
  const retry = _computeDelta(state_v2, state_v1, init.newKeyJsons);
  assertNotEquals(
    retry.kind,
    "skip",
    "retry: change re-detected because lastKeyJsons not advanced",
  );

  // Verify the delta carries the correct update
  if (retry.kind === "delta") {
    const parsed = JSON.parse(retry.msg);
    assertEquals(parsed.$p?.fleet?.members?.["$id:BCH"]?.phase, "idle");
  }
});
