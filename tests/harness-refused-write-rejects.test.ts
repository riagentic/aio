// docs/basics/pitfalls.md:124-130 — "The harnesses are as strict as
// production, deliberately. `testCell`, `testUI`, `bootCells` and `testServer`
// all run dev-strict: … a refused write rejects the method that made it".
// docs/basics/api-reference.md:94 defines a "refused write" as "a write the
// reduce REFUSED (a `validate` hook)"; over the wire that call is answered
// ACTION_REFUSED and its `await` rejects.
//
// The harnesses boot with `refusalsReject` off, so a `validate` refusal
// RESOLVES the in-process caller (state unchanged, one dev warn line) — the
// test is more lenient than the browser client the component models.
import { assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells, testCell } from "aio/testing";

const guarded = cell("harnessrefused", {
  state: { n: 0 },
  validate: (s: { n: number }) => s.n <= 1 || "n must stay <= 1",
  methods: {
    bump(s) {
      s.n++;
    },
  },
});

Deno.test("bootCells: a validate-refused write rejects the method that made it", async () => {
  const h = await bootCells([guarded]);
  try {
    await guarded.bump(); // n = 1, accepted
    await assertRejects(
      () => guarded.bump(), // n = 2 — refused by validate
      Error,
      "n must stay <= 1",
    );
    assertEquals(guarded.n, 1, "the refused write left state alone");
  } finally {
    h.dispose();
  }
});

testCell(
  guarded,
  "testCell: a validate-refused write rejects the method that made it",
  async (t) => {
    await t.send.bump();
    await t.expect.rejects(() => t.send.bump(), "n must stay <= 1");
    t.expect.state((s) => s.n === 1);
  },
);
