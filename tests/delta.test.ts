import { assertEquals, assertNotEquals } from "@std/assert";
import { _computeDelta } from "../src/server.ts";

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
