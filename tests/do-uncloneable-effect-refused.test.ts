// `s.$do(effect)` with an effect the effect seam cannot structuredClone (a
// function in a scheduled action's payload) was logged at ERROR and DROPPED
// after the method returned: the call resolved, no timer was armed, and a
// test asserting on state stayed green. Tests are the strictest environment —
// dev/test now refuse it AT the `$do` call, naming the effect; prod keeps
// log + drop (dev stricter than prod, never the reverse).
import { assertEquals, assertRejects } from "@std/assert";
import { cell, schedule } from "../mod.ts";
import { testCell } from "../src/testing/cell-test.ts";

// A scheduled action whose payload holds a function — valid to BUILD, never
// copyable.
const badAction = (id: string) =>
  schedule.after(
    id,
    10,
    { type: "doclone:ping", payload: { fn: () => 1 } } as never,
  );

const c = cell("doclone", {
  state: { n: 0 },
  methods: {
    syncBad(s) {
      s.n++;
      s.$do(badAction("sync-t"));
    },
    async asyncBad(s) {
      await Promise.resolve();
      s.n++;
      s.$do(badAction("async-t"));
    },
    ping(s) {
      s.n += 10;
    },
  },
});

testCell(c, "sync method: the call rejects naming the effect", async (t) => {
  await assertRejects(
    () => t.send.syncBad(),
    Error,
    'syncBad(): s.$do(...) effect "__schedule after sync-t" cannot be structured-cloned',
  );
  // The reduce failed, so its write did not commit either.
  assertEquals(t.getState().n, 0);
});

testCell(c, "async method: the call rejects naming the effect", async (t) => {
  await assertRejects(
    () => t.send.asyncBad(),
    Error,
    'asyncBad(): s.$do(...) effect "__schedule after async-t" cannot be structured-cloned',
  );
});

testCell(
  c,
  "prod (no __aioDev): the call resolves and the effect is logged + dropped",
  async (t) => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.__aioDev;
    const errors: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    const capture = (...a: unknown[]) => errors.push(a.map(String).join(" "));
    console.error = capture;
    console.log = capture;
    g.__aioDev = false;
    try {
      await t.send.syncBad();
    } finally {
      g.__aioDev = prev;
      console.error = origError;
      console.log = origLog;
    }
    assertEquals(t.getState().n, 1);
    assertEquals(
      errors.some((l) => l.includes("is not structuredClone-able — dropped")),
      true,
      `prod must still say it dropped the effect; got:\n${errors.join("\n")}`,
    );
  },
);
