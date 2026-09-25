// A `worker: true` cell whose `onInit` is async, throws, or rejects must boot
// — and fail — exactly as the same cell does on the main isolate.
//
// Two defects, found reviewing the round that moved a worker's `onInit` to
// the `start` message:
//
//   - An `async onInit` that REJECTED was never observed (`initAll` ignored
//     the promise). On the main isolate that was an unhandled rejection — a
//     crash-handler line, no INIT_ERROR, `onError` never called. Inside a
//     worker it killed the thread: the cell was unreachable for the life of
//     the process, while every harness kept serving it.
//   - The worker's composition reported cell errors to nobody. INIT_ERROR from
//     a throwing `onInit`, EFFECT_ASYNC_ERROR from a failing method: a bare
//     log line in the worker, and the app's `onError` never heard of either.
//
// Differential: the in-isolate harness and a real worker, same app, same
// questions; every answer must agree.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { wiAsync, wiReject, wiThrow } from "./fixtures/worker-oninit-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-oninit-app.ts");

type C = { set: (n: number) => Promise<unknown>; boom: () => Promise<unknown> };
const outcome = (p: Promise<unknown>) =>
  p.then(() => "ok", (e: Error) => `ERR ${e.message}`);

async function answers(real: boolean): Promise<Record<string, unknown>> {
  const errs: string[] = [];
  await using srv = await testServer({
    cells: [wiAsync, wiThrow, wiReject],
    onError: (e) => void errs.push(`${e.code}: ${e.message}`),
    ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
  });
  const boots = () =>
    (srv.state() as Record<string, { boots: number }>).wiAsync?.boots;
  // The async onInit awaits, then dispatches: wait for its write to land.
  for (let i = 0; i < 100 && boots() !== 1; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const calls: Record<string, string> = {};
  for (const [n, c] of Object.entries({ wiAsync, wiThrow, wiReject })) {
    calls[n] = await outcome((c as unknown as C).set(3));
  }
  calls.boom = await outcome((wiAsync as unknown as C).boom());
  // An error report crosses the thread after the call's reply.
  for (let i = 0; i < 50 && errs.length < 3; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { boots: boots(), calls, errs: errs.sort() };
}

let realAnswers: Record<string, unknown> | undefined;

Deno.test("worker onInit: a REAL worker survives a rejecting onInit and reports every cell error", async () => {
  realAnswers = await answers(true);
  const a = realAnswers as {
    boots: number;
    calls: Record<string, string>;
    errs: string[];
  };
  assertEquals(a.boots, 1, "the async onInit's dispatch must land");
  assertEquals(a.calls.wiReject, "ok", JSON.stringify(a));
  assertEquals(a.errs, [
    "EFFECT_ASYNC_ERROR: boom in a method",
    "INIT_ERROR: wiReject onInit rejected",
    "INIT_ERROR: wiThrow onInit exploded",
  ]);
});

Deno.test("worker onInit: the in-isolate cell answers the same", async () => {
  assert(realAnswers, "runs after the real-worker case");
  assertEquals(await answers(false), realAnswers);
});

// The pool cannot spawn a worker from an entry that is not a local module (an
// app run from an `https:` URL): it warns and runs the cells on the main
// isolate. The cells bridge decided "a worker owns this cell" on its own, from
// `libraryMode`/`_workerEntry` alone — so it skipped the cell's `onInit` on
// main, and no worker existed to run it. `onInit` ran nowhere, silently.
Deno.test("worker onInit: an entry no worker can spawn from still runs onInit (on main)", async () => {
  const { reseedProbe } = await import("./fixtures/worker-reseed-app.ts");
  await using srv = await testServer(
    {
      cells: [reseedProbe],
      // What `aio.run` resolves for an app started from a URL — the harness
      // key, because `deno test` itself always runs from a local file.
      _workerEntry: "https://example.invalid/app.ts",
    } as Parameters<typeof testServer>[0],
  );
  const boots = () =>
    (srv.state() as { reseedProbe: { boots: number } }).reseedProbe.boots;
  for (let i = 0; i < 50 && boots() === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assertEquals(boots(), 1, "onInit ran nowhere");
});
