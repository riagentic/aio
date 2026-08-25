// Stale-capture detection (R-1). In a SYNC method a captured reference
// keeps the old object (`const req = s.pending; s.pending = null; req.sid` is
// still the old sid). The async live proxy is a PATH view, so the identical
// code used to resolve through `pending` to the NEW value — a bare TypeError
// when nulled, or SILENT WRONG DATA when replaced. The two flavours cannot
// agree by construction (the proxy re-resolves its path on purpose), so the
// proxy now refuses loudly: any use of a reference captured BEFORE this
// method overwrote its container throws a named error.
//
// This is a DELIBERATE sync/async divergence (throw where sync silently keeps
// the old object), so it lives here and not in the differential fuzzer — fuzz
// ops must never capture-overwrite-read (tests/fuzz-ops.ts says so too).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "aio";
import { testCell } from "aio/testing";

type Req = { sid: string; who: string } | null;

const mk = () =>
  cell(`stale-${crypto.randomUUID().slice(0, 8)}`, {
    state: {
      pending: { sid: "s1", who: "alice" } as Req,
      answered: "",
      items: [{ id: 1, q: 10 }, { id: 2, q: 20 }, { id: 3, q: 30 }],
    },
    methods: {
      async nulled(s) {
        const req = s.pending;
        s.pending = null;
        if (!req) return;
        await Promise.resolve();
        s.answered = req.sid; // the reported shape
      },
      async replacedRead(s) {
        const req = s.pending;
        s.pending = { sid: "s2", who: "bob" };
        await Promise.resolve();
        s.answered = req!.sid; // the SILENT wrong-data case pre-fix
      },
      async staleWrite(s) {
        const req = s.pending;
        s.pending = null;
        req!.who = "ghost"; // write through the stale reference
      },
      async staleSpread(s) {
        const req = s.pending;
        s.pending = null;
        s.answered = JSON.stringify({ ...req }); // ownKeys through stale ref
      },
      async staleIn(s) {
        const req = s.pending;
        s.pending = null;
        s.answered = String("sid" in req!); // has trap through stale ref
      },
      async elementAfterSort(s) {
        const el = s.items.find((x) => x.q === 10)!;
        s.items.sort((a, b) => b.q - a.q); // index-moving mutator
        el.q = 99; // el is a PATH proxy — it would hit a different element
      },
      async elementAfterSplice(s) {
        const el = s.items[2]!;
        s.items.splice(0, 1); // everything from index 0 shifts
        el.q = 99;
      },
      async elementBeforeSpliceRange(s) {
        const el = s.items[0]!;
        s.items.splice(2, 1); // indexes < 2 untouched
        el.q = 111; // legal — splice starts past this element
      },
      async elementAfterPush(s) {
        const el = s.items[0]!;
        s.items.push({ id: 9, q: 90 }); // push never moves existing indexes
        el.q = 111; // legal
      },
      async fillPastEnd(s) {
        const el = s.items[2]!;
        s.items.fill({ id: 0, q: 0 }, 0, 2); // fills [0,2) — index 2 untouched
        el.q = 222; // legal — precise fill range
      },
      async refetchAfterOverwrite(s) {
        s.pending = { sid: "s9", who: "carol" };
        s.answered = s.pending.sid; // FRESH fetch after overwrite — legal
        await Promise.resolve();
        s.pending.who = "carol2"; // and deep write through it — legal
      },
      async siblingUntouched(s) {
        const req = s.pending;
        s.answered = "x"; // a DIFFERENT key
        await Promise.resolve();
        s.answered = req!.sid; // legal — pending was never overwritten
      },
      async deepWriteKeepsParent(s) {
        const req = s.pending;
        s.pending!.who = "alice2"; // writes INTO it, does not replace it
        await Promise.resolve();
        s.answered = req!.who; // legal
      },
      async replaceOtherIndex(s) {
        const e0 = s.items[0]!;
        s.items[1] = { id: 9, q: 90 }; // a different index
        s.answered = String(e0.q); // legal
      },
      async replaceSameIndex(s) {
        const e0 = s.items[0]!;
        s.items[0] = { id: 9, q: 90 }; // THIS element's own slot
        s.answered = String(e0.q); // stale — e0 would read the new element
      },
      async returnStale(s) {
        const req = s.pending;
        s.pending = null;
        return req; // materialization seam (LIVE_RAW) must refuse too
      },
    },
  });

const STALE = /stale reference/;

testCell(
  mk(),
  "stale capture: nulled container read throws named error",
  async (t) => {
    const err = await assertRejects(() => t.send.nulled!(), Error);
    assert(STALE.test(err.message), err.message);
    assert(err.message.includes("s.pending"), err.message);
    assert(err.message.includes(":nulled]"), err.message);
    assert(err.message.includes("{ ...s.pending }"), err.message);
  },
);

testCell(
  mk(),
  "stale capture: replaced container read throws (was silent wrong data)",
  async (t) => {
    const err = await assertRejects(() => t.send.replacedRead!(), Error);
    assert(STALE.test(err.message), err.message);
    // The whole point: the answer must NOT become the replacement's sid.
    assertEquals(t.getState().answered, "");
  },
);

for (const m of ["staleWrite", "staleSpread", "staleIn"] as const) {
  testCell(mk(), `stale capture: ${m} through stale ref throws`, async (t) => {
    const err = await assertRejects(() => t.send[m]!(), Error);
    assert(STALE.test(err.message), `${m}: ${err.message}`);
  });
}

for (const m of ["elementAfterSort", "elementAfterSplice"] as const) {
  testCell(
    mk(),
    `stale capture: ${m} invalidates captured element`,
    async (t) => {
      const err = await assertRejects(() => t.send[m]!(), Error);
      assert(STALE.test(err.message), `${m}: ${err.message}`);
    },
  );
}

testCell(
  mk(),
  "stale capture: replacing THIS element's slot invalidates it",
  async (t) => {
    const err = await assertRejects(() => t.send.replaceSameIndex!(), Error);
    assert(STALE.test(err.message), err.message);
  },
);

testCell(
  mk(),
  "stale capture: a sibling write, a deep write and another index stay legal",
  async (t) => {
    // The guard must fire on the ONE shape that is wrong. A rule that also
    // refused these would make the live proxy unusable — every async method
    // reads something it later writes near.
    await t.send.siblingUntouched!();
    assertEquals(t.getState().answered, "s1");
    await t.send.deepWriteKeepsParent!();
    assertEquals(t.getState().answered, "alice2");
    await t.send.replaceOtherIndex!();
    assertEquals(t.getState().answered, "10");
  },
);

testCell(
  mk(),
  "stale capture: push, out-of-range splice/fill, and re-fetch stay legal",
  async (t) => {
    await t.send.elementAfterPush!();
    assertEquals(t.getState().items[0]!.q, 111);
    await t.send.elementBeforeSpliceRange!();
    assertEquals(t.getState().items[0]!.q, 111);
    await t.send.fillPastEnd!();
    assertEquals(t.getState().items[2]!.q, 222);
    await t.send.refetchAfterOverwrite!();
    assertEquals(t.getState().pending, { sid: "s9", who: "carol2" });
    assertEquals(t.getState().answered, "s9");
  },
);

testCell(
  mk(),
  "stale capture: returning a stale reference refuses at the materialization seam",
  async (t) => {
    const err = await assertRejects(() => t.send.returnStale!(), Error);
    assert(STALE.test(err.message), err.message);
  },
);

const txCell = cell(`stale-tx-${crypto.randomUUID().slice(0, 8)}`, {
  transaction: true,
  state: { pending: { sid: "s1", who: "alice" } as Req, answered: "" },
  methods: {
    async txStale(s) {
      const req = s.pending;
      s.pending = null;
      await Promise.resolve();
      s.answered = req!.sid; // pinned proxy — same ledger, same refusal
    },
  },
});

testCell(
  txCell,
  "stale capture: transactional methods refuse identically",
  async (t) => {
    const err = await assertRejects(() => t.send.txStale!(), Error);
    assert(STALE.test(err.message), err.message);
  },
);
