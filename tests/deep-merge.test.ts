import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { deepMerge } from "../src/state/deep-merge.ts";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

Deno.test("deepMerge: persisted overrides matching types", () => {
  const initial = { count: 0, name: "default" };
  const persisted = { count: 42, name: "saved" };
  assertEquals(deepMerge(initial, persisted), { count: 42, name: "saved" });
});

Deno.test("deepMerge: drops keys removed from schema", () => {
  const initial = { count: 0 };
  const persisted = { count: 5, oldKey: "stale" };
  assertEquals(deepMerge(initial, persisted), { count: 5 });
});

Deno.test("deepMerge: preserves new schema keys", () => {
  const initial = { count: 0, newField: "default" };
  const persisted = { count: 5 };
  assertEquals(deepMerge(initial, persisted), {
    count: 5,
    newField: "default",
  });
});

Deno.test("deepMerge: rejects type mismatch (schema wins)", () => {
  const initial = { count: 0 };
  const persisted = { count: "not a number" };
  assertEquals(deepMerge(initial, persisted), { count: 0 });
});

Deno.test("deepMerge: merges nested objects recursively", () => {
  const initial = { settings: { theme: "light", fontSize: 14, newOpt: true } };
  const persisted = { settings: { theme: "dark", fontSize: 16 } };
  assertEquals(deepMerge(initial, persisted), {
    settings: { theme: "dark", fontSize: 16, newOpt: true },
  });
});

Deno.test("deepMerge: replaces arrays wholesale", () => {
  const initial = { items: [1, 2, 3] };
  const persisted = { items: [4, 5] };
  assertEquals(deepMerge(initial, persisted), { items: [4, 5] });
});

Deno.test("deepMerge: handles null persisted values with same type", () => {
  const initial = { data: null };
  const persisted = { data: null };
  assertEquals(deepMerge(initial, persisted), { data: null });
});

Deno.test("deepMerge: object→primitive type mismatch keeps initial", () => {
  const initial = { config: { a: 1 } };
  const persisted = { config: "broken" };
  const result = deepMerge(initial, persisted);
  assertEquals(result, { config: { a: 1 } });
});

Deno.test("deepMerge: persisted null cannot wipe schema object", () => {
  const initial = { config: { theme: "light", size: 14 } };
  const persisted = { config: null };
  assertEquals(deepMerge(initial, persisted), {
    config: { theme: "light", size: 14 },
  });
});

Deno.test("deepMerge: null initial accepts persisted value", () => {
  const initial = { data: null };
  const persisted = { data: { loaded: true } };
  assertEquals(deepMerge(initial, persisted), { data: { loaded: true } });
});

Deno.test("deepMerge: empty persisted returns initial", () => {
  const initial = { a: 1, b: "hello" };
  assertEquals(deepMerge(initial, {}), { a: 1, b: "hello" });
});

Deno.test("deepMerge: blocks __proto__ pollution", () => {
  const initial = { safe: "yes" };
  const persisted = JSON.parse(
    '{"safe": "yes", "__proto__": {"polluted": true}}',
  );
  const result = deepMerge(initial, persisted);
  assertEquals(result, { safe: "yes" });
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});

Deno.test("deepMerge: blocks constructor/prototype keys", () => {
  const initial = { a: 1 };
  const persisted = { a: 2, constructor: "evil", prototype: "bad" };
  assertEquals(deepMerge(initial, persisted), { a: 2 });
});

Deno.test("deepMerge: array→object type mismatch keeps initial (schema wins)", () => {
  // persisted is array, initial is object → typeof mismatch → keep initial
  const initial = { config: { theme: "light" } } as Record<string, unknown>;
  const persisted = { config: ["broken"] } as Record<string, unknown>;
  assertEquals(deepMerge(initial, persisted), { config: { theme: "light" } });
});

Deno.test("deepMerge: object→array type mismatch keeps initial (schema wins)", () => {
  // persisted is plain object, initial is array → typeof match (both 'object') but isPlainObject check gates recursion
  const initial = { items: ["a", "b"] } as Record<string, unknown>;
  const persisted = { items: { 0: "x" } } as Record<string, unknown>;
  // arrays are replaced wholesale only when types match; object→array is same typeof → persisted used
  // This is the documented behaviour: arrays replaced wholesale if types match
  const result = deepMerge(initial, persisted);
  assertEquals(typeof result.items, "object");
});

Deno.test("deepMerge: depth limit prevents stack overflow", () => {
  // Build a deeply nested structure (40 levels, limit is 32)
  let initial: Record<string, unknown> = { value: "init" };
  let persisted: Record<string, unknown> = { value: "saved" };
  for (let i = 0; i < 40; i++) {
    initial = { nested: initial };
    persisted = { nested: persisted };
  }
  // Should not throw — below the cap the persisted subtree is kept verbatim
  const result = deepMerge(initial, persisted);
  assertEquals(typeof result, "object");
  let node: Record<string, unknown> = result;
  for (let i = 0; i < 40; i++) node = node.nested as Record<string, unknown>;
  assertEquals(
    node.value,
    "saved",
    "data below the cap is kept, not defaulted",
  );
});

Deno.test("deepMerge: type mismatch keeps initial (number vs string)", () => {
  const initial = { count: 0 };
  const persisted = { count: "not-a-number" };
  const result = deepMerge(initial, persisted as any);
  assertEquals(result.count, 0);
});

Deno.test("deepMerge: null in persisted replaces primitive", () => {
  const initial = { name: "default", value: 42 };
  const persisted = { name: null, value: null };
  const result = deepMerge(initial, persisted as any);
  assertEquals(result.name, null);
  assertEquals(result.value, null);
});

Deno.test("deepMerge: null in persisted cannot wipe schema object", () => {
  const initial = { config: { theme: "dark" } };
  const persisted = { config: null };
  const result = deepMerge(initial, persisted as any);
  assertEquals(result.config, { theme: "dark" });
});

Deno.test("deepMerge: array in persisted cannot replace schema object", () => {
  const initial = { items: { list: [] } };
  const persisted = { items: [1, 2, 3] };
  const result = deepMerge(initial, persisted as any);
  assertEquals(result.items, { list: [] });
});

Deno.test("deepMerge: arrays are replaced wholesale, not merged", () => {
  const initial = { tags: ["a", "b"] };
  const persisted = { tags: ["x", "y", "z"] };
  const result = deepMerge(initial, persisted);
  assertEquals(result.tags, ["x", "y", "z"]);
});

Deno.test("deepMerge: deeply nested merge preserves structure", () => {
  const initial = { a: { b: { c: { d: 1, e: 2 } } } };
  const persisted = { a: { b: { c: { d: 99, e: 2 } } } };
  const result = deepMerge(initial, persisted);
  assertEquals(result, { a: { b: { c: { d: 99, e: 2 } } } });
});

Deno.test("deepMerge: MAX_DEPTH prevents stack overflow", () => {
  // Build deeply nested objects (>32 levels)
  let initial: Record<string, unknown> = { value: 1 };
  let persisted: Record<string, unknown> = { value: 99 };
  for (let i = 0; i < 40; i++) {
    initial = { nested: initial };
    persisted = { nested: persisted };
  }
  // Should not throw, returns initial at depth limit
  const result = deepMerge(initial, persisted);
  assertEquals(typeof result, "object");
});

Deno.test("deepMerge: __proto__ key is ignored", () => {
  const initial = { safe: 1 };
  const persisted = { safe: 2, __proto__: { polluted: true } };
  const result = deepMerge(initial, persisted);
  assertEquals(result.safe, 2);
  assertEquals((result as any).polluted, undefined);
});

Deno.test("deepMerge: empty-object initial is a dictionary — keeps all persisted entries (AIO-415)", () => {
  // The `pins: Record<number,string>` data-loss bug: `{}` initial dropped every key.
  const initial = {
    pins: {} as Record<string, unknown>,
    roster: [] as unknown[],
  };
  const persisted = {
    pins: { "1": "0000", "2": "1234" },
    roster: [{ id: 1 }],
  };
  const result = deepMerge(initial, persisted);
  assertEquals(
    result.pins,
    { "1": "0000", "2": "1234" },
    "dict entries survive restore",
  );
  assertEquals(result.roster, [{ id: 1 }]);
});

Deno.test("deepMerge: nested empty-object dictionaries restore recursively", () => {
  const initial = { byUser: {} as Record<string, unknown> };
  const persisted = { byUser: { alice: { seen: 3 }, bob: { seen: 7 } } };
  const result = deepMerge(initial, persisted);
  assertEquals(result.byUser, { alice: { seen: 3 }, bob: { seen: 7 } });
});

Deno.test("deepMerge: non-empty initial still drops keys removed from schema", () => {
  // The exception must NOT weaken the structural-template rule for shaped objects.
  const initial = { a: 1 };
  const persisted = { a: 2, removed: 99 };
  const result = deepMerge(initial, persisted);
  assertEquals(result, { a: 2 }, "unknown key dropped when initial has shape");
});

Deno.test("deepMerge: empty-dict entry drops prototype-pollution keys", () => {
  const initial = { map: {} as Record<string, unknown> };
  const persisted = { map: { good: 1, __proto__: { polluted: true } } };
  const result = deepMerge(initial, persisted);
  assertEquals((result.map as Record<string, unknown>).good, 1);
  // deno-lint-ignore no-explicit-any
  assertEquals((result as any).map.polluted, undefined);
  // deno-lint-ignore no-explicit-any
  assertEquals(({} as any).polluted, undefined, "global proto not polluted");
});

// ── Object.prototype-named dictionary keys (restart fuzzer, 2026-08) ─────────
// `!(key in initial)` was the "is this key declared" test. `in` walks the
// PROTOTYPE CHAIN, so every key that happens to name an Object.prototype
// member read as undeclared and was dropped on restore — silently, with no
// shape-drift report, because an empty declared object is correctly an open
// record. Tag counts, per-username records and i18n tables are exactly where
// user-controlled dictionary keys live.

const PROTO_KEYS = [
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "constructor",
];

Deno.test("deepMerge: dictionary keys that name Object.prototype members survive restore", () => {
  const initial = { counts: {} as Record<string, unknown> };
  const persisted = {
    counts: { hello: 1, toString: 5, world: 2 } as Record<string, unknown>,
  };
  assertEquals(
    deepMerge(initial, persisted).counts,
    { hello: 1, toString: 5, world: 2 },
    "a `toString` tag count is DATA, not a schema member",
  );
});

Deno.test("deepMerge: every Object.prototype-named key survives, at every dict depth", () => {
  const leaf: Record<string, unknown> = {};
  for (const k of PROTO_KEYS) leaf[k] = `v:${k}`;
  const initial = { byUser: {} as Record<string, unknown> };
  const persisted = { byUser: { alice: leaf } };
  const out = (deepMerge(initial, persisted).byUser as Record<string, unknown>)
    .alice as Record<string, unknown>;
  for (const k of PROTO_KEYS) {
    assertEquals(out[k], `v:${k}`, `${k} preserved`);
    assert(Object.hasOwn(out, k), `${k} is an OWN property`);
  }
});

Deno.test("deepMerge: a fixed-shape schema still drops undeclared prototype-named keys", () => {
  // The fix must not weaken the structural-template rule: `toString` is no more
  // declared than any other key the schema never mentions.
  const initial = { a: 1 };
  const persisted = { a: 2, toString: 5, valueOf: 6 };
  assertEquals(deepMerge(initial, persisted), { a: 2 });
});

Deno.test("deepMerge: a persisted __proto__ entry restores as DATA and pollutes nothing", () => {
  const initial = { map: {} as Record<string, unknown> };
  const persisted = JSON.parse(
    '{"map": {"good": 1, "__proto__": {"polluted": true}}}',
  );
  assert(
    Object.hasOwn(persisted.map, "__proto__"),
    "precondition: JSON.parse makes __proto__ an own key",
  );
  const result = deepMerge(initial, persisted);
  const map = result.map as Record<string, unknown>;
  assertEquals(map.good, 1);
  assert(Object.hasOwn(map, "__proto__"), "kept as an own data property");
  assertEquals(
    Object.getPrototypeOf(map),
    Object.prototype,
    "the entry did NOT re-parent its own object",
  );
  // deno-lint-ignore no-explicit-any
  assertEquals(({} as any).polluted, undefined, "Object.prototype untouched");
  // deno-lint-ignore no-explicit-any
  assertEquals((map as any).polluted, undefined, "no inherited pollution");
});

Deno.test("deepMerge: __proto__ cannot pollute through a declared nested object either", () => {
  const initial = { cfg: { theme: "dark" } };
  const persisted = JSON.parse(
    '{"cfg": {"theme": "light", "__proto__": {"polluted": true}}}',
  );
  const result = deepMerge(initial, persisted);
  assertEquals(result.cfg, { theme: "light" }, "undeclared key still dropped");
  assertEquals(
    Object.getPrototypeOf(result.cfg as object),
    Object.prototype,
  );
  // deno-lint-ignore no-explicit-any
  assertEquals(({} as any).polluted, undefined, "Object.prototype untouched");
});

// ── The depth cap is a stack guard, and it says so out loud ─────────────────

Deno.test("deepMerge: past the depth cap the data is KEPT and the path is named", () => {
  // 40 levels: level 32 and below can't be schema-merged (stack guard), but
  // replacing them with the declared default was silent data loss.
  let initial: Record<string, unknown> = { value: "init" };
  let persisted: Record<string, unknown> = { value: "saved" };
  for (let i = 0; i < 40; i++) {
    initial = { nested: initial };
    persisted = { nested: persisted };
  }
  const warns: string[] = [];
  const real = { log: console.log, warn: console.warn };
  const cap = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  console.log = cap;
  console.warn = cap;
  let result: Record<string, unknown>;
  try {
    result = deepMerge(initial, persisted);
  } finally {
    console.log = real.log;
    console.warn = real.warn;
  }
  let node: Record<string, unknown> = result;
  for (let i = 0; i < 40; i++) node = node.nested as Record<string, unknown>;
  assertEquals(node.value, "saved", "nothing below the cap is lost");

  const line = warns.join("\n");
  assert(line.length > 0, "hitting the cap is LOUD, not silent");
  assertStringIncludes(line, "32-level nesting cap");
  // The path is what makes it diagnosable rather than mysterious.
  assertStringIncludes(line, "$.nested.nested.nested");
});

Deno.test("deepMerge: staying under the cap says nothing", () => {
  let initial: Record<string, unknown> = { value: "init" };
  let persisted: Record<string, unknown> = { value: "saved" };
  for (let i = 0; i < 20; i++) {
    initial = { nested: initial };
    persisted = { nested: persisted };
  }
  const warns: string[] = [];
  const real = { log: console.log, warn: console.warn };
  const cap = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  console.log = cap;
  console.warn = cap;
  try {
    deepMerge(initial, persisted);
  } finally {
    console.log = real.log;
    console.warn = real.warn;
  }
  assertEquals(warns, [], "no warning for ordinary nesting");
});

// ── Full stack: the keys survive a real persist → restart → restore ─────────

Deno.test("restore: a dictionary with Object.prototype-named keys survives a real restart", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dm-protokeys-" });
  const dbPath = `${dir}/data.db`;
  const stored = {
    hello: 1,
    toString: 5,
    valueOf: 6,
    constructor: 7,
    hasOwnProperty: 8,
    world: 2,
  };

  const makeCell = () =>
    cell("dict_keys", {
      state: { counts: {} as Record<string, number> },
      methods: {
        put(
          s: { counts: Record<string, number> },
          k: string,
          v: number,
        ) {
          s.counts[k] = v;
        },
      },
    });

  const boot = (c: ReturnType<typeof makeCell>) =>
    aio.run({
      cells: [c],
      appId: "dm-protokeys",
      dbPath,
      baseDir: dir,
      libraryMode: true,
      client: "server-only",
      persistDebounceMs: 1,
    });

  try {
    _resetAioRuntime();
    const c1 = makeCell();
    const app1 = await boot(c1);
    const put = (c1 as unknown as {
      put: (k: string, v: number) => Promise<void>;
    }).put;
    for (const [k, v] of Object.entries(stored)) await put(k, v);
    await new Promise((r) => setTimeout(r, 120)); // let the debounced flush land
    await app1.close();
    _resetAioRuntime();

    const c2 = makeCell();
    const app2 = await boot(c2);
    const restored = (app2.getState() as unknown as {
      dict_keys: { counts: Record<string, number> };
    })
      .dict_keys.counts;
    try {
      assertEquals(restored, stored, "every stored key came back");
    } finally {
      await app2.close();
      _resetAioRuntime();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
