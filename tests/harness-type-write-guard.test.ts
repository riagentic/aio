// The declared-type write guard runs under the in-process harnesses too.
//
// A dev server refuses a committed write that changes a persisted field's
// declared type (declared-type-write-guard.test.ts). The guard was installed
// only on a persisting boot, and `testCell`/`bootCells`/`testUI` persist
// nothing — so the same method passed its test and threw the first time the
// app ran in dev. Tests are the strictest environment: the harness refuses it
// too, with the server's own exemptions (unpersisted fields, `null`/
// `undefined` declarations, open shapes).
import { assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells, testCell } from "../src/cell-test.ts";

type St = {
  cfg: { x: number };
  count: number;
  user: { name: string } | null;
  cache: number;
  map: Record<string, number>;
};

const make = (id: string) =>
  cell(id, {
    state: { cfg: { x: 1 }, count: 0, user: null, cache: 0, map: {} } as St,
    persist: { exclude: ["cache"] },
    methods: {
      increment(s: St, by: unknown) {
        // deno-lint-ignore no-explicit-any
        (s as any).count += by;
      },
      async asyncSet(s: St, v: unknown) {
        await Promise.resolve();
        // deno-lint-ignore no-explicit-any
        (s as any).count = v;
      },
      loose(s: St) {
        s.user = { name: "ada" };
        // deno-lint-ignore no-explicit-any
        (s as any).cache = "not persisted";
        // deno-lint-ignore no-explicit-any
        (s.map as any).k = "v";
        // `undefined` is no type: JSON stores nothing, the restore fills the
        // default — the deleted-key case, said and never refused.
        s.cfg = { ...s.cfg, x: undefined as unknown as number };
      },
    },
  });

type Calls = {
  increment: (by: unknown) => Promise<unknown>;
  asyncSet: (v: unknown) => Promise<unknown>;
  loose: () => Promise<unknown>;
};

const tc = make("htg1");
testCell(
  tc,
  "testCell refuses a write that changes a declared type",
  async (t) => {
    const m = tc as unknown as Calls;
    await assertRejects(() => m.increment({ by: 2 }), Error, "htg1.count");
    assertEquals((t.state as St).count, 0);
    await m.increment(2);
    assertEquals((t.state as St).count, 2);
    await assertRejects(() => m.asyncSet("x"), Error, "htg1.count");
    assertEquals((t.state as St).count, 2);
    await m.loose();
    assertEquals((t.state as St).user, { name: "ada" });
  },
);

Deno.test("bootCells refuses a write that changes a declared type", async () => {
  const c = make("htg2");
  await using h = await bootCells([c]);
  const m = c as unknown as Calls;
  const st = () => c as unknown as St;
  await h.settle();
  await assertRejects(() => m.increment({ by: 2 }), Error, "htg2.count");
  assertEquals(st().count, 0);
  await assertRejects(() => m.asyncSet("x"), Error, "htg2.count");
  await m.increment(3);
  await m.loose();
  assertEquals(st().count, 3);
  assertEquals(st().user, { name: "ada" });
});

// A `Date` is stored as the string its `toJSON` returns: written into a field
// declared as a string it restores as exactly that string, so nothing is lost
// and nothing may be refused. An in-process caller hands a method a real
// `Date` where the wire hands it the ISO string (docs/state/methods.md).
type Due = { due: string; at: { when: string } };
const dated = cell("htg3", {
  state: { due: "", at: { when: "" } } as Due,
  methods: {
    setDue(s: Due, d: unknown) {
      // deno-lint-ignore no-explicit-any
      (s as any).due = d;
      // deno-lint-ignore no-explicit-any
      (s as any).at = { when: d };
    },
  },
});
testCell(dated, "a Date written to a string field is not refused", async () => {
  const m = dated as unknown as { setDue: (d: unknown) => Promise<unknown> };
  await m.setDue(new Date(0));
  await assertRejects(() => m.setDue(5), Error, "htg3.due");
});
