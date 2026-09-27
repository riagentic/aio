// A `schedule.blocking()` task whose worker CRASHES (an uncaught throw on the
// worker's own loop — a timer callback, a stray rejection in FFI glue) must be
// reported to THAT caller as a rejection — "blocking worker crashed: …", which
// is exactly what `createBlockingPool`'s `onerror` builds — and must not also
// escape to the main isolate as an uncaught error.
//
// `onerror` (src/state/blocking.ts) calls `e.preventDefault()` ONLY for the
// "module not found" hint. For every other crash the event is left
// un-prevented, and Deno re-raises an un-prevented worker error in the parent:
// the owner process dies with `Uncaught (in worker "") Error: …` even though
// the pool already rejected the task and retired the worker. The worker-cell
// bridge (cell-worker.ts `worker.onerror`) prevents unconditionally for this
// reason: "Loud, never silent: the cell is now unreachable and every waiting
// caller has to learn that" — learn it, not be killed by it.
//
// The crash is run in a CHILD process, so the parent test observes the child's
// fate: it must print the task's rejection and exit 0.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";

const BLOCKING = new URL("../src/state/blocking.ts", import.meta.url).href;

Deno.test("schedule.blocking: a crashing worker rejects its task and does not kill the owner", async () => {
  const dir = await tempDir("zz-r6-blk-");
  const script = join(dir, "crash.ts");
  await Deno.writeTextFile(
    script,
    `import { createBlockingPool } from ${JSON.stringify(BLOCKING)};
const pool = createBlockingPool({ size: 1 });
let outcome = "pending";
try {
  await pool.run("crashy", () =>
    new Promise(() => {
      setTimeout(() => { throw new Error("worker loop died"); }, 0);
    }));
  outcome = "resolved";
} catch (e) {
  outcome = "rejected: " + (e instanceof Error ? e.message : String(e));
}
console.log("OUTCOME " + outcome);
// Give an escaped worker error time to reach this isolate.
await new Promise((r) => setTimeout(r, 300));
await pool.dispose();
console.log("SURVIVED");
`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-check", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  assertStringIncludes(
    stdout,
    "OUTCOME rejected: blocking worker crashed",
    `the task must be rejected by the pool\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  assert(
    stdout.includes("SURVIVED"),
    `the owner process died from a worker crash the pool had already ` +
      `reported:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  assertEquals(out.code, 0, `exit code ${out.code}\nstderr:\n${stderr}`);
});
