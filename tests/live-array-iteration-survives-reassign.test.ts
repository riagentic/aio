// A loop in an async method that REPLACES the array it walks finishes the way
// its sync twin does — over the array it started on.
//
//   for (const x of s.items.values()) s.items = s.items.filter((y) => y !== x + 1)
//
// sync:  visits [1,2,3,4], commits [1]
// async: visited 1, then threw "stale reference" — AFTER the first
//        reassignment had already committed, leaving [1,3,4] behind
//
// The walk read the array by PATH at every step (so a worklist sees its own
// pushes, tests/live-array-iteration-sees-growth.test.ts), and after the
// replacement that path is a different array. The sync draft's iterator holds
// the old array object; the assignment only detaches it. Now the async walk
// keeps the array as it was at the write. A row it hands out after that is
// the old row: readable, and a WRITE to it is refused by name, because whether
// the sync twin's write would land depends on whether the new array kept that
// row — a copy cannot know, and dropping it silently is the one wrong answer.
// The generic shape lives in the differential fuzzer (fuzz-ops.ts).
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const bodies: Record<string, (s: Any) => unknown> = {
  valuesFilter(s) {
    const seen: number[] = [];
    for (const x of s.items.values()) {
      seen.push(x);
      s.items = s.items.filter((y: number) => y !== x + 1);
    }
    return seen;
  },
  keysReassign(s) {
    const ks: number[] = [];
    for (const k of s.items.keys()) {
      ks.push(k);
      if (k === 1) s.items = [0];
    }
    return ks;
  },
  forOfReassign(s) {
    const seen: number[] = [];
    for (const x of s.items) {
      seen.push(x);
      if (x === 1) s.items = [9, 8, 7, 6, 5];
    }
    return seen;
  },
  entriesRemoveDone(s) {
    const out: unknown[] = [];
    for (const [i, t] of s.todos.entries()) {
      out.push(i, t.t);
      if (t.done) s.todos = s.todos.filter((x: Any) => !x.done);
    }
    return out;
  },
  containerReplaced(s) {
    const seen: number[] = [];
    for (const n of s.deep.arr) {
      seen.push(n);
      s.deep = { arr: [n + 50] };
    }
    return seen;
  },
  iteratorBeforeReplace(s) {
    const it = s.items.keys();
    s.items = [];
    return [...it];
  },
  // A detached row returned and stored: plain data on both sides.
  storeDetachedRow(s) {
    let n = 0;
    for (const t of s.todos.values()) {
      if (n++ === 1) s.picked = t;
      s.todos = [];
    }
    return s.picked;
  },
};

const initial = () => ({
  items: [1, 2, 3, 4],
  todos: [
    { t: "a", done: false },
    { t: "b", done: true },
    { t: "c", done: false },
  ],
  deep: { arr: [1, 2] },
  picked: null as unknown,
});

const methods: Any = {
  reset(s: Any) {
    Object.assign(s, initial());
  },
  // deno-lint-ignore require-await
  async writeDetached(s: Any) {
    let n = 0;
    for (const t of s.todos.values()) {
      if (n++ === 0) s.todos = s.todos.filter((x: Any) => x.t !== "a");
      else t.done = !t.done;
    }
  },
};
for (const [n, b] of Object.entries(bodies)) {
  methods[`s_${n}`] = (s: Any) => b(s);
  // deno-lint-ignore require-await
  methods[`a_${n}`] = async (s: Any) => b(s);
}
const c = cell("iterreassign", { state: initial(), methods } as Any) as Any;

const outcome = async (p: Promise<unknown>) => {
  const ret = await p.then(
    (v) => JSON.stringify(v),
    (e: Error) => `THREW ${e.message}`,
  );
  const { items, todos, deep, picked } = c;
  return { ret, state: JSON.stringify({ items, todos, deep, picked }) };
};

for (const n of Object.keys(bodies)) {
  Deno.test(`async walk over a replaced array matches sync: ${n}`, async () => {
    await using _h = await bootCells([c]);
    await c.reset();
    const sync = await outcome(c[`s_${n}`]());
    await c.reset();
    const async_ = await outcome(c[`a_${n}`]());
    assert(!sync.ret.startsWith("THREW"), sync.ret);
    assertEquals(async_, sync);
  });
}

Deno.test("a write to a detached row is refused by name, not dropped", async () => {
  await using _h = await bootCells([c]);
  await c.reset();
  const msg = await c.writeDetached().then(
    () => "resolved",
    (e: Error) => e.message,
  );
  assert(msg.includes("REPLACED mid-loop"), msg);
  assert(msg.includes("s.todos[1]"), msg);
});
