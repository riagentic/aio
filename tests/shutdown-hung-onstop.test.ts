// A hung `onStop` gets a SHARE of the teardown budget, not all of it.
//
// It used to be handed whatever was left of TEARDOWN_TIMEOUT_MS: a hook that
// never resolved spent all of it, and the phases after it — the server, the
// SQLite writer, the session/user stores — each got the 1ms floor, so every
// one of them "did not finish" (the WAL kept the data, the handles leaked).
// And because the bridge writes the app's "stopped" line AFTER awaiting the
// hook, that line was never written: the one stop with something to report
// was the one that said nothing.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { SHUTDOWN_BUDGET_MS } from "../src/server/shutdown-budget.ts";

Deno.test("shutdown: a hung onStop still leaves the closes and the stopped line their time", async () => {
  const dir = await tempDir("aio-hung-onstop-");
  try {
    const c = cell("hungstop", { state: { n: 0 }, methods: {} });
    const app = await aio.run({
      cells: [c],
      appId: "hung-onstop-app",
      client: "server-only",
      libraryMode: true,
      appDir: dir,
      port: freePort(),
      onStop: () => new Promise<void>(() => {}),
      // deno-lint-ignore no-explicit-any
    } as any);
    const t0 = Date.now();
    await app.close();
    const took = Date.now() - t0;
    assert(took < SHUTDOWN_BUDGET_MS, `the stop took ${took}ms`);
    const text = await Deno.readTextFile(join(dir, "logs", "app.log"));
    assertStringIncludes(text, "onStop", "the hung hook is named");
    assert(
      /\bstopped\b/.test(
        text.split("\n").filter((l) => /\bapp\b/.test(l)).join("\n"),
      ),
      `no "stopped" line after a hung onStop:\n${text.slice(-1500)}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("shutdown: a slow onStop that finishes inside 4 s is awaited to the end, never cut", async () => {
  // Compat: before the hook got a capped share, a 4 s flush ran to completion
  // inside the teardown. The reserve for the closes after it must not take
  // that back (a measured real hook took 4.5 s).
  const dir = await tempDir("aio-slow-onstop-");
  try {
    let finished = false;
    const c = cell("slowstop", { state: { n: 0 }, methods: {} });
    const app = await aio.run({
      cells: [c],
      appId: "slow-onstop-app",
      client: "server-only",
      libraryMode: true,
      appDir: dir,
      port: freePort(),
      onStop: () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            finished = true;
            r();
          }, 4_000)
        ),
      // deno-lint-ignore no-explicit-any
    } as any);
    await app.close();
    assert(finished, "close() returned before a 4 s onStop finished");
  } finally {
    await dropTempDir(dir);
  }
});
