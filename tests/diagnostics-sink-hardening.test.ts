// The diagnostics sinks, audited as ATTACK SURFACE rather than as niceties.
//
// Every finding below was measured on the real path, and every one of them is
// the same shape: a subsystem whose job is to report failure, failing quietly
// itself.
//
//   1. `client.log` — forwarded browser console output plus every diagnostic —
//      was created 0644 in a 0755 directory: the ONE log writer in the repo
//      that omitted `mode: 0o600` + the chmod fallback that `logger-core.ts`
//      documents and `action-log.ts` obeys. Rotation re-created it 0644 on
//      every boot, so the leak healed itself back open.
//   2. One throwing subscriber took out the whole diagnostic bus: the throw
//      escaped to `diagEmit`'s caller (usually framework error handling) AND
//      every LATER subscriber was skipped — the structured logger, feedback
//      auto-capture and the WS relay are all subscribers, so a single failing
//      writer silenced the others.
//   3. `payloadStats` was written unconditionally while its cleanup was gated
//      on `deps.vitalsSystem` — with vitals off, one map entry per connection,
//      forever, plus a full re-encode of every payload for a diagnostic
//      nobody was reading.
//   4. `degraded()` is public API, so `degraded(`fetch:${url}`)` is the
//      natural use — and its registry was the only one that never evicted.
//   5. `logBudget` bounded the disk only at the NEXT boot, and no line-length
//      cap existed anywhere: one run logging large errors filled the disk.
//   8. A prod-ignored `timeTravel` override was accepted in silence.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  disposeClientLog,
  initClientLog,
  writeClientLog,
} from "../src/server/client-log.ts";
import {
  diagEmit,
  diagSubscribe,
  initDiagnosticBus,
} from "../src/diagnostics/diagnostic-bus.ts";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import {
  _degradedRegistrySize,
  _resetDegraded,
  degraded,
  degradedReport,
} from "../src/diagnostics/degraded.ts";
import { AioLogger } from "../src/diagnostics/logger-core.ts";
import { resolveOptions } from "../src/diagnostics/types.ts";
import { installCrashHandler } from "../src/diagnostics/crash-handler.ts";

const SRC = join(dirname(fromFileUrl(import.meta.url)), "..", "src");
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const modeOf = async (p: string) => ((await Deno.stat(p)).mode ?? 0) & 0o777;

// ── 1. the client log was world-readable ─────────────────────────────

Deno.test("client log: the file is owner-only, like every other log sink", async () => {
  if (Deno.build.os === "windows") return; // no POSIX mode
  const dir = await Deno.makeTempDir({ prefix: "aio-clientlog-mode-" });
  await Deno.chmod(dir, 0o755); // the realistic case: a loose parent
  try {
    initClientLog(dir);
    writeClientLog(
      0,
      {
        ts: Date.now(),
        level: "info",
        msg: "session token=SECRET from the renderer",
      } as Parameters<typeof writeClientLog>[1],
    );
    await settle();
    assertEquals(
      await modeOf(join(dir, "client.log")),
      0o600,
      "client.log holds forwarded browser output and every diagnostic — " +
        "any local account could read it",
    );
  } finally {
    disposeClientLog();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("client log: a file left loose by an older build is tightened", async () => {
  if (Deno.build.os === "windows") return;
  const dir = await Deno.makeTempDir({ prefix: "aio-clientlog-fix-" });
  try {
    const path = join(dir, "client.log");
    // What every app upgrading from a build without the mode has on disk.
    await Deno.writeTextFile(path, "old line\n");
    await Deno.chmod(path, 0o644);
    initClientLog(dir);
    writeClientLog(
      1,
      {
        ts: Date.now(),
        level: "warn",
        msg: "after the upgrade",
      } as Parameters<typeof writeClientLog>[1],
    );
    await settle();
    assertEquals(
      await modeOf(path),
      0o600,
      "`mode` applies only on CREATE — a pre-existing log stays world-" +
        "readable forever without the chmod half",
    );
  } finally {
    disposeClientLog();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("logs: the log directory itself is owner-only", async () => {
  if (Deno.build.os === "windows") return;
  const base = await Deno.makeTempDir({ prefix: "aio-logdir-mode-" });
  try {
    const dir = join(base, "log");
    const logger = new AioLogger({ dir, level: "info", console: false });
    await logger.init();
    assertEquals(
      await modeOf(dir),
      0o700,
      "0600 files inside a 0755 directory still leak their names and sizes; " +
        "the recovery path already used mode 0o700 — init did not",
    );
    await logger.flush();
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
});

// ── 2. one throwing subscriber broke the whole bus ───────────────────

Deno.test("diagnostic bus: a throwing subscriber cannot break diagEmit or hide later subscribers", () => {
  initDiagnosticBus(true);
  const reached: string[] = [];
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  const offs = [
    diagSubscribe(() => {
      reached.push("first");
    }),
    diagSubscribe(() => {
      throw new Error("subscriber exploded");
    }),
    diagSubscribe(() => {
      reached.push("third");
    }),
  ];
  try {
    // The caller is usually framework error-handling code: a throw here turns
    // "something failed" into "something failed AND the reporter crashed".
    diagEmit({
      type: "audit:throwing-subscriber",
      severity: "error",
      source: "audit",
      message: "one subscriber throws",
    });
    assertEquals(
      reached,
      ["first", "third"],
      "a throwing subscriber must not skip the ones registered after it — " +
        "the structured logger, feedback capture and the WS relay are all " +
        "subscribers",
    );
    assert(
      errs.some((e) => e.includes("subscriber exploded")),
      `the failure must be reported, never swallowed: ${JSON.stringify(errs)}`,
    );
    // Reported once per subscriber, not once per event: a permanently broken
    // subscriber must not become the noise.
    const before = errs.length;
    diagEmit({
      type: "audit:throwing-subscriber-2",
      severity: "error",
      source: "audit",
      message: "again",
    });
    assertEquals(
      errs.length,
      before,
      "the same broken subscriber reported twice — that is a log flood",
    );
  } finally {
    console.error = origErr;
    for (const off of offs) off();
  }
});

// ── 3. a per-connection map that leaked in prod ──────────────────────

function fakeClient(id: string) {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send(msg: string) {
      sent.push(msg);
    },
  } as unknown as WebSocket;
  const meta = {
    id,
    index: 0,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
  } as unknown as ClientMeta;
  return { ws, meta, sent };
}

Deno.test("broadcast: with vitals off, nothing is accumulated per connection", async () => {
  // `diagnostics: false` and `prod: { vitals: false }` are both supported, and
  // `meta.id` is per CONNECTION — every browser reload added an entry that
  // cleanup (gated on the vitals system) never removed.
  const state = { c: { v: 0 } };
  const connections = new Map<WebSocket, ClientMeta>();
  const payloadStats = new Map<
    string,
    { lastPayloadBytes: number; totalBytes: number; count: number }
  >();
  const b = createBroadcaster({
    connections,
    payloadStats,
    getUIState: () => state,
    debug: () => {},
    syncIntervalMs: 5,
    // vitalsSystem deliberately absent — this IS prod with vitals off.
  });
  try {
    for (let i = 0; i < 50; i++) {
      const { ws, meta } = fakeClient(`reload-${i}`);
      connections.set(ws, meta);
      state.c.v = i;
      b.broadcast();
      await settle(15);
      connections.delete(ws); // the client goes away; nothing cleans up for it
    }
    assertEquals(
      payloadStats.size,
      0,
      "a diagnostic nobody reads must not cost a map entry per connection " +
        "for the life of the process",
    );
  } finally {
    b.shutdown();
  }
});

Deno.test("ws: the per-connection payload stats are deleted unconditionally", async () => {
  // The write is gated on the vitals system; the DELETE must not be, or a
  // build that ever wrote an entry keeps it forever.
  const src = await Deno.readTextFile(join(SRC, "server", "server-ws.ts"));
  const fn = src.slice(src.indexOf("function _cleanupVitals"));
  const body = fn.slice(0, fn.indexOf("\n  }\n") + 4);
  const del = body.indexOf("payloadStats.delete");
  const gate = body.indexOf("if (deps.vitalsSystem)");
  assert(del > 0, "server-ws no longer deletes the payload stats entry");
  assert(gate > 0, "the vitals gate moved — re-check this guard");
  assert(
    del < gate,
    "payloadStats.delete sits inside `if (deps.vitalsSystem)` — with vitals " +
      "off the entry written by an older/other path is never removed",
  );
});

// ── 4. the one registry that never evicted ───────────────────────────

Deno.test("degraded: the registry is bounded, and says so once", () => {
  _resetDegraded();
  const errs: string[] = [];
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    // The natural per-resource use — and the reason this must be bounded.
    for (let i = 0; i < 5_000; i++) degraded(`fetch:https://x.dev/item/${i}`);
    const size = _degradedRegistrySize();
    assert(
      size <= 512,
      `the degraded registry grew to ${size} entries — unbounded, in the ` +
        `module whose job is to notice something failing forever`,
    );
    assert(
      errs.some((e) => e.includes("degraded(")),
      "an evicting cap must say so — a silent cap is the same defect one " +
        "level down",
    );
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    _resetDegraded();
  }
});

Deno.test("degraded: an escalated operation survives eviction pressure", () => {
  _resetDegraded();
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const live = degraded("nft-cache", { after: 1 });
    live.fail(new Error("wedged"));
    for (let i = 0; i < 2_000; i++) degraded(`fetch:${i}`);
    assert(
      degradedReport().some((r) => r.name === "nft-cache"),
      "eviction dropped the one entry that was live signal",
    );
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    _resetDegraded();
  }
});

Deno.test("degraded: name and lastError are capped, like the client-side twin", () => {
  _resetDegraded();
  const origErr = console.error;
  console.error = () => {};
  try {
    const d = degraded("x".repeat(500), { after: 1 });
    d.fail(new Error("e".repeat(5_000)));
    const row = degradedReport()[0]!;
    assert(row.name.length <= 64, `name kept at ${row.name.length} chars`);
    assert(
      row.lastError.length <= 200,
      `lastError kept at ${row.lastError.length} chars`,
    );
  } finally {
    console.error = origErr;
    _resetDegraded();
  }
});

// ── 5. logBudget only bounded the disk at the NEXT boot ──────────────

Deno.test("logger: a single line cannot be unbounded", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-logline-" });
  try {
    const logger = new AioLogger({ dir, level: "info", console: false });
    await logger.init();
    logger.pub("error", "test", "boom " + "M".repeat(200_000));
    await logger.flush();
    const text = await Deno.readTextFile(logger.path("app"));
    const longest = Math.max(...text.split("\n").map((l) => l.length));
    assert(
      longest < 32_000,
      `a single log line reached ${longest} chars — MAX_BUFFERED caps the ` +
        `line COUNT, so nothing bounded the bytes`,
    );
    assertStringIncludes(text, "truncated");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("logger: logBudget is enforced DURING the run, not only at the next boot", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-logbudget-" });
  try {
    const budget = 128 * 1024;
    const logger = new AioLogger({
      dir,
      level: "info",
      console: false,
      logBudget: budget,
      backupLogs: true,
      backupKeep: 2,
    });
    await logger.init();
    // ~1.5 MB of lines: an app logging large errors in one long run.
    for (let i = 0; i < 1_500; i++) {
      logger.pub("info", "test", `line ${i} ${"z".repeat(900)}`);
      if (i % 100 === 0) await logger.flush();
    }
    await logger.flush();
    await settle(300);
    let total = 0;
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile) continue;
      total += (await Deno.stat(join(dir, e.name))).size;
    }
    assert(
      total <= budget * 4,
      `the log directory reached ${Math.round(total / 1024)}KB against a ` +
        `${budget / 1024}KB budget — nothing rotated mid-run`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── 8. a prod override that was accepted and ignored ─────────────────

Deno.test("diagnostics: a prod override that cannot take effect is refused out loud", () => {
  const warns: string[] = [];
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  try {
    resolveOptions({ prod: { timeTravel: true } }, true);
    assert(
      warns.some((w) => w.includes("timeTravel")),
      "`diagnostics: { prod: { timeTravel: true } }` is accepted, merged and " +
        "silently ignored — a setting that visibly does nothing",
    );
    // The same key in dev is honoured, and must stay quiet.
    warns.length = 0;
    resolveOptions({ dev: { timeTravel: true } }, false);
    assertEquals(warns, [], "a dev override is honoured — no warning");
  } finally {
    console.warn = origWarn;
    console.error = origErr;
  }
});

Deno.test("crash handler: a logger that throws during a crash still leaves last words", () => {
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    // Synchronous, no listeners: call the installed handler through the real
    // event path would need a global throw — the contract under test is that
    // `log.error` failing does not erase the crash.
    const uninstall = installCrashHandlerWithBrokenLogger();
    uninstall();
    assert(
      errs.some((e) => e.includes("THE-CRASH")),
      `the crash itself was lost when the logger threw: ${
        JSON.stringify(errs)
      }`,
    );
    assert(
      errs.some((e) => e.includes("logger-is-broken")),
      "the logger's own failure must be reported too",
    );
  } finally {
    console.error = origErr;
  }
});

function installCrashHandlerWithBrokenLogger(): () => void {
  const uninstall = installCrashHandler({
    log: {
      error() {
        throw new Error("logger-is-broken");
      },
    },
    getHealthData: () => ({ cells: {} }),
    writeEmergencyCheckpoint: () => {},
  });
  globalThis.dispatchEvent(
    new ErrorEvent("error", { error: new Error("THE-CRASH") }),
  );
  return uninstall;
}
