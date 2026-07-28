// A list that grows must not re-ship itself on every commit.
//
// `s.items.push(x)` patches as one `add`, but `s.items = [...s.items, ...batch]`
// is just as idiomatic and Immer can only describe it as "replace the whole
// array". A scan that appends in batches therefore re-sent its entire growing
// list every time — quadratic in the number of batches, and the reason a
// hardware-wallet scan had to hand-throttle its own state writes to stay under
// vitals PRESSURE.
//
// Measured at the seam where patches are BORN — the composed reducer — because
// that is deterministic: no server, no coalescing window, no timing. What the
// transport does with them afterwards is a different test's business.
import { assert, assertEquals } from "@std/assert";
import type { Patch } from "immer";
import { cell } from "../src/state/cell.ts";
import { composeCells } from "../src/state/cell-compose.ts";

/** The composed reducer attaches the commit's patches; they are not in the
 *  public return type, so a test that inspects them says so out loud. */
type Reduced = {
  state: Record<string, unknown>;
  patches?: { cell: string; ops: Patch[] }[];
};

const scan = cell("scan", {
  state: { found: [] as { id: number; blob: string }[] },
  methods: {
    // The spread form — a fresh array every time, which is what makes this
    // hard: the framework has to PROVE the old contents survived.
    addBatch(s, batch: { id: number; blob: string }[]) {
      s.found = [...s.found, ...batch];
    },
    // Appends AND rewrites the prefix — must fall back to a whole-array
    // replace, because the old contents did NOT survive.
    addAndBump(s, item: { id: number; blob: string }) {
      s.found = [...s.found.map((f) => ({ ...f, id: f.id + 1 })), item];
    },
  },
  persist: "none",
  ui: "all",
});

const item = (id: number) => ({ id, blob: "x".repeat(200) });
const composed = composeCells([scan]);
const bytesOf = (r: Reduced) => JSON.stringify(r.patches ?? []).length;
const call = (
  state: Record<string, unknown>,
  method: string,
  ...args: unknown[]
) =>
  composed.reduce(state, {
    type: `scan:${method}`,
    payload: { args },
  } as never) as Reduced;

Deno.test("appending to a list patches the appends, not the list", () => {
  const seeded = call(
    composed.initialState,
    "addBatch",
    Array.from({ length: 100 }, (_, i) => item(i)),
  );
  assertEquals((seeded.state.scan as { found: unknown[] }).found.length, 100);

  const grown = call(seeded.state, "addBatch", [item(100)]);
  const ops = grown.patches?.[0]?.ops ?? [];
  assertEquals(ops.length, 1, "one op for one appended item");
  assertEquals(ops[0]!.op, "add", "an append, not a replacement");
  assertEquals(ops[0]!.path, ["found", 100], "at the end of the list");

  // The number that mattered: appending one item to a 100-item list used to
  // cost the whole list.
  assert(
    bytesOf(grown) < bytesOf(seeded) / 20,
    `appending 1 to 100 cost ${bytesOf(grown)}B against a ${
      bytesOf(seeded)
    }B list`,
  );
});

Deno.test("the cost of appending does not grow with the list", () => {
  // The quadratic shape is the actual complaint: without narrowing, append N
  // costs O(N), so a scan costs O(N²) to broadcast. Here it must stay flat.
  let state = composed.initialState;
  state = call(state, "addBatch", Array.from({ length: 50 }, (_, i) => item(i)))
    .state;
  const early = bytesOf(call(state, "addBatch", [item(50)]));

  state = call(
    state,
    "addBatch",
    Array.from({ length: 450 }, (_, i) => item(50 + i)),
  ).state;
  assertEquals((state.scan as { found: unknown[] }).found.length, 500);
  const late = bytesOf(call(state, "addBatch", [item(500)]));

  // Flat, not identical: the only thing that legitimately grows is the digits
  // in the index and the id ("50" → "500").
  assert(
    Math.abs(late - early) < 10,
    `appending to a 500-item list cost ${late}B against ${early}B at 50 — ` +
      `the cost is following the list length`,
  );
});

Deno.test("a prefix that did NOT survive is still replaced wholesale", () => {
  const seeded = call(
    composed.initialState,
    "addBatch",
    Array.from({ length: 10 }, (_, i) => item(i)),
  );
  const bumped = call(seeded.state, "addAndBump", item(99));
  const ops = bumped.patches?.[0]?.ops ?? [];
  assertEquals(ops.length, 1);
  assertEquals(ops[0]!.op, "replace", "rewritten items are not an append");
  // …and the state is right, which is the only thing that must never bend.
  const found = (bumped.state.scan as { found: { id: number }[] }).found;
  assertEquals(found.length, 11);
  assertEquals(found.map((f) => f.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99]);
});
