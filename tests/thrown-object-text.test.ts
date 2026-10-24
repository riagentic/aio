// A thrown NON-Error value must reach every report as what it says, never as
// "[object Object]".
//
// `describeThrown` answers a thrown `{ code, detail }` with its JSON, and the
// user-facing log lines used it — but the async `:__error` frame's `error`
// (what `debug.log`'s "<m> failed" line, `onAction` and the timeline read) was
// still `String(e)`, and so were the afterAction HOOK_ERROR report and the
// "async effect rejected after timeout" warning.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import type { AioError } from "../src/diagnostics/error.ts";
import { testServer } from "../src/testing/server-test.ts";

Deno.test("a thrown plain object: the async :__error frame carries its JSON", async () => {
  const c = cell("thrown-obj", {
    state: { n: 0 },
    methods: {
      async bad(s) {
        s.n++;
        await Promise.resolve();
        throw { code: "E_THROWN", detail: "why" };
      },
    },
  });
  const seen: unknown[] = [];
  const srv = await testServer({
    cells: [c],
    onAction: (a) => {
      const act = a as { type: string; payload?: { error?: unknown } };
      if (act.type.endsWith(":__error")) seen.push(act.payload?.error);
    },
  });
  try {
    await assertRejects(() => c.bad());
    for (let i = 0; i < 50 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(seen.length, 1, "the __error frame was dispatched");
    assertEquals(seen[0], '{"code":"E_THROWN","detail":"why"}');
  } finally {
    await srv.close();
  }
});

Deno.test("a thrown Error keeps its `Name: message` text in :__error", async () => {
  const c = cell("thrown-err", {
    state: { n: 0 },
    methods: {
      async bad(s) {
        s.n++;
        await Promise.resolve();
        throw new TypeError("boom");
      },
    },
  });
  const seen: unknown[] = [];
  const srv = await testServer({
    cells: [c],
    onAction: (a) => {
      const act = a as { type: string; payload?: { error?: unknown } };
      if (act.type.endsWith(":__error")) seen.push(act.payload?.error);
    },
  });
  try {
    await assertRejects(() => c.bad());
    for (let i = 0; i < 50 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(seen, ["TypeError: boom"]);
  } finally {
    await srv.close();
  }
});

Deno.test("an afterAction hook throwing a plain object: HOOK_ERROR names it", async () => {
  const errors: AioError[] = [];
  let state = { n: 0 };
  const dispatch = createDispatch<
    { n: number },
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({ state: { n: s.n + 1 }, effects: [] }),
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    afterAction: () => {
      throw { code: "HOOK_OBJ" };
    },
    reportOpts: { onError: (e) => errors.push(e) },
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    debug: false,
  });
  await dispatch({ type: "INC" });
  assertEquals(errors.length, 1);
  assert(
    errors[0]!.message.includes('{"code":"HOOK_OBJ"}'),
    errors[0]!.message,
  );
});
