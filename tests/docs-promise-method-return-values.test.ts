// docs/state/methods.md:173-176 — "`null` is a value, `undefined` is
// 'nothing'. A method returning `null` resolves its caller with `null` — sync
// and async alike … Only `undefined` (or no `return` at all) resolves
// `undefined`." docs/state/methods.md:113-114 — "Returning a slice of draft
// state (`return s.items[id]`) is safe — the value is snapshotted, so it
// survives past the method (no revoked-proxy surprises)."
import { assertEquals, assertStrictEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "aio/testing";

type Row = { id: number; n: number };

const rv = cell("docsreturns", {
  state: { items: [{ id: 1, n: 1 }] as Row[] },
  methods: {
    nothing(_s) {},
    syncNull(_s): null {
      return null;
    },
    async asyncNull(_s): Promise<null> {
      await 0;
      return null;
    },
    async asyncNothing(_s) {
      await 0;
    },
    first(s): Row {
      return s.items[0]!;
    },
    bump(s) {
      s.items[0]!.n++;
    },
    // The same PLAIN wrapper handed back on two branches — a DAG, not a cycle.
    wrapped(s): { a: { row: Row }; b: { row: Row } } {
      const w = { row: s.items[0]! };
      return { a: w, b: w };
    },
  },
});

Deno.test("docs promise: null resolves null (sync and async), no return resolves undefined", async () => {
  const h = await bootCells([rv]);
  try {
    assertStrictEquals(await rv.syncNull(), null);
    assertStrictEquals(await rv.asyncNull(), null);
    assertStrictEquals(await rv.nothing(), undefined);
    assertStrictEquals(await rv.asyncNothing(), undefined);
  } finally {
    h.dispose();
  }
});

Deno.test("docs promise: a returned draft slice is a snapshot that outlives the method", async () => {
  const h = await bootCells([rv]);
  try {
    const row = await rv.first();
    await rv.bump();
    // Readable after the draft is gone, and not moved by the later write.
    assertEquals(row, { id: 1, n: 1 });
    assertEquals(rv.items[0]!.n, 2);
  } finally {
    h.dispose();
  }
});
