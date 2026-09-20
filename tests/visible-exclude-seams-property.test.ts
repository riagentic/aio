// AUDIT (security): `visible: { exclude: ["accounts.encSecKey"] }` has more
// than one decider, and the property that matters is not "each of them looks
// right" but "the sentinel is UNREACHABLE on every one of them, and they all
// answer the SAME shape".
//
// Deciders under test:
//   1. the wire filter      — `applyCellFieldFilter` / `deepExcludePaths`
//                             (src/state/state-filter.ts), full frame
//   2. the patch/delta path — `filterPatchesByStrategy` (same file)
//   3. the client read seam — `bindCellReactive` (src/state/cell-reactive.ts),
//                             which IS the filter in standalone/Electron/testUI
//   4. the surface view     — `excludeLoud` (src/server/server-surface.ts)
//   5. the persistence read-back — `restoreExcluded` (same file): what the
//                             store's projection kept OUT comes back from
//                             BOOT. It was a closure inside src/server/aio.ts,
//                             a fifth hand-written copy of the traversal that
//                             no test could reach; it lives beside the walker
//                             it mirrors now, and this file reaches it.
//
// All five call ONE walker today (`deepExcludePaths`). The value of the
// property is that it keeps being one: the leak it was written for was four
// individually-plausible copies disagreeing about a records-by-id map.
import { assert, assertEquals } from "@std/assert";
import {
  applyCellFieldFilter,
  deepExcludePaths,
  filterPatchesByStrategy,
  restoreExcluded,
} from "../src/state/state-filter.ts";
import { cell } from "../src/state/cell-create.ts";
import { bindCellReactive } from "../src/state/cell-reactive.ts";
import { _resetSignals, getCellSignal } from "../src/state/state-signals.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

// ── the instrument ────────────────────────────────────────────────────────

const MARK = "SECRET-";

/** Every string anywhere under `v`, INCLUDING behind non-enumerable own
 *  properties (the tripwire getters this seam installs) and inside Map/Set
 *  values — a scan that only walks `Object.entries` would declare a leak clean
 *  exactly where these filters stop walking. */
function findSentinels(v: unknown, seen = new Set<object>()): string[] {
  const out: string[] = [];
  if (typeof v === "string") return v.startsWith(MARK) ? [v] : [];
  if (v === null || typeof v !== "object") return [];
  if (seen.has(v)) return [];
  seen.add(v);
  if (v instanceof Map) {
    for (const [k, val] of v) {
      out.push(...findSentinels(k, seen), ...findSentinels(val, seen));
    }
  }
  if (v instanceof Set) {
    for (const el of v) out.push(...findSentinels(el, seen));
  }
  for (const k of Object.getOwnPropertyNames(v)) {
    const d: PropertyDescriptor = Object.getOwnPropertyDescriptor(v, k)!;
    if ("value" in d) {
      out.push(...findSentinels(d.value, seen));
      continue;
    }
    // A tripwire getter: reading it is supposed to refuse. If it answers a
    // value instead, that value is part of the surface.
    try {
      out.push(...findSentinels(d.get?.call(v), seen));
    } catch { /* refused — that is the contract */ }
  }
  return out;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

let sentinelN = 0;
const nextSecret = () => `${MARK}${sentinelN++}`;

/** Random state under a known dot path. Mixes: plain nesting, arrays of
 *  records, records-BY-ID maps (head absent), containers in containers, arrays
 *  inside record maps, empty objects, an object whose ONLY key is the excluded
 *  one, and a container that also holds an id equal to the head segment. */
function build(
  segs: string[],
  rnd: () => number,
  kinds: Set<string>,
  d = 0,
): unknown {
  if (segs.length === 0) return nextSecret();
  const head = segs[0]!;
  const rest = segs.slice(1);
  const r = rnd();
  const deeper = d < 3;
  // Container forms — the head segment is NOT a key here.
  if (deeper && r < 0.18) {
    kinds.add("record-map");
    return {
      alice: build(segs, rnd, kinds, d + 1),
      bob: { unrelated: 1 },
      "7": build(segs, rnd, kinds, d + 1),
    };
  }
  if (deeper && r < 0.3) {
    kinds.add("array-of-records");
    return [build(segs, rnd, kinds, d + 1), { unrelated: 2 }, null, 7];
  }
  if (deeper && r < 0.38) {
    kinds.add("nested-containers");
    return { g1: { a: build(segs, rnd, kinds, d + 1) }, g2: {} };
  }
  if (deeper && r < 0.45) {
    kinds.add("array-in-record-map");
    return { room1: [build(segs, rnd, kinds, d + 1), {}] };
  }
  if (deeper && r < 0.5) {
    // The head segment name ALSO exists as a real id key in the container.
    kinds.add("head-name-is-an-id");
    return {
      [head]: { note: "a record whose id collides with the excluded field" },
      alice: build(segs, rnd, kinds, d + 1),
    };
  }
  // The literal form: this object really has `head`.
  const node: Record<string, unknown> = {};
  if (rest.length === 0) {
    kinds.add("leaf");
    node[head] = nextSecret();
    if (rnd() < 0.25) kinds.add("only-key-is-excluded");
    else node["keep"] = "kept";
  } else {
    node[head] = build(rest, rnd, kinds, d + 1);
    if (rnd() < 0.5) node["keep"] = "kept";
  }
  if (rnd() < 0.2) {
    kinds.add("empty-object");
    node["empty"] = {};
  }
  if (rnd() < 0.2) node["plain"] = [1, null, true, "x"];
  return node;
}

/** Every Immer op path inside `v` — object keys as strings, array indices as
 *  NUMBERS, which is the shape Immer produces and the one segment the matcher
 *  must never let consume a path segment. */
function opPaths(
  v: unknown,
  at: (string | number)[],
): (string | number)[][] {
  const out: (string | number)[][] = [at];
  if (v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    v.forEach((el, i) => out.push(...opPaths(el, [...at, i])));
    return out;
  }
  for (const [k, val] of Object.entries(v)) {
    out.push(...opPaths(val, [...at, k]));
  }
  return out;
}

/** The live value an op at `at` would carry. */
function pick(root: unknown, at: (string | number)[]): unknown {
  let v = root;
  for (const seg of at) v = (v as Record<string | number, unknown>)[seg];
  return v;
}

let cellN = 0;
/** The client read seam, bound exactly as the browser binds it. */
function clientRead(
  state: Record<string, unknown>,
  exclude: string[],
  key: string,
): unknown {
  const id = `vfb-sec-${cellN++}`;
  // deno-lint-ignore no-explicit-any
  const c: any = cell(id, { state, methods: {}, visible: { exclude } });
  bindCellReactive(c);
  getCellSignal(id, c.__aio.state).set(state);
  return c[key];
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

/** JSON with object keys in a fixed order — for comparisons where the order a
 *  rebuild happens to produce is not part of the contract. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${
    Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")
  }}`;
}

// ── 1+2+3+4: the property ─────────────────────────────────────────────────

Deno.test("visible.exclude: the sentinel is unreachable on every seam (property)", () => {
  _resetAioRuntime();
  _resetSignals();
  const kinds = new Set<string>();
  let shapes = 0;
  // Partitioned, because ONE generator shape (`head-name-is-an-id`) leaks on
  // every seam by itself and would otherwise swamp every other signal.
  const leaks: string[] = [];
  const collisionLeaks: string[] = [];
  const diffs: string[] = [];

  for (const seed of [1, 2, 3, 5, 8, 13, 21]) {
    const rnd = makeRng(seed);
    for (let i = 0; i < 40; i++) {
      const depth = 1 + Math.floor(rnd() * 3); // paths of depth 1 / 2 / 3
      const segs = Array.from({ length: depth }, (_, k) => `k${k}`);
      segs[segs.length - 1] = "secret";
      const mine = new Set<string>();
      const value = build(segs, rnd, mine);
      for (const k of mine) kinds.add(k);
      const state = { root: value };
      const path = `root.${segs.join(".")}`;
      const where = `seed ${seed} #${i} · ${path} · ${JSON.stringify(value)}`;
      const leak = (s: string) =>
        (mine.has("head-name-is-an-id") ? collisionLeaks : leaks).push(s);
      shapes++;

      // 1. the wire filter, full-state frame
      const wire = applyCellFieldFilter({ exclude: [path] }, state)!;
      const wireLeak = findSentinels(wire);
      if (wireLeak.length) leak(`WIRE ${where} -> ${wireLeak[0]}`);

      // 2. the patch path — EVERY op path this state can produce, not just a
      //    replace of the whole root field. The full frame and the deltas that
      //    follow it build one projection, so an op path the matcher reads
      //    differently from the frame filter hands the client, on the very
      //    next keystroke, what the connect frame refused.
      const strategies = new Map([["c", "filter" as const]]);
      const fields = new Map([["c", {
        mode: "exclude" as const,
        fields: new Set<string>(),
        deepExcludes: [["root", ...segs]],
      }]]);
      for (const at of opPaths(value, ["root"])) {
        const kept = filterPatchesByStrategy(
          [{
            cell: "c",
            // deno-lint-ignore no-explicit-any
            ops: [{ op: "replace", path: at, value: pick(state, at) }] as any,
          }],
          strategies,
          fields,
        );
        const patchLeak = findSentinels(kept);
        if (patchLeak.length) {
          leak(`PATCH at ${at.join(".")} · ${where} -> ${patchLeak[0]}`);
        }
      }

      // 3. the client read seam — the object, its JSON, Object.values, a
      //    structuredClone of it, and a deep walk through non-enumerables.
      const client = clientRead(state, [path], "root");
      for (
        const [seam, v] of [
          ["client", client],
          ["client/JSON", JSON.stringify(client)],
          ["client/values", Object.values(Object(client))],
          ["client/clone", structuredClone(json(client))],
        ] as const
      ) {
        const l = findSentinels(v);
        if (l.length) leak(`${seam.toUpperCase()} ${where} -> ${l[0]}`);
      }

      // the DIFFERENTIAL: the client seam must answer the wire's shape
      const a = JSON.stringify(json(client));
      const b = JSON.stringify(json((wire as Record<string, unknown>).root));
      if (a !== b) diffs.push(`${where}\n  client ${a}\n  wire   ${b}`);

      // 5. the persistence read-back. `restoreExcluded` puts boot's value back
      //    where the store's projection removed one, so with BOOT holding the
      //    unfiltered state it is the exact inverse of the projection — which
      //    is only true if it walks the same shape the same way. A restore
      //    that descended differently would leave a hole (a field the store
      //    kept out and boot never put back: silent data loss) or invent one.
      const segsFull = path.split(".");
      const stored = deepExcludePaths(state, [segsFull]);
      const back = restoreExcluded(stored, state, segsFull);
      // Key ORDER is not part of it: a field the projection removed comes
      // back where boot's spread puts it, which is at the end.
      const r = stable(json(back));
      const s0 = stable(json(state));
      if (r !== s0) {
        diffs.push(`RESTORE ${where}\n  back ${r}\n  was  ${s0}`);
      }
      // …and with a boot that has none of it, nothing excluded comes back.
      const empty = restoreExcluded(stored, { root: {} }, segsFull);
      const emptyLeak = findSentinels(empty);
      if (emptyLeak.length) leak(`RESTORE/BOOT ${where} -> ${emptyLeak[0]}`);
    }
  }

  // VERIFY THE INSTRUMENT: a generator that stopped producing the interesting
  // shapes would pass every assertion below while covering nothing.
  assertEquals(shapes, 280, "the generator must produce shapes");
  for (
    const k of [
      "record-map",
      "array-of-records",
      "nested-containers",
      "array-in-record-map",
      "head-name-is-an-id",
      "empty-object",
      "only-key-is-excluded",
      "leaf",
    ]
  ) assert(kinds.has(k), `the generator never produced a ${k} shape`);
  assert(
    findSentinels({ a: [{ b: `${MARK}x` }] }).length === 1,
    "the scanner must find a sentinel it is given",
  );
  assert(
    findSentinels(Object.defineProperty({}, "b", {
      get: () => `${MARK}y`,
      enumerable: false,
    })).length === 1,
    "…including one behind a non-enumerable getter",
  );

  const report = [
    leaks.length
      ? `LEAK on ${leaks.length} seam-reads (no id collision involved):\n` +
        leaks.slice(0, 3).join("\n")
      : "",
    collisionLeaks.length
      ? `LEAK on ${collisionLeaks.length} seam-reads, all of them shapes ` +
        `where a record id equals the excluded field name:\n` +
        collisionLeaks.slice(0, 1).join("\n")
      : "",
    diffs.length
      ? `DIVERGENCE client seam != wire filter on ${diffs.length} shapes:\n` +
        diffs.slice(0, 3).join("\n")
      : "",
  ].filter(Boolean).join("\n\n");
  assertEquals(report, "", report);
  _resetAioRuntime();
  _resetSignals();
});

// ── the hand probes ───────────────────────────────────────────────────────

Deno.test("visible.exclude: a record id equal to the excluded field name does not disable the filter", () => {
  _resetAioRuntime();
  _resetSignals();
  // `accounts` is keyed by a USER-CONTROLLED id. One record named
  // `encSecKey` makes `head in obj` true, so the container reading never runs
  // and every OTHER record's secret is broadcast — on the wire and on the
  // client alike, so no differential can see it.
  const state = {
    accounts: {
      encSecKey: { note: "an account a user named after the field" },
      alice: { name: "a", encSecKey: `${MARK}collide` },
    },
  };
  const wire = applyCellFieldFilter({ exclude: ["accounts.encSecKey"] }, state);
  assertEquals(findSentinels(wire), [], `wire leaked: ${JSON.stringify(wire)}`);
  const client = clientRead(state, ["accounts.encSecKey"], "accounts");
  assertEquals(findSentinels(client), [], "the client seam leaked");
  _resetAioRuntime();
  _resetSignals();
});

Deno.test("visible.exclude: an Object.prototype name as a path segment still filters", () => {
  _resetAioRuntime();
  _resetSignals();
  // `head in obj` walks the PROTOTYPE CHAIN, so for any plain object
  // `"constructor" in obj` and `"__proto__" in obj` are true — the container
  // reading is switched off for every such field name.
  for (const head of ["constructor", "__proto__", "toString", "valueOf"]) {
    const state = {
      a: { alice: { [head]: `${MARK}${head}`, keep: 1 }, bob: { keep: 2 } },
    };
    const wire = applyCellFieldFilter({ exclude: [`a.${head}`] }, state);
    assertEquals(
      findSentinels(wire),
      [],
      `wire leaked for exclude a.${head}: ${JSON.stringify(wire)}`,
    );
    const client = clientRead(
      JSON.parse(JSON.stringify(state)),
      [`a.${head}`],
      "a",
    );
    assertEquals(
      findSentinels(client),
      [],
      `the client seam leaked for exclude a.${head}`,
    );
  }
  _resetAioRuntime();
  _resetSignals();
});

Deno.test("visible.exclude: a numeric head segment behaves like any other", () => {
  _resetAioRuntime();
  _resetSignals();
  const state = { a: { alice: { "0": `${MARK}num`, keep: 1 } } };
  const wire = applyCellFieldFilter({ exclude: ["a.0"] }, state);
  assertEquals(findSentinels(wire), [], "wire");
  const client = clientRead(state, ["a.0"], "a");
  assertEquals(findSentinels(client), [], "client");
  assertEquals(json(client), json((wire as Record<string, unknown>).a));
  // …and on the delta path. A numeric STRING is an ordinary object key (a
  // records-by-id map keyed "7"); only a NUMBER is an array index. The matcher
  // used to skip both, so the op that carried `a.alice.0` was sent in full
  // while the frame filter removed it.
  const kept = filterPatchesByStrategy(
    [{
      cell: "c",
      // deno-lint-ignore no-explicit-any
      ops: [{
        op: "replace",
        path: ["a", "alice", "0"],
        value: `${MARK}num`,
      }] as any,
    }],
    new Map([["c", "filter" as const]]),
    new Map([["c", {
      mode: "exclude" as const,
      fields: new Set<string>(),
      deepExcludes: [["a", "0"]],
    }]]),
  );
  assertEquals(findSentinels(kept), [], "the delta path");
  _resetAioRuntime();
  _resetSignals();
});

Deno.test("visible.exclude: two paths sharing a prefix both stay LOUD", () => {
  _resetAioRuntime();
  _resetSignals();
  // Each excluder runs over the PREVIOUS one's output and rebuilds it with
  // `{...obj}` — which copies own ENUMERABLE properties only, so the earlier
  // path's non-enumerable tripwire getter is dropped and that field reads as a
  // clean `undefined`: the "undefined as data" trap this seam exists to close.
  const state = { a: { b: `${MARK}b`, c: `${MARK}c`, keep: 1 } };
  const a = clientRead(state, ["a.b", "a.c"], "a") as Record<string, unknown>;
  assertEquals(findSentinels(a), [], "neither value may survive");
  const refuses = (k: string) => {
    try {
      void a[k];
      return false;
    } catch {
      return true;
    }
  };
  assert(refuses("c"), "a.c must refuse");
  assert(
    refuses("b"),
    "a.b must refuse too — the second excluder's spread dropped the first " +
      "one's tripwire, so the FIRST of two sibling paths reads as a silent " +
      "undefined while the last one refuses",
  );
  _resetAioRuntime();
  _resetSignals();
});

Deno.test("visible.exclude: a non-plain object at a container position survives the client seam", () => {
  _resetAioRuntime();
  _resetSignals();
  // `Object.entries()` of a Date/Map/Set is empty, so the container branch maps
  // it to `{}`. The wire filter returns `touched ? mapped : value` and so keeps
  // the value; the client twin returns `tripwire(mapped, head)`
  // UNCONDITIONALLY at a leaf and so replaces it with `{}`.
  const cases: Record<string, unknown> = {
    date: new Date("2020-01-01T00:00:00Z"),
    map: new Map([["alice", { secret: 1 }]]),
    set: new Set([1, 2]),
    u8: new Uint8Array([1, 2, 3]),
  };
  const bad: string[] = [];
  for (const [name, v] of Object.entries(cases)) {
    const state = { a: v };
    const wire = deepExcludePaths(v, [["b"]]);
    const client = clientRead(state, ["a.b"], "a");
    const w = JSON.stringify(json(wire));
    const c = JSON.stringify(json(client));
    if (w !== c) bad.push(`${name}: wire ${w} != client ${c}`);
  }
  assertEquals(bad.join("\n"), "", "the client seam must answer the wire");
  _resetAioRuntime();
  _resetSignals();
});

Deno.test("visible.exclude: a container of nulls and primitives is untouched and identical", () => {
  _resetAioRuntime();
  _resetSignals();
  const state = { a: { x: null, y: 5, z: true, w: { b: `${MARK}w` } } };
  const wire = applyCellFieldFilter({ exclude: ["a.b"] }, state)!;
  const client = clientRead(state, ["a.b"], "a");
  assertEquals(findSentinels(wire), [], "wire");
  assertEquals(findSentinels(client), [], "client");
  assertEquals(json(client), json(wire.a), "client seam != wire filter");
  _resetAioRuntime();
  _resetSignals();
});

Deno.test("visible.exclude: a deep patch op at a record id is dropped", () => {
  const fields = new Map([["c", {
    mode: "exclude" as const,
    fields: new Set<string>(),
    deepExcludes: [["accounts", "secret"]],
  }]]);
  const strategies = new Map([["c", "filter" as const]]);
  for (
    const p of [
      ["accounts", "alice", "secret"],
      ["accounts", "7", "secret"],
      ["accounts", "alice", "secret", "inner"],
      ["accounts", "alice"],
      ["accounts"],
    ]
  ) {
    const kept = filterPatchesByStrategy(
      [{
        cell: "c",
        ops: [{
          op: "replace",
          path: p,
          value: p.at(-1) === "secret"
            ? `${MARK}p`
            : { secret: `${MARK}p`, keep: 1 },
          // deno-lint-ignore no-explicit-any
        }] as any,
      }],
      strategies,
      fields,
    );
    assertEquals(
      findSentinels(kept),
      [],
      `a patch at ${p.join(".")} carried the secret`,
    );
  }
});

Deno.test("visible.exclude: a delta whose FIRST segment is a record id agrees with the frame", () => {
  // The frame filter reaches `x.a.b` (the container reading starts at the
  // cell's own state object, so `x` is a record like any other). The matcher
  // used to require the FIRST op segment to match, so this op — and the
  // keystroke that produced it — carried what the connect frame had refused.
  const state = { x: { a: { b: `${MARK}delta` } }, a: { q: 1 } };
  const wire = applyCellFieldFilter({ exclude: ["a.b"] }, state);
  assertEquals(findSentinels(wire), [], "the frame removes x.a.b");
  // …each op carrying the value that really sits at its path.
  for (
    const [p, value] of [
      [["x", "a", "b"], `${MARK}delta`],
      [["x", "a"], { b: `${MARK}delta` }],
      [["x"], { a: { b: `${MARK}delta` } }],
    ] as const
  ) {
    const kept = filterPatchesByStrategy(
      [{
        cell: "c",
        ops: [{
          op: "replace",
          path: p,
          value,
          // deno-lint-ignore no-explicit-any
        }] as any,
      }],
      new Map([["c", "filter" as const]]),
      new Map([["c", {
        mode: "exclude" as const,
        fields: new Set<string>(),
        deepExcludes: [["a", "b"]],
      }]]),
    );
    assertEquals(
      findSentinels(kept),
      [],
      `a delta at ${p.join(".")} carried what the frame removed`,
    );
  }
});

// ── 4: the `am surface` client view ───────────────────────────────────────

Deno.test("visible.exclude: the headless surface hides the sentinel too", async () => {
  const { renderHeadlessSurface } = await import(
    "../src/server/server-surface.ts"
  );
  const { bindCell } = await import("../src/state/cell-catalog.ts");
  const { dropTempDir, tempDir } = await import("../src/testing/temp-dir.ts");
  const REPO = new URL("..", import.meta.url).pathname;
  const dir = await tempDir("vfb-sec-surface-");
  await Deno.writeTextFile(
    `${dir}/cell.ts`,
    `import { cell } from "${REPO}mod.ts";
export const vault = cell("vfb-sec-vault", {
  state: { accounts: {} as Record<string, Record<string, string>>,
           pair: { b: "", c: "" } },
  visible: { exclude: ["accounts.encSecKey", "pair.b", "pair.c"] },
  methods: {},
});
`,
  );
  const comp = (name: string, body: string) =>
    Deno.writeTextFile(
      `${dir}/${name}.ts`,
      `import { h } from "${REPO}src/air/vdom.ts";
import { vault } from "./cell.ts";
export default function App() { return h("main", null, ${body}); }
`,
    );
  // A record whose id IS the excluded field name — the surface PRINTS what it
  // renders, so a leak here is a secret in `am surface --json`.
  await comp("Collide", `h("p", null, "v:" + vault.accounts.alice.encSecKey)`);
  // The FIRST of two sibling exclude paths: it must refuse, not render "".
  await comp("First", `h("p", null, "v:[" + vault.pair.b + "]")`);
  const mod = await import(`file://${dir}/cell.ts`);
  // deno-lint-ignore no-explicit-any
  bindCell(mod.vault as any, () => Promise.resolve(), () => ({
    "vfb-sec-vault": {
      accounts: {
        encSecKey: { note: "an account named after the field" },
        alice: { name: "a", encSecKey: `${MARK}surface` },
      },
      pair: { b: `${MARK}pair-b`, c: `${MARK}pair-c` },
    },
  }));

  const collide = await renderHeadlessSurface(`${dir}/Collide.ts`);
  const c = JSON.stringify(collide);
  // This one PASSES, and only by accident: the surface runs the wire filter
  // over the slice FIRST, which drops the colliding record `accounts.encSecKey`
  // and thereby makes the head absent for `excludeLoud`, which then descends
  // into the container correctly. The wire frame itself — the broadcast the
  // colliding state produces — still carries `alice.encSecKey`.
  assert(
    !c.includes(`${MARK}surface`),
    `the surface printed a secret a colliding record id unlocked: ${c}`,
  );
  const first = await renderHeadlessSurface(`${dir}/First.ts`);
  const f = JSON.stringify(first);
  assert(!f.includes(`${MARK}pair-b`), `the surface printed pair.b: ${f}`);
  assert(
    !first.ok,
    `the FIRST of two sibling exclude paths must refuse, not render a silent ` +
      `empty string: ${f}`,
  );
  await dropTempDir(dir);
});
