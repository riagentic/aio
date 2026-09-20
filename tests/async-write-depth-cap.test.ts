// An async method's write-set is capped at MAX_MUTATION_PATH_DEPTH (32) path
// levels; a sync method (Immer draft) is not.
//
// The cap stays — it is the same 32-level bound the restore merge (deep-merge
// MAX_DEPTH) and sibling calls (MAX_CALL_DEPTH) use, pinned by
// tests/audit-regression/proto-pollution.test.ts (F-1, depth 50 refused). What
// was wrong is how it said so: the write was refused at the COMMIT as
// "[aio:cell] blocked unsafe mutation — path contains the banned key
// __proto__, a non-string segment, or exceeds depth (path=[…])": no cell, no
// method, three candidate causes, a hint about "a malicious or buggy
// framework-internal action received from an untrusted source". A plain
// `s.deep....x = 1` in the author's own method is none of those.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** `{ k0: { k1: … { k(n-1): { x: 0, list: [] } } } }` */
function nest(n: number): Record<string, unknown> {
  let v: Record<string, unknown> = { x: 0, list: [] };
  for (let i = n - 1; i >= 0; i--) v = { [`k${i}`]: v };
  return v;
}
function walk(s: Any, n: number): Any {
  let cur = s.deep;
  for (let i = 0; i < n; i++) cur = cur[`k${i}`];
  return cur;
}

async function runAsync(
  id: string,
  levels: number,
  body: (s: Any) => void,
): Promise<{ err: string; x: unknown }> {
  const c = cell(id, {
    state: { deep: nest(levels), y: null as unknown },
    // deno-lint-ignore require-await
    methods: {
      async run(s: Any) {
        body(s);
      },
    },
  });
  const h = await bootCells([c] as never);
  let err = "";
  try {
    try {
      await (c as Any).run();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    await h.settle();
    return { err, x: walk(c as Any, levels).x };
  } finally {
    h.dispose();
  }
}

Deno.test("async: a write at exactly 32 path levels commits", async () => {
  // deep + k0..k29 + x = 32 segments
  const r = await runAsync("dcap_ok", 30, (s) => {
    walk(s, 30).x = 1;
  });
  assertEquals(r.err, "");
  assertEquals(r.x, 1);
});

Deno.test("async: a write past 32 path levels is refused at the write, by cell, method, depth and fix", async () => {
  // deep + k0..k39 + x = 42 segments
  const r = await runAsync("dcap_deep", 40, (s) => {
    walk(s, 40).x = 1;
  });
  assertStringIncludes(r.err, "[dcap_deep:run]");
  assertStringIncludes(r.err, "42 levels deep");
  assertStringIncludes(r.err, "32");
  assertStringIncludes(r.err, "flatten");
  assertEquals(r.err.includes("banned key"), false, r.err);
  assertEquals(r.x, 0);
});

Deno.test("async: deleting past the cap, and an array op past it, say the same", async () => {
  const del = await runAsync("dcap_del", 40, (s) => {
    delete walk(s, 40).x;
  });
  assertStringIncludes(del.err, "[dcap_del:run]");
  assertStringIncludes(del.err, "levels deep");
  const arr = await runAsync("dcap_arr", 40, (s) => {
    walk(s, 40).list.push(1);
  });
  assertStringIncludes(arr.err, "[dcap_arr:run]");
});

Deno.test("async: a value holding live state from past the cap is refused by the same rule", async () => {
  const r = await runAsync("dcap_alias", 40, (s) => {
    s.y = walk(s, 39);
  });
  assertStringIncludes(r.err, "[dcap_alias:run]");
  assertStringIncludes(r.err, "levels deep");
});
