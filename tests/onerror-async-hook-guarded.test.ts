// An ASYNC `onError` hook that rejects must be guarded like a sync one.
// `onError: async (err) => { await sentry.send(err) }` type-checks against the
// `void` return, and its rejection escaped reportError's try/catch — an
// unhandled rejection, which ends a Deno process. Lifecycle hooks are
// observe-only and error-guarded; the error hook is the last one that may
// take the app down.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createAioError, reportError } from "../src/diagnostics/error.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

function captureLog(): {
  lines: { lvl: string; msg: string; data?: Record<string, unknown> }[];
  [Symbol.dispose](): void;
} {
  const lines: { lvl: string; msg: string; data?: Record<string, unknown> }[] =
    [];
  setLogger(
    {
      pub: (lvl: string, _cat: string, msg: string, data?: unknown) =>
        lines.push({ lvl, msg, data: data as Record<string, unknown> }),
    } as unknown as LogSink,
  );
  return { lines, [Symbol.dispose]: () => setLogger(null) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("onError: an async hook that rejects is reported, not an unhandled rejection", async () => {
  using log = captureLog();
  let calls = 0;
  const err = createAioError("REDUCE_ERROR", "boom", { actionType: "c:x" });
  reportError(err, {
    onError: (async () => {
      calls++;
      await Promise.resolve();
      throw new Error("sentry is down");
    }) as unknown as (e: typeof err) => void,
  });
  await tick();
  await tick();
  assertEquals(calls, 1, "the hook runs once — its failure never re-enters it");
  const hook = log.lines.filter((l) => l.msg.includes("onError hook threw"));
  assertEquals(hook.length, 1, JSON.stringify(log.lines.map((l) => l.msg)));
  assertEquals(hook[0]!.lvl, "error", "same level as a sync throw");
  assertStringIncludes(String(hook[0]!.data?.detail), "sentry is down");
});

Deno.test("onError: a thenable whose then() throws is guarded too", async () => {
  using log = captureLog();
  const err = createAioError("REDUCE_ERROR", "boom", { actionType: "c:x" });
  reportError(err, {
    onError: (() => ({
      then() {
        throw new Error("bad thenable");
      },
    })) as unknown as (e: typeof err) => void,
  });
  await tick();
  await tick();
  const hook = log.lines.filter((l) => l.msg.includes("onError hook threw"));
  assertEquals(hook.length, 1);
  assertStringIncludes(String(hook[0]!.data?.detail), "bad thenable");
});

Deno.test("onError: a resolving async hook logs nothing", async () => {
  using log = captureLog();
  let seen = "";
  const err = createAioError("REDUCE_ERROR", "boom", { actionType: "c:x" });
  reportError(err, {
    onError: (async (e: typeof err) => {
      await Promise.resolve();
      seen = e.code;
    }) as unknown as (e: typeof err) => void,
  });
  await tick();
  assertEquals(seen, "REDUCE_ERROR");
  assertEquals(
    log.lines.filter((l) => l.msg.includes("onError hook")).length,
    0,
  );
});
