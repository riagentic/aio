// A delta must reproduce the server's KEY ORDER, not only its keys.
//
// Immer describes `delete s.words.apple; s.words.apple = 11` as
// `replace ["words","apple"]`, which a client applies IN PLACE — while the
// server's object holds `apple` LAST. `Object.entries(words)` then rendered
// `apple, banana, cherry` live and `banana, cherry, apple` after a reload or in
// SSR, from one state. The move-to-end idiom (an LRU touch, "bump to the
// bottom") re-adding the SAME value emits no patch at all, so the client never
// heard of it. `assertEquals` ignores key order, which is how every existing
// differential stayed green over this: the fuzzer below compares
// `JSON.stringify`, which does not.
import { assert, assertEquals } from "@std/assert";
import { enablePatches, type Patch, produceWithPatches } from "immer";
import { compactPatches, narrowPatches } from "../src/state/patch-compact.ts";
import { applyWirePatches, type WirePatch } from "../src/protocol/patch-ops.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

enablePatches();

type Dict = Record<string, unknown>;

/** One commit as the server generates it, applied as the client would. */
function commit<T extends object>(
  base: T,
  fn: (d: T) => void,
): { next: T; ops: WirePatch[]; client: T } {
  const [next, raw] = produceWithPatches(base, fn);
  const ops = narrowPatches(base, raw as Patch[], next);
  const client = applyWirePatches(
    JSON.parse(JSON.stringify(base)) as T,
    JSON.parse(JSON.stringify(ops)),
  );
  return { next, ops, client };
}

const order = (o: unknown) => JSON.stringify(o);

Deno.test("key order: a key deleted and re-added lands LAST on the client too", () => {
  const base = { words: { apple: 1, banana: 2, cherry: 3 } as Dict };
  const { next, client } = commit(base, (d) => {
    const v = d.words.apple as number;
    delete d.words.apple;
    d.words.apple = v + 10;
  });
  assertEquals(Object.keys(next.words), ["banana", "cherry", "apple"]);
  assertEquals(Object.keys(client.words), Object.keys(next.words));
  assertEquals(order(client), order(next));
});

Deno.test("key order: an LRU touch with the SAME value — Immer emits nothing — still moves", () => {
  const base = { cache: { a: 1, b: 2, c: 3 } as Dict };
  const [, raw] = produceWithPatches(base, (d) => {
    const v = d.cache.a;
    delete d.cache.a;
    d.cache.a = v;
  });
  assertEquals(raw, [], "the premise: Immer describes this as no change");
  const { next, ops, client } = commit(base, (d) => {
    const v = d.cache.a;
    delete d.cache.a;
    d.cache.a = v;
  });
  assertEquals(ops.length, 2, JSON.stringify(ops));
  assertEquals(order(client), order(next));
});

Deno.test("key order: a move costs the moved key, never the keys after it", () => {
  const big: Dict = {};
  for (let i = 0; i < 1000; i++) big[`k${i}`] = i;
  const base = { d: big };
  const { next, ops, client } = commit(base, (d) => {
    const v = d.d.k0;
    delete d.d.k0;
    d.d.k0 = v;
  });
  assertEquals(ops, [
    { op: "remove", path: ["d", "k0"] },
    { op: "add", path: ["d", "k0"], value: 0 },
  ]);
  assertEquals(order(client), order(next));
});

Deno.test("key order: the common shapes pass through untouched (no delta bloat)", () => {
  const base = {
    n: 0,
    dict: { a: 1, b: { x: 1 }, c: [1, 2] } as Dict,
    list: [{ id: 1 }, { id: 2 }],
  };
  const shapes: [string, (d: typeof base) => void][] = [
    ["scalar", (d) => void d.n++],
    ["add a key", (d) => void (d.dict.z = 1)],
    ["remove a key", (d) => void delete d.dict.a],
    ["nested write", (d) => void ((d.dict.b as { x: number }).x = 2)],
    ["push", (d) => void (d.dict.c as number[]).push(3)],
    ["element write", (d) => void (d.list[1]!.id = 9)],
    ["replace a key's value", (d) => void (d.dict.b = { y: 1 })],
  ];
  for (const [label, fn] of shapes) {
    const [next, raw] = produceWithPatches(base, fn);
    const without = narrowPatches(base, raw as Patch[]);
    const withNext = narrowPatches(base, raw as Patch[], next);
    assertEquals(withNext, without, label);
  }
});

Deno.test("key order: integer-like keys are ordered by the engine, never 'moved'", () => {
  const base = { d: { b: 1, 2: 1, 1: 1, "": 1 } as Dict };
  const { next, ops, client } = commit(base, (d) => {
    delete d.d[2];
    d.d[2] = 5;
    d.d[0] = 1;
  });
  assertEquals(order(client), order(next));
  assert(
    !ops.some((p) => p.op === "remove"),
    `an index key needs no move: ${JSON.stringify(ops)}`,
  );
});

Deno.test("key order: new keys whose `add`s Immer emits out of insertion order", () => {
  // A new key with an INHERITED name, deleted and re-added, keeps its first
  // slot in Immer's bookkeeping (`"constructor" in base` is true), so its
  // `add` precedes a key inserted after it. Found by the fuzzer below.
  const base = { d: { a: 1 } as Dict };
  const C: string = "constructor"; // a `string`, not Object's own member
  const { next, client } = commit(base, (d) => {
    d.d[C] = 1;
    d.d.x = 2;
    delete d.d[C];
    d.d[C] = 3;
  });
  assertEquals(Object.keys(next.d), ["a", "x", "constructor"]);
  assertEquals(order(client), order(next));
});

Deno.test("key order: a move inside an element of an array that shifted in the same commit", () => {
  // `pop` + `push` are `remove`/`add` at an index, so the array's indices are
  // no longer trusted; the element changed in place travels as a nested op,
  // not whole — the one place the move could still be lost.
  const base = { rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5 }] as Dict[] };
  const { next, ops, client } = commit(base, (d) => {
    d.rows.pop();
    d.rows.push({ a: 6 }, { a: 7 });
    const row = d.rows[0]!;
    const v = row.a as number;
    delete row.a;
    row.a = v + 1;
  });
  assertEquals(Object.keys(next.rows[0]!), ["b", "a"]);
  assert(
    ops.some((p) => p.op === "add" && typeof p.path[1] === "number") &&
      ops.some((p) => p.path.length === 3),
    `premise: an index op AND a nested op in one commit: ${
      JSON.stringify(ops)
    }`,
  );
  assertEquals(order(client), order(next));
});

// ── Randomized, order-SENSITIVE differential ─────────────────────────

const KEYS = [
  "",
  "a",
  "b",
  "c",
  "0",
  "1",
  "07",
  "-1",
  "1.5",
  "constructor",
  "prototype",
  "length",
  "a/b",
  `a${String.fromCharCode(0)}b`,
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

function mutate(r: Rng, root: { d: Dict; rows: Dict[] }): void {
  const k = r.pick(KEYS);
  const d = r.chance(0.3) && root.rows.length > 0
    ? root.rows[r.int(root.rows.length)]!
    : root.d;
  switch (r.int(9)) {
    case 0: // move-to-end, new value
      if (Object.hasOwn(d, k)) {
        const v = d[k];
        delete d[k];
        d[k] = typeof v === "number" ? v + 1 : 0;
      } else d[k] = r.int(9);
      break;
    case 1: // move-to-end, SAME value (no Immer op)
      if (Object.hasOwn(d, k)) {
        const v = d[k];
        delete d[k];
        d[k] = v;
      }
      break;
    case 2:
      d[k] = r.int(9);
      break;
    case 3:
      delete d[k];
      break;
    case 4: { // nested object, sometimes a move inside it
      const o = d[k];
      if (o !== null && typeof o === "object" && !Array.isArray(o)) {
        const kk = r.pick(KEYS);
        const oo = o as Dict;
        if (Object.hasOwn(oo, kk) && r.chance(0.5)) {
          const v = oo[kk];
          delete oo[kk];
          oo[kk] = v;
        } else oo[kk] = r.int(9);
      } else d[k] = { [r.pick(KEYS)]: 1 };
      break;
    }
    case 5: // rows shift in the same commit as a move inside a row
      if (r.chance(0.5)) root.rows.unshift({ [r.pick(KEYS)]: 1 });
      else if (root.rows.length > 0) {
        root.rows.splice(r.int(root.rows.length), 1);
      }
      break;
    case 6:
      root.rows = [...root.rows, { a: 1, b: 2 }];
      break;
    case 7: // rebuild the dict with a rotated order
      root.d = Object.fromEntries(Object.entries(root.d).reverse());
      break;
    case 8: // several keys moved at once
      for (const kk of KEYS.filter(() => r.chance(0.3))) {
        if (Object.hasOwn(d, kk)) {
          const v = d[kk];
          delete d[kk];
          d[kk] = v;
        }
      }
      break;
  }
}

Deno.test("key order: randomized programs — client JSON equals server JSON, key order included", () => {
  const SEED = fuzzEnvInt("AIO_KEY_ORDER_SEED", 1);
  const PROGRAMS = fuzzEnvInt("AIO_KEY_ORDER_PROGRAMS", 120, 1);
  let frames = 0;
  let moves = 0;
  for (let p = 0; p < PROGRAMS; p++) {
    const r = rng(SEED + p);
    let server = { d: { a: 1, b: 2, c: 3 } as Dict, rows: [] as Dict[] };
    let client = JSON.parse(JSON.stringify(server));
    for (let round = 0; round < 40; round++) {
      // Several commits coalesced into one frame, as the broadcast throttle does.
      const raw: WirePatch[] = [];
      for (let c = 0; c < 1 + r.int(3); c++) {
        const [next, ops] = produceWithPatches(server, (dr) => {
          for (let i = 0; i < 1 + r.int(3); i++) mutate(r, dr);
        });
        const narrowed = narrowPatches(server, ops as Patch[], next);
        if (narrowed.length > ops.length) moves++;
        raw.push(...narrowed);
        server = next;
      }
      if (raw.length === 0) continue;
      frames++;
      client = applyWirePatches(
        client,
        JSON.parse(JSON.stringify(compactPatches(raw))),
      );
      assertEquals(
        order(client),
        order(server),
        `seed=${SEED + p} round=${round} (replay: AIO_KEY_ORDER_SEED=${
          SEED + p
        } AIO_KEY_ORDER_PROGRAMS=1)`,
      );
    }
  }
  assert(frames > PROGRAMS * 20, `only ${frames} frames`);
  assert(moves > PROGRAMS, `only ${moves} commits needed a move — vacuous`);
});
