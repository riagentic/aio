// The dev server stops a prod-bundle evaluation still running when it closes:
// the worker and the 10 s timeout must not outlive it (the suite's sanitizers
// caught the timer leaking out of a server test on a loaded machine).
import { assert, assertEquals } from "@std/assert";
import { evaluateBundle } from "../src/build/graph-eval.ts";

const HANGS = "await new Promise(() => {});";

Deno.test("evaluateBundle: an abort stops a hung evaluation at once, leaving no timer or worker", async () => {
  const stop = new AbortController();
  const t0 = performance.now();
  const run = evaluateBundle(HANGS, "esm", 10_000, { signal: stop.signal });
  setTimeout(() => stop.abort(), 50);
  const r = await run;
  assertEquals(r.ok, false);
  assert(!r.ok && r.name === "aborted", JSON.stringify(r));
  assert(performance.now() - t0 < 5_000, "the abort did not stop it");
});

Deno.test("evaluateBundle: an already-aborted signal never starts the timer", async () => {
  const stop = new AbortController();
  stop.abort();
  const r = await evaluateBundle(HANGS, "esm", 10_000, { signal: stop.signal });
  assert(!r.ok && r.name === "aborted", JSON.stringify(r));
});

Deno.test("evaluateBundle: a finished evaluation still says ok with a signal", async () => {
  const stop = new AbortController();
  const r = await evaluateBundle("globalThis.x = 1;", "esm", 10_000, {
    signal: stop.signal,
  });
  assertEquals(r.ok, true);
});
