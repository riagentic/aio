// A held row proxy stays guarded across a first frame's write-set.
//
// A call's first frame runs inside the dispatch loop, so its write-set is
// queued, not applied, when `dispatch` returns. The stale-capture guard was
// told "after" at that moment, saw an unmoved state, and re-baselined to
// "unknown" — so a foreign `unshift` reduced next was absorbed unjudged, and
// the held `row` proxy wrote "saved" into the row that slid into its slot
// instead of throwing the named `stale reference` error. The guard is now
// told when the write-set lands. Same blindness after a write-set the store
// REFUSED (`validate`): unchanged state read as "unknown", so the next
// foreign move went unjudged — in testCell's own loop as well.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells, testCell } from "../src/testing/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Row = { id: string; v: string };
type S = { rows: Row[]; err: string; bad: boolean };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mk = (id: string) => {
  const c: Any = cell(id, {
    state: {
      rows: [{ id: "a", v: "" }, { id: "b", v: "" }],
      err: "",
      bad: false,
    } as S,
    validate: (s: S) => s.bad ? "refused" : true,
    methods: {
      // A refused write-set between the capture and the foreign move.
      async saveAfterRefusal(s: S) {
        const row = s.rows[0]!;
        await sleep(1);
        s.bad = true;
        await sleep(10);
        try {
          row.v = "saved";
        } catch (e) {
          s.err = (e as Error).message;
        }
      },
      async save(s: S) {
        const row = s.rows[0]!;
        row.v = "first";
        await sleep(5);
        try {
          row.v = "saved";
        } catch (e) {
          s.err = (e as Error).message;
        }
      },
      unshift(s: S) {
        s.rows.unshift({ id: "NEW", v: "" });
      },
      both() {
        c.save();
        c.unshift();
      },
    },
  });
  return c;
};

const check = (c: Any) => {
  assertStringIncludes(c.err, "stale reference");
  assertEquals(
    c.rows.map((r: Row) => r.v).includes("saved"),
    false,
    `"saved" went into a row: ${JSON.stringify(c.rows)}`,
  );
};

Deno.test({ // aio-ok: the assertions are in check()
  name: "first-frame write-set keeps the stale guard armed — server",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const c = mk("stl_srv");
    const srv = await testServer({ cells: [c] });
    try {
      await c.both();
      await sleep(40);
      check(c);
    } finally {
      await srv.close();
    }
  },
});

Deno.test("first-frame write-set keeps the stale guard armed — bootCells", async () => { // aio-ok: the assertions are in check()
  const c = mk("stl_boot");
  const h = await bootCells([c]);
  try {
    await c.both();
    await sleep(40);
    await h.settle();
    check(c);
  } finally {
    h.dispose();
  }
});

// The refused write-set case, on the server loop and in testCell's own.
async function refusedThenMoved(
  save: () => Promise<unknown>,
  unshift: () => Promise<unknown>,
) {
  const done = save().catch(() => {}); // the refusal rejects the call
  await sleep(5);
  await unshift();
  await done;
}

Deno.test({ // aio-ok: the assertions are in check()
  name: "a refused write-set keeps the stale guard armed — server",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const c = mk("stl_srv_r");
    const srv = await testServer({ cells: [c] });
    try {
      await refusedThenMoved(() => c.saveAfterRefusal(), () => c.unshift());
      await sleep(20);
      check(c);
    } finally {
      await srv.close();
    }
  },
});

testCell(
  mk("stl_tc_r"),
  "a refused write-set keeps the stale guard armed",
  async (t) => {
    const send = t.send as Any;
    await refusedThenMoved(() => send.saveAfterRefusal(), () => send.unshift());
    await t.settle();
    check(t.state);
  },
);
