// docs/debugging/errors.md lists a `validate` refusal under ACTION_REFUSED and
// shows `if (errorCode(e) === "ACTION_REFUSED") return "stale"`; the
// `refusalsReject` config row promises the in-process rejection comes "the way
// the wire already answers it (ACTION_REFUSED)". Measured: over the wire (and
// from a `worker: true` cell) the code is ACTION_REFUSED, but a main-isolate
// in-process call — every `bootCells`/`testUI` test, and an app with
// `refusalsReject: true` — rejected with REDUCE_ERROR. A test branching on the
// documented code took the other branch from the browser it models.
import "./store-sandbox.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { cell, errorCode } from "../mod.ts";
import { bootCells, testCell } from "aio/testing";

const guarded = cell("refcode", {
  state: { n: 0 },
  validate: (s: { n: number }) => s.n <= 1 || "n must stay <= 1",
  methods: {
    bump(s) {
      s.n++;
    },
    async abump(s) {
      await Promise.resolve();
      s.n++;
    },
    boom() {
      throw new Error("not allowed");
    },
  },
});

Deno.test("in process: a validate refusal carries ACTION_REFUSED, as on the wire", async () => {
  using h = await bootCells([guarded]);
  await guarded.bump();
  const sync = await assertRejects(
    () => guarded.bump(),
    Error,
    "n must stay <= 1",
  );
  assertEquals(errorCode(sync), "ACTION_REFUSED");
  const async_ = await assertRejects(
    () => guarded.abump(),
    Error,
    "n must stay <= 1",
  );
  assertEquals(errorCode(async_), "ACTION_REFUSED");
  assertEquals(guarded.n, 1);
  // The app's own throw keeps its classification.
  const own = await assertRejects(() => guarded.boom(), Error, "not allowed");
  assertEquals(errorCode(own), "REDUCE_ERROR");
  await h.settle();
});

testCell(guarded, "testCell: the same refusal, the same code", async (t) => {
  await t.send.bump();
  const e = await assertRejects(() => t.send.bump(), Error, "n must stay <= 1");
  assertEquals(errorCode(e), "ACTION_REFUSED");
  const own = await assertRejects(() => t.send.boom(), Error, "not allowed");
  assertEquals(errorCode(own), "REDUCE_ERROR");
});
