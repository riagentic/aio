// Transactional conflict detection was blind to container traversal, in two
// flavours that both ended with the caller told `ok`.
//
// 1. WRONG-ELEMENT. The live proxy's get trap returned the nested proxy BEFORE
//    `noteRead`, so `s.items[0].done = true` recorded a write at `items.0.done`
//    and NO read at all. `conflictPath` only validates writes that overlap a
//    read, so there was nothing to check — and `strictReads` (serializable)
//    validated an EMPTY read set. Against a concurrent `unshift` the wrong
//    element was marked done under `transaction: true` AND under
//    `{ serialize: true }`, and the call resolved.
//
// 2. LOST WRITE. The commit's `applyMutations` WARNED ("null parent for set
//    leaf") and returned. `batcher.settled()` only ever saw errors the
//    dispatch REJECTED, and a warn is not a rejection — so the write never
//    landed and the method resolved as if it had. That is the exact class
//    `settled()` was added to kill.
//
// docs/state/transactional-methods.md promises serializable mode validates
// every read; these are the tests that make the promise checkable.
import { assertEquals } from "@std/assert";
import {
  conflictPath,
  createReadWatch,
  watchKey,
} from "../src/state/cell-impl.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Run `method` on `c`, firing `interfere` while it is suspended. */
async function race(
  c: Any,
  method: string,
  interfere: () => void,
): Promise<string> {
  const p = c[method]();
  await tick();
  interfere();
  return await p.then(
    () => "ok",
    (e: unknown) => `reject:${String(e)}`,
  );
}

for (
  const [label, txn] of [
    ["transaction: true", true],
    ["serialize", { serialize: true }],
  ] as const
) {
  Deno.test(`${label}: a concurrent unshift re-addresses items[0] — the write is refused`, async () => {
    const c = cell(`tct_shift_${label.replace(/\W/g, "")}`, {
      transaction: txn,
      state: { items: [{ id: "a", done: false }] },
      methods: {
        async completeFirst(s: Any) {
          const first = s.items[0]; // traversal — a READ of which element that is
          await tick();
          await tick();
          first.done = true;
        },
        unshift(s: Any) {
          s.items.unshift({ id: "z", done: false });
        },
      },
    } as Any);
    const h = await bootCells([c]);
    try {
      const outcome = await race(
        c,
        "completeFirst",
        () => (c as Any).unshift(),
      );
      // It used to be "ok", with items[0] ("z" — an element this method never
      // saw) marked done and "a" left untouched.
      assertEquals(outcome.startsWith("reject:"), true, outcome);
      assertEquals(outcome.includes("s.items.0"), true, outcome);
      assertEquals(
        JSON.parse(JSON.stringify((c as Any).items)),
        [{ id: "z", done: false }, { id: "a", done: false }],
        "the write-set must be discarded whole",
      );
    } finally {
      h.dispose();
    }
  });
}

Deno.test("transaction: true — an append does NOT move items[0], so the write commits", async () => {
  const c = cell("tct_append", {
    transaction: true,
    state: { items: [{ id: "a", done: false }] },
    methods: {
      async completeFirst(s: Any) {
        const first = s.items[0];
        await tick();
        await tick();
        first.done = true;
      },
      push(s: Any) {
        s.items.push({ id: "z", done: false });
      },
    },
  } as Any);
  const h = await bootCells([c]);
  try {
    // Immer's structural sharing keeps element 0 referentially equal across an
    // append, and identity is the comparator — so this is not a conflict, and
    // making the positional rule coarser (any change to the array) would turn
    // every append into a spurious refusal.
    assertEquals(await race(c, "completeFirst", () => (c as Any).push()), "ok");
    assertEquals(
      JSON.parse(JSON.stringify((c as Any).items)),
      [{ id: "a", done: true }, { id: "z", done: false }],
    );
  } finally {
    h.dispose();
  }
});

Deno.test("transaction: true — an object KEY is a stable name, so a sibling write stays blind", async () => {
  const c = cell("tct_sibling", {
    transaction: true,
    state: { user: { name: "a", age: 1 } },
    methods: {
      async rename(s: Any) {
        await tick();
        await tick();
        s.user.name = "b";
      },
      birthday(s: Any) {
        s.user.age = 99;
      },
    },
  } as Any);
  const h = await bootCells([c]);
  try {
    // `s.user.name` means the same field however `user` changed — a blind
    // write, last-writer-wins by intent, exactly as documented. Only ARRAY
    // INDICES are positions that shift.
    assertEquals(await race(c, "rename", () => (c as Any).birthday()), "ok");
    assertEquals(
      JSON.parse(JSON.stringify((c as Any).user)),
      { name: "b", age: 99 },
    );
  } finally {
    h.dispose();
  }
});

Deno.test("commit: a write the store cannot apply REJECTS its method", async () => {
  const c = cell("tct_lost", {
    state: { box: { n: 0 } as Any },
    methods: {
      async write(s: Any) {
        const b = s.box;
        await tick();
        await tick();
        b.n = 5; // `box` is gone by now — the mutation has a null parent
      },
      clear(s: Any) {
        s.box = null;
      },
    },
  } as Any);
  const h = await bootCells([c]);
  try {
    const outcome = await race(c, "write", () => (c as Any).clear());
    // It used to warn "dropped mutation — null parent for set leaf" on the
    // console and RESOLVE: a caller told its write had landed when it had not.
    assertEquals(outcome.startsWith("reject:"), true, outcome);
    assertEquals(outcome.includes("REFUSED at commit"), true, outcome);
    assertEquals((c as Any).box, null);
  } finally {
    h.dispose();
  }
});

Deno.test("conflictPath: an array index is a position, an object key is a name", () => {
  const elemA = { id: "a", done: false };
  const elemZ = { id: "z", done: false };
  const origin = { items: [elemA], user: { name: "a", age: 1 } };
  const shifted = { items: [elemZ, elemA], user: origin.user };
  const appended = { items: [elemA, elemZ], user: origin.user };

  // Written through `s.items[0]` — the traversal of `items` is the read.
  const positional = createReadWatch();
  positional.reads.add(watchKey(["items"]));
  positional.reads.add(watchKey(["items", "0"]));
  positional.writes.add(watchKey(["items", "0", "done"]));

  // `items.0.done` is `false` in BOTH states — a different element's `false`.
  // Comparing the value at the written path can never see that; comparing the
  // element the index resolves to is the whole point.
  assertEquals(conflictPath(origin, shifted, positional, false), "items.0");
  // An append leaves element 0 referentially equal → not a conflict.
  assertEquals(conflictPath(origin, appended, positional, false), null);

  // The same shape with an object KEY instead of an index: still a blind write.
  const nominal = createReadWatch();
  nominal.reads.add(watchKey(["user"]));
  nominal.writes.add(watchKey(["user", "name"]));
  const aged = { items: origin.items, user: { name: "a", age: 99 } };
  assertEquals(conflictPath(origin, aged, nominal, false), null);
  // …but serializable validates the read that a snapshot-isolated run ignores.
  assertEquals(conflictPath(origin, aged, nominal, true), "user");
});
