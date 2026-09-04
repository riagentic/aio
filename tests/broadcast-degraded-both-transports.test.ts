// A client that has silently stopped receiving state must reach /__aio/health.
//
// Both broadcasters answer `undefined` when the state cannot be serialized,
// and both callers respond with `continue` — that client receives nothing
// more, permanently. The WS path says so in its own comment and escalates
// through `degraded()`; the UDS path — the DESKTOP default, where every client
// of a local app lives — only wrote a log line, so the app kept answering
// "healthy" while its window sat frozen.
//
// And neither called `ok()`. `degraded()` escalates on N CONSECUTIVE failures
// and reports recovery from `ok()`, so with only `fail()` wired: five failures
// spread across a whole process lifetime counted as consecutive, and once
// escalated the app reported itself degraded forever — a false alarm that
// outlives its cause is how a real one stops being believed.
import { assert, assertEquals } from "@std/assert";
import {
  _resetDegraded,
  degraded,
  degradedReport,
} from "../src/diagnostics/degraded.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("uds: state that cannot serialize reaches /__aio/health", async () => {
  _resetDegraded();
  const dir = await tempDir("uds-degraded-");
  const socketPath = join(dir, "d.sock");
  // A BigInt is what a real app produces; `JSON.stringify` throws on it.
  let poisoned = false;
  const uds = createUDSListener(
    socketPath,
    () => poisoned ? { cell: { n: 1n as unknown } } : { cell: { n: 1 } },
    () => {},
    () => {},
  );
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const reader = conn.readable.getReader();
  (async () => {
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch { /* aio-ok: closed at teardown */ }
  })();
  try {
    await wait(80);
    assertEquals(
      degradedReport().filter((d) => d.name.startsWith("uds:")).length,
      0,
      "a healthy app reports nothing",
    );

    poisoned = true;
    // `degraded()` escalates on N consecutive failures, not the first.
    for (let i = 0; i < 8; i++) {
      uds.broadcastState(true);
      await wait(5);
    }
    const dead = degradedReport().find((d) => d.name === "uds:broadcast-state");
    assert(
      dead,
      "this client has silently stopped receiving state — the app must not " +
        `still answer "healthy". Reported: ${JSON.stringify(degradedReport())}`,
    );

    // …and it RECOVERS when the value is fixed. A stuck "degraded" is the
    // same defect wearing the other mask.
    poisoned = false;
    uds.broadcastState(true);
    await wait(20);
    assertEquals(
      degradedReport().find((d) => d.name === "uds:broadcast-state"),
      undefined,
      "the episode must end when serialization works again",
    );
  } finally {
    try {
      await reader.cancel();
    } catch { /* aio-ok: already closed */ }
    try {
      conn.close();
    } catch { /* aio-ok: already closed */ }
    uds.shutdown();
    await dropTempDir(dir);
    _resetDegraded();
  }
});

// The property both broadcasters were missing, stated directly so the rule is
// pinned even if either call site is refactored away: `fail()` alone counts
// EVERY failure as consecutive and never ends the episode.
Deno.test("degraded: without ok(), scattered failures escalate and never recover", () => {
  _resetDegraded();
  try {
    const d = degraded("test:scattered", { after: 3 });
    // Three failures separated by successes that were never REPORTED. This is
    // what a call site with only `fail()` wired looks like from here.
    d.fail(new Error("1"));
    d.fail(new Error("2"));
    d.fail(new Error("3"));
    assertEquals(d.isDegraded, true, "three consecutive failures escalate");

    // A success that IS reported ends it — and that is the call both
    // broadcasters were missing.
    d.ok();
    assertEquals(d.isDegraded, false);
    assertEquals(
      degradedReport().find((r) => r.name === "test:scattered"),
      undefined,
      "a recovered tracker leaves the health report",
    );
    assertEquals(
      d.failures,
      0,
      "the counter resets, so the next run of " +
        "failures is judged on its own",
    );
  } finally {
    _resetDegraded();
  }
});
