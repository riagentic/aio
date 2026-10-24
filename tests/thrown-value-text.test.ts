// A thrown NON-Error reached the developer as "[object Object]" — `String(e)` /
// `${e}` on `throw { code: "E_QUOTA" }` says nothing — and a null-prototype
// value (`Object.create(null)`) made the REPORTER itself throw ("Cannot convert
// object to primitive value") from inside its own catch. Every site that
// reports a value USER code threw goes through `describeThrown`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createAioError, reportError } from "../src/diagnostics/error.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import {
  type DiagnosticEvent,
  diagSubscribe,
} from "../src/diagnostics/diagnostic-bus.ts";
import { cell } from "../mod.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import { thrownText } from "../src/diagnostics/fmt.ts";
import { testServer } from "../src/testing/server-test.ts";

type Line = { msg: string; data?: Record<string, unknown> };
function captureLog(): { lines: Line[]; [Symbol.dispose](): void } {
  const lines: Line[] = [];
  setLogger(
    {
      pub: (_lvl: string, _cat: string, msg: string, data?: unknown) =>
        lines.push({ msg, data: data as Record<string, unknown> }),
    } as unknown as LogSink,
  );
  return { lines, [Symbol.dispose]: () => setLogger(null) };
}
const nullProto = (code: string) =>
  Object.assign(Object.create(null), { code });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("onError hook throwing a plain object: its JSON, not [object Object]", async () => {
  using log = captureLog();
  const err = createAioError("REDUCE_ERROR", "boom", { actionType: "c:x" });
  reportError(err, {
    onError: () => {
      throw { code: "E_SYNC" };
    },
  });
  // A null-prototype throw must not make reportError throw in its place.
  reportError(err, {
    onError: () => {
      throw nullProto("E_NULL");
    },
  });
  reportError(err, {
    onError: (async () => {
      await 0;
      throw { code: "E_ASYNC" };
    }) as unknown as () => void,
  });
  await tick();
  await tick();
  const details = log.lines.filter((l) => l.msg.includes("onError hook threw"))
    .map((l) => String(l.data?.detail));
  assertEquals(details.length, 3, JSON.stringify(details));
  for (const code of ["E_SYNC", "E_NULL", "E_ASYNC"]) {
    assert(details.some((d) => d.includes(code)), `${code}: ${details}`);
  }
  assert(!details.some((d) => d.includes("[object Object]")));
});

Deno.test("reduce-error diagnostic names a thrown object by its JSON", () => {
  const seen: DiagnosticEvent[] = [];
  const off = diagSubscribe((e) => void seen.push(e), { prodErrors: true });
  try {
    let state = { n: 0 };
    const dispatch = createDispatch<typeof state, { type: string }, never>({
      reduce: () => {
        throw { code: "E_REDUCE" };
      },
      execute: () => {},
      getState: () => state,
      setState: (s) => {
        state = s;
      },
      onDone: () => {},
      log: { debug: () => {}, warn: () => {}, error: () => {} },
      debug: false,
      reportOpts: { logger: { error: () => {} } },
    });
    try {
      dispatch({ type: "c:bad" });
    } catch { /* the reject path is not under test */ }
  } finally {
    off();
  }
  const ev = seen.find((e) => e.type === "reduce-error");
  assert(ev, JSON.stringify(seen.map((e) => e.type)));
  assertStringIncludes(ev.message, `{"code":"E_REDUCE"}`);
});

Deno.test("onStart hook throwing a null-prototype object is reported, boot unharmed", async () => {
  using log = captureLog();
  const c = cell("thrown_start", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({
    cells: [c],
    onStart: () => {
      throw nullProto("E_START");
    },
  });
  const health = await srv.fetch("/__aio/health");
  await health.body?.cancel();
  assertEquals(health.status, 200);
  const line = log.lines.find((l) =>
    /onStart hook error:|hook onStart:/.test(l.msg)
  );
  assert(line, JSON.stringify(log.lines.map((l) => l.msg).slice(-20)));
  assertStringIncludes(line.msg, "E_START");
});

Deno.test("thrownText: an Error keeps its name; anything else is described", () => {
  assertEquals(
    thrownText(new TypeError("x is undefined")),
    "TypeError: x is undefined",
  );
  assertEquals(thrownText({ code: "E" }), `{"code":"E"}`);
  assertEquals(thrownText(nullProto("E")), `{"code":"E"}`);
  assertEquals(thrownText("plain"), "plain");
  const hostile = new Error("m");
  Object.defineProperty(hostile, "name", {
    get() {
      throw new Error("no");
    },
  });
  assertEquals(thrownText(hostile), "m");
});
