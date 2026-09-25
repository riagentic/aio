// A row reference held across an `await` in an async method, while ANOTHER
// action re-addresses the array's rows.
//
// The async `s` is a PATH view: `const row = s.items.find(…)` is "whatever
// s.items[2] holds now". The stale-capture ledger refuses a held reference
// after THIS method's own index-moving write (docs/state/methods.md), but a
// foreign commit landing during the await — another method unshifting,
// sorting or filtering the same array — was invisible to it: the held row
// silently re-addressed a DIFFERENT row, and `row.v = "saved"` wrote into it
// (row 2 said "saved", row 3 stayed "saving" forever). Same silent wrong data
// the ledger exists to refuse, so it is refused the same way.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Row = { id: number; v: string };

const rows = (): Row[] => [
  { id: 1, v: "a" },
  { id: 2, v: "b" },
  { id: 3, v: "c" },
  { id: 4, v: "d" },
];

/** A cell whose `mark` holds a row across an await the test controls. */
function fixture(id: string) {
  let release!: () => void;
  const gate = () => new Promise<void>((r) => (release = r));
  const c = cell(id, {
    state: { items: rows() },
    methods: {
      async mark(s: { items: Row[] }, rid: number) {
        const row = s.items.find((r) => r.id === rid)!;
        row.v = "saving";
        await gate();
        row.v = "saved";
      },
      async markFresh(s: { items: Row[] }, rid: number) {
        s.items.find((r) => r.id === rid)!.v = "saving";
        await gate();
        s.items.find((r) => r.id === rid)!.v = "saved";
      },
      async markAfterOwnFilter(s: { items: Row[] }) {
        s.items = s.items.filter((r) => r.id !== 1);
        const row = s.items[1]!; // id 3, fetched AFTER the own overwrite
        await gate();
        row.v = "saved";
      },
      prepend(s: { items: Row[] }) {
        s.items.unshift({ id: 0, v: "new" });
      },
      sortDesc(s: { items: Row[] }) {
        s.items.sort((a, b) => b.id - a.id);
      },
      remove(s: { items: Row[] }, rid: number) {
        s.items = s.items.filter((r) => r.id !== rid);
      },
      append(s: { items: Row[] }) {
        s.items.push({ id: 9, v: "z" });
      },
      edit(s: { items: Row[] }, rid: number) {
        s.items.find((r) => r.id === rid)!.v = "edited";
      },
    },
  });
  return { c: c as Any, release: () => release() };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const byId = (items: Row[]) =>
  Object.fromEntries(items.map((r) => [r.id, r.v]));

for (
  const [name, foreign] of [
    ["unshift", (c: Any) => c.prepend()],
    ["sort", (c: Any) => c.sortDesc()],
    ["filter out an earlier row", (c: Any) => c.remove(1)],
    ["filter out the held row", (c: Any) => c.remove(3)],
  ] as const
) {
  Deno.test(`foreign move: a row held across an await is refused after another action's ${name}`, async () => {
    const { c, release } = fixture(`fm_${name.replace(/\W/g, "_")}`);
    const h = await bootCells([c]);
    try {
      const p = c.mark(3);
      await tick();
      await foreign(c);
      release();
      const e = await assertRejects(() => p);
      assert(
        String(e).includes("another action"),
        `the refusal names the foreign re-addressing: ${e}`,
      );
      await h.settle();
      const got = byId(c.items);
      assert(Object.keys(got).length > 1, "rows are left to check");
      // Nothing but row 3 was ever this method's to write.
      for (const [rid, v] of Object.entries(got)) {
        if (rid !== "3") assert(v !== "saved", `row ${rid} got the write`);
      }
    } finally {
      h.dispose();
    }
  });
}

Deno.test("foreign move: a held row still writes when the other action did not re-address it", async () => {
  for (
    const foreign of [
      (c: Any) => c.append(),
      (c: Any) => c.edit(3),
      (c: Any) => c.edit(1),
    ]
  ) {
    const { c, release } = fixture("fm_ok");
    const h = await bootCells([c]);
    try {
      const p = c.mark(3);
      await tick();
      await foreign(c);
      release();
      await p;
      await h.settle();
      assertEquals(byId(c.items)[3], "saved");
    } finally {
      h.dispose();
    }
  }
});

Deno.test("foreign move: a fresh re-fetch after the await follows the row", async () => {
  const { c, release } = fixture("fm_fresh");
  const h = await bootCells([c]);
  try {
    const p = c.markFresh(3);
    await tick();
    await c.prepend();
    release();
    await p;
    await h.settle();
    assertEquals(byId(c.items), {
      0: "new",
      1: "a",
      2: "b",
      3: "saved",
      4: "d",
    });
  } finally {
    h.dispose();
  }
});

Deno.test("foreign move: a row fetched after the method's own overwrite stays valid", async () => {
  const { c, release } = fixture("fm_own");
  const h = await bootCells([c]);
  try {
    const p = c.markAfterOwnFilter();
    await tick();
    release();
    await p;
    await h.settle();
    assertEquals(byId(c.items), { 2: "b", 3: "saved", 4: "d" });
  } finally {
    h.dispose();
  }
});

// The class, not the instances: random foreign programs land during the await
// of a method that holds a row. Whatever they do, the held write either lands
// on ITS row or is refused by name — never on another row, never silently
// lost. And a program that re-addressed nothing must never be refused.
Deno.test("foreign move: random foreign programs never redirect a held write", async () => {
  let seed = fuzzEnvInt("FUZZ_SEED", 0x5a1e) & 0x7fffffff;
  const rnd = (n: number) =>
    Math.floor(
      ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000) * n,
    );
  const ops = ["prepend", "sortDesc", "append", "edit", "remove"] as const;
  let refused = 0, landed = 0;
  let checked = 0;
  for (let round = 0; round < fuzzEnvInt("FUZZ_ROUNDS", 60, 1); round++) {
    const { c, release } = fixture(`fm_fz_${round}`);
    const h = await bootCells([c]);
    try {
      const rid = 1 + rnd(4);
      const p = c.mark(rid);
      await tick();
      const drawn = Array.from(
        { length: 1 + rnd(3) },
        () => ops[rnd(ops.length)]!,
      );
      // Excluded, by name — the one blind spot, and it fails OPEN (the
      // pre-fix behaviour): a slot whose row became a NEW object. Identity is
      // the only evidence a commit leaves, and an edited row is a new object,
      // so "the held row was edited in place" (legal, common: a progress
      // update on the row a job holds) cannot be told from "the held row was
      // removed and another row now sits in its slot" when no surviving row
      // shifted across it. So: no window both moves and edits rows, and no
      // foreign `remove` takes the held row itself (a removal that shifts
      // other rows into its slot IS judged — see the fixed cases above).
      const prog = drawn.some((o) => o !== "append" && o !== "edit")
        ? drawn.filter((o) => o !== "edit")
        : drawn;
      let moved = false;
      for (const op of prog) {
        const before: Row[] = c.items;
        const idx = before.findIndex((r) => r.id === rid);
        if (op === "edit" || op === "remove") {
          const pool = op === "remove"
            ? before.filter((r) => r.id !== rid)
            : before;
          if (!pool.length) continue;
          const other = pool[rnd(pool.length)]!.id;
          await c[op](other);
          if (op === "remove") {
            const at = before.findIndex((r) => r.id === other);
            if (at < idx) moved = true; // the held row shifted down
          }
        } else {
          await c[op]();
          if (
            op !== "append" &&
            c.items.findIndex((r: Row) => r.id === rid) !== idx
          ) moved = true;
        }
      }
      release();
      const repro = `round ${round}: mark(${rid}) vs ${prog.join(",")}`;
      let err: unknown = null;
      await p.catch((e: unknown) => (err = e));
      await h.settle();
      const got = byId(c.items);
      checked += Object.keys(got).length;
      // aio-ok: a round may filter every row away; `checked` is asserted > 0 after the rounds
      for (const [id, v] of Object.entries(got)) {
        if (Number(id) !== rid) {
          assert(v !== "saved", `row ${id} got the write — ${repro}`);
        }
      }
      if (err === null) {
        landed++;
        if (rid in got) assertEquals(got[rid], "saved", repro);
      } else {
        refused++;
        assert(String(err).includes("another action"), `${repro}: ${err}`);
        assert(
          moved,
          `refused although nothing re-addressed the row — ${repro}`,
        );
      }
    } finally {
      h.dispose();
    }
  }
  assert(
    refused > 0 && landed > 0,
    `both outcomes exercised (${refused}/${landed})`,
  );
  assert(checked > 0, "rows were left to check across the rounds");
});
