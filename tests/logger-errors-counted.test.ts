// `errors=N` on the stopped line must mean "this many errors happened".
//
// It counted ONLY async method failures (`:__error` actions), so every other
// `log.error(...)` in the framework was printed and then denied by the summary
// a person reads FIRST:
//
//   ERROR  shutdown: the database file is GONE (…) — it was deleted while the
//          app was running, so writes since then committed into an unlinked
//          file and NONE of them are on disk.
//   …
//   app stopped  uptime=… dispatched=… errors=0
//
// That line is the one that must be believed the day it is real, and the
// summary underneath called it nothing. A summary that disagrees with the log
// above it teaches the reader to trust neither.
//
// Counted in `emit`, in exactly ONE place, because the `:__error` path also
// emits and counting in both made one async failure worth two. That is the
// risk this change introduces, so it is the last test here.
//
// The increment sits above the level gate, which today changes nothing —
// `error` is the highest level, so no setting can gate an error line — and is
// there so that stays true if a louder level is ever added. Deliberately NOT
// asserted: at `level: "error"` the stopped line is itself an info line and is
// never written, so there is no surface on which the placement is observable,
// and a test that cannot see a difference is not evidence of one.
import { assert, assertEquals } from "@std/assert";
import { AioLogger } from "../src/diagnostics/logger.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

/** The `errors=` the stopped line reports — what a person actually reads. */
async function errorsOnStop(l: AioLogger, dir: string): Promise<number> {
  l.onStop();
  await l.flush();
  const app = await Deno.readTextFile(`${dir}/app.log`).catch(() => "");
  // app.log is the human text a person reads, so the assertion is about the
  // literal `errors=N` on the stopped line — not about an internal counter.
  const line = app.split("\n").filter((x) => /\bstopped\b/.test(x)).pop();
  assert(line, `no stopped line in app.log:\n${app.slice(-400)}`);
  const m = /\berrors=(\d+)/.exec(line);
  assert(m, `the stopped line carries no errors= count: ${line}`);
  return Number(m[1]);
}

Deno.test("logger: an error-level line is counted on the stopped line", async () => {
  const dir = await tempDir("logger-errors-");
  const l = new AioLogger({ dir, level: "info", console: false, heartbeat: 0 });
  await l.init();

  l.pub("error", "shutdown", "the database file is GONE (/x/state.db)");
  l.pub("warn", "shutdown", "something survivable");
  l.pub("info", "app", "ordinary");
  l.pub("error", "db", "another one");

  assertEquals(
    await errorsOnStop(l, dir),
    2,
    "the stopped line denied errors that were printed right above it",
  );
});

Deno.test("logger: a run with nothing wrong still says zero", async () => {
  const dir = await tempDir("logger-errors-clean-");
  const l = new AioLogger({ dir, level: "info", console: false, heartbeat: 0 });
  await l.init();
  l.pub("info", "app", "all fine");
  l.pub("warn", "app", "survivable");
  assertEquals(await errorsOnStop(l, dir), 0);
});

Deno.test("logger: an async method failure is worth exactly ONE", async () => {
  // The risk this fix introduces, pinned. `observeAction`'s `:__error` branch
  // emits at error level, so leaving its own increment in place would make a
  // single failed method report two errors — a summary wrong in the other
  // direction, which is no better.
  const dir = await tempDir("logger-errors-observe-");
  const l = new AioLogger({ dir, level: "info", console: false, heartbeat: 0 });
  await l.init();
  l.observe(
    { type: "cart:__error", payload: { _method: "checkout", error: "boom" } },
    {},
  );
  assertEquals(
    await errorsOnStop(l, dir),
    1,
    "one failed method must be one error — `emit` counts it, so the " +
      "observer must not count it again",
  );
});
