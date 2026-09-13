// A row taken OUT of an array — `pop`/`shift`/`splice` — and then written to.
//
// This is the queue idiom, and it is everywhere: take the next job, stamp it,
// put it somewhere else.
//
//     const job = s.queue.shift()!;
//     job.status = "done";
//     s.done.push(job);
//
// In an async method that used to THROW. The live proxy computed the return
// value on a throwaway copy of the raw committed array, so `job` came back as
// the FROZEN committed object: the write failed with "Cannot assign to read
// only property", the framework blamed the author for writing "from outside a
// method", and the `shift` had already been recorded — so the row was gone.
// A sync method, whose draft hands back a draft, did the obvious thing.
//
// The same line dropped writes SILENTLY for the mutators that return the
// receiver (`sort`, `reverse`, `fill`, `copyWithin`): `const ordered =
// s.items.sort(by); ordered[0].pinned = true` wrote into the throwaway, and
// the method read its own write back OUT of the throwaway, so neither half of
// the author's code could notice. Those are covered by the differential
// fuzzer's op alphabet (`arr_sort_ret_write` and its siblings in
// tests/fuzz-ops.ts).
//
// WHAT THIS FILE PINS is the one place the two backends still differ, so that
// it is a recorded decision instead of a surprise: a row that was ALIASED
// into two slots. The sync draft's removed row is still the same object as
// the slot left behind, so writing to it changes both. The async proxy hands
// back a detached clone, so it changes one. Aliasing one object into two
// array slots is already its own regime (see ALIAS_KINDS in fuzz-ops.ts); the
// detached reading is the one an author writing the queue idiom expects, and
// it is the one that survives a commit.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type Row = { id: number; q: number };
type S = { items: Row[]; done: Row[] };

/** Run one body as a sync method and as an async one, and report both. */
async function both(
  name: string,
  body: (s: S) => void,
  init: () => S,
): Promise<{ sync: S; async: S; syncErr: string; asyncErr: string }> {
  const err = { s: "", a: "" };
  const sc = cell(`${name}_s`, {
    state: init() as Any,
    methods: {
      run(s: Any) {
        try {
          body(s);
        } catch (e) {
          err.s = e instanceof Error ? e.message : String(e);
        }
      },
    },
  });
  const ac = cell(`${name}_a`, {
    state: init() as Any,
    methods: {
      // deno-lint-ignore require-await
      async run(s: Any) {
        try {
          body(s);
        } catch (e) {
          err.a = e instanceof Error ? e.message : String(e);
        }
      },
    },
  });
  const h = await bootCells([sc, ac]);
  try {
    await (sc as Any).run();
    await (ac as Any).run();
    await h.settle();
    const snap = (c: Any): S => ({
      items: JSON.parse(JSON.stringify(c.items)),
      done: JSON.parse(JSON.stringify(c.done)),
    });
    return {
      sync: snap(sc),
      async: snap(ac),
      syncErr: err.s,
      asyncErr: err.a,
    };
  } finally {
    h.dispose();
  }
}

const freshQueue = (): S => ({
  items: [{ id: 1, q: 10 }, { id: 2, q: 20 }],
  done: [],
});

Deno.test("a shifted row can be written to and re-parented, in both backends", async () => {
  const r = await both("detach_shift", (s) => {
    const row = s.items.shift()!;
    row.q = 99;
    s.done.push(row);
  }, freshQueue);
  assertEquals(r.syncErr, "", "a sync method must not throw here");
  assertEquals(r.asyncErr, "", "an async method must not throw here either");
  assertEquals(r.async, r.sync, "sync and async must agree");
  assertEquals(r.sync.done, [{ id: 1, q: 99 }]);
  assertEquals(r.sync.items, [{ id: 2, q: 20 }]);
});

Deno.test("a popped row can be written to and re-parented, in both backends", async () => {
  const r = await both("detach_pop", (s) => {
    const row = s.items.pop()!;
    row.q = 77;
    s.done.push(row);
  }, freshQueue);
  assertEquals(r.syncErr, "");
  assertEquals(r.asyncErr, "");
  assertEquals(r.async, r.sync);
  assertEquals(r.sync.done, [{ id: 2, q: 77 }]);
});

Deno.test("a spliced row can be written to and re-parented, in both backends", async () => {
  const r = await both("detach_splice", (s) => {
    const [row] = s.items.splice(0, 1);
    row!.q = 55;
    s.done.push(row!);
  }, freshQueue);
  assertEquals(r.syncErr, "");
  assertEquals(r.asyncErr, "");
  assertEquals(r.async, r.sync);
  assertEquals(r.sync.done, [{ id: 1, q: 55 }]);
});

Deno.test("writing a removed row does not reach back into the array it left", async () => {
  const r = await both("detach_noreach", (s) => {
    const row = s.items.shift()!;
    row.q = 12345;
  }, freshQueue);
  assertEquals(r.asyncErr, "");
  assertEquals(r.async.items, [{ id: 2, q: 20 }]);
  assertEquals(r.async, r.sync);
});

Deno.test("THE ONE DIVERGENCE: an ALIASED row, removed and written", async () => {
  // `fill` puts ONE object in every slot. Removing one slot and writing to it
  // changes the other slot in a sync method (same object) and does not in an
  // async one (detached clone). Pinned so that changing either side is a
  // deliberate act with a red test behind it, not a silent drift.
  const r = await both("detach_alias", (s) => {
    s.items.fill({ id: 9, q: 1 });
    const row = s.items.pop()!;
    row.q = 2;
  }, freshQueue);
  assertEquals(r.syncErr, "");
  assertEquals(r.asyncErr, "");
  assertEquals(
    r.sync.items,
    [{ id: 9, q: 2 }],
    "sync: the slot left behind is the SAME object, so it moved too",
  );
  assertEquals(
    r.async.items,
    [{ id: 9, q: 1 }],
    "async: the removed row is a detached clone, so the slot left behind did not move",
  );
});
