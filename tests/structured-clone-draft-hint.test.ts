// studio §6: `structuredClone(s.story)` inside a method failed as
// "#<Object> could not be cloned." — an engine message that names neither the
// draft nor the fix. The method's error now carries the hint, on the sync
// (Immer draft) and the async (live proxy) path alike, dev == prod.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { draftCloneError } from "../src/state/immutable.ts";
import { createAioError, generateTip } from "../src/diagnostics/error.ts";
import { cell } from "aio";
import { testCell } from "aio/testing";

const story = cell("cloneStory", {
  state: { story: { title: "t", tags: ["a"] }, copy: null as unknown },
  methods: {
    syncCopy(s) {
      s.copy = structuredClone(s.story);
    },
    async asyncCopy(s) {
      await Promise.resolve();
      s.copy = structuredClone(s.story);
    },
  },
});

for (const m of ["syncCopy", "asyncCopy"] as const) {
  testCell(story, `${m}: structuredClone of state names the fix`, async (t) => {
    let msg = "";
    try {
      await t.send[m]();
    } catch (e) {
      msg = String((e as Error).message);
    }
    assertStringIncludes(msg, "could not be cloned");
    assertStringIncludes(msg, "JSON.parse(JSON.stringify(");
  });
}

Deno.test("draftCloneError: only a clone refusal is rewrapped", () => {
  assertEquals(draftCloneError(new Error("boom")), undefined);
  assertEquals(draftCloneError("x"), undefined);
  let raw: unknown;
  try {
    structuredClone({ f() {} });
  } catch (e) {
    raw = e;
  }
  const w = draftCloneError(raw)!;
  assertEquals(w.name, "DataCloneError");
  assertEquals(w.cause, raw);
});

Deno.test("the clone refusal's fix is not contradicted by the generic proxy tip", () => {
  // The wrapped message says "spread one level" and contains the word
  // "proxy" — which put the generic proxy tip ("avoid .spread") beside it.
  const e = draftCloneError(
    Object.assign(new Error("#<Object> could not be cloned."), {
      name: "DataCloneError",
    }),
  )!;
  const tip = generateTip(
    createAioError("REDUCE_ERROR", e, {
      cellName: "cloneStory",
      actionType: "cloneStory:syncCopy",
    }),
  );
  assertEquals(/Proxy state error|\.spread/.test(tip ?? ""), false, tip);
});
