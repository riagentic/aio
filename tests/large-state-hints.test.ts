// Every state-size message gives a FIX and names the CHAPTER.
//
// The size lines used to say "bulk rows belong in db: tables" and stop. Right
// for the app that put 83,000 rows in a cell by accident; a wall for the app
// whose working set is that big on purpose — the one knob that quiets the
// line (`budgets.cellState`) was named nowhere, and persist did not even
// honour it (the broadcast seam did). Pinned here, one test per message:
//
//   - the text says what crossed what, with the measured size,
//   - it ends with a one-line `Fix:` / hint (both doors: the tier AND the
//     declaration sized to what was measured),
//   - it names LARGE_STATE_DOC, and that page + anchor exist,
//   - persist honours a declared `cellState` (warn line moved, hard line
//     lifted, breach recorded),
//   - the WS connect frame — the one every client gets first — is guarded,
//   - the text is the same in dev and prod.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  cellSizeFix,
  createBudgetLedger,
  declareCellState,
  declareLargeState,
  LARGE_STATE_DOC,
  resolveBudgets,
  suggestCellStateBudget,
} from "../src/state/budgets.ts";
import {
  createPersistenceManager,
  PERSIST_CELL_HARD_BYTES,
  PERSIST_CELL_WARN_BYTES,
} from "../src/server/persistence.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import type { SkvInstance } from "../src/server/skv.ts";
import { createDB } from "../src/server-entry.ts";
import type { DB } from "../src/db/types.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { warnBigFullState } from "../src/server/server-broadcast.ts";
import { peerCeilingMessage } from "../src/server/server-ws.ts";
import { frameTooLargeMessage } from "../src/server/cli-client.ts";
import { createPressureMonitor } from "../src/vitals/pressure-monitor.ts";
import { noteFreezeSkipped } from "../src/state/immutable.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { headingSlugs } from "../scripts/check-docs.ts";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("../", import.meta.url).pathname;
const MB = 1024 * 1024;

/** The two halves every size message must carry. */
function assertHint(msg: string, what: string): void {
  assertStringIncludes(msg, "db: tables", `${what}: names the tier`);
  assertStringIncludes(msg, LARGE_STATE_DOC, `${what}: names the chapter`);
}

/** Capture the framework logger (`pub(level, category, message)`). */
async function logsDuring(
  fn: () => Promise<void> | void,
  onLog?: (level: string, msg: string) => void,
): Promise<{ level: string; msg: string }[]> {
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  const seen: { level: string; msg: string }[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (level: string, _cat: string, msg: string) => {
        seen.push({ level, msg });
        onLog?.(level, msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    await fn();
  } finally {
    setLogger(prev);
  }
  return seen;
}

// ── the chapter ─────────────────────────────────────────────────────────

Deno.test("large-state doc: the page every size message names exists, and its anchor lands on a heading", () => {
  const [page, anchor] = LARGE_STATE_DOC.split("#");
  const text = Deno.readTextFileSync(join(REPO, page!));
  assert(anchor, "the link names a section, not just a page");
  assert(
    headingSlugs(text.split("\n")).has(anchor),
    `${LARGE_STATE_DOC}: no heading slugs to "${anchor}"`,
  );
});

// ── the pure fix line ───────────────────────────────────────────────────

Deno.test("large-state fix: suggests ×1.5 rounded up to a whole MB, never below 2MB", () => {
  assertEquals(suggestCellStateBudget(0), "2MB");
  assertEquals(suggestCellStateBudget(1 * MB + 1024), "2MB");
  assertEquals(suggestCellStateBudget(12.5 * MB), "19MB");
  assertEquals(
    declareLargeState(12.5 * MB),
    `aio.run({ budgets: { cellState: "19MB", payload: "19MB" } })`,
  );
});

Deno.test("large-state fix: undeclared names the declaration, declared names raising it", () => {
  const undeclared = cellSizeFix(4 * MB, false);
  assertHint(undeclared, "undeclared");
  assertStringIncludes(undeclared, declareCellState(4 * MB));
  const frame = cellSizeFix(4 * MB, false, "frame");
  assertHint(frame, "undeclared frame");
  assertStringIncludes(frame, declareLargeState(4 * MB));
  const declared = cellSizeFix(4 * MB, true);
  assertHint(declared, "declared");
  assertStringIncludes(declared, "raise the cellState budget you declared");
});

Deno.test("large-state fix: a per-cell line never sizes payload from one cell — the declaration it prints really quiets it", () => {
  // Three 1.2MB cells: each per-cell line (persist) used to print
  // `payload: "2MB"`, but the pressure monitor measures the 3.6MB FRAME, so
  // the promised quiet never came. A per-cell line declares `cellState` only;
  // the frame-level lines (full-state seam, PRESSURE) size `payload` from the
  // frame they measured.
  const cellBytes = Math.round(1.2 * MB);
  const frameBytes = 3 * cellBytes;
  const declared = (fix: string) => {
    const m = /budgets: \{ (.*?) \}/.exec(fix);
    assert(m, fix);
    return resolveBudgets(
      JSON.parse("{" + m[1]!.replace(/(\w+):/g, '"$1":') + "}"),
    );
  };
  const perCell = declared(cellSizeFix(cellBytes, false));
  assertEquals(perCell.payload, undefined, "a per-cell line sized payload");
  assert(perCell.cellState! >= cellBytes, "cellState quiets the cell's line");
  const perFrame = declared(cellSizeFix(frameBytes, false, "frame"));
  assert(perFrame.payload! >= frameBytes, "payload quiets the frame's line");
  assert(perFrame.cellState! >= frameBytes, "cellState quiets the frame's");
});

// ── persist ─────────────────────────────────────────────────────────────

type Entry = { level: string; msg: string };
function makeLog(entries: Entry[]): Log {
  const push = (level: string) => (msg: string) => entries.push({ level, msg });
  return {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  } as unknown as Log;
}

async function persistOnce(
  state: Record<string, unknown>,
  declared?: number,
): Promise<{ logs: Entry[]; breaches: number }> {
  const dir = await tempDir("aio-large-state-");
  const db: DB = createDB(join(dir, "kv.db"));
  const logs: Entry[] = [];
  const budgets = createBudgetLedger(
    declared === undefined ? {} : { cellState: declared },
  );
  try {
    await db.execute(SKV_SCHEMA);
    const kv: SkvInstance = sqliteKv(db);
    const mgr = createPersistenceManager({
      kvDb: kv,
      asyncDb: db,
      dbSchema: undefined,
      persistKey: "app-state",
      persistMode: "multi",
      persistMs: 1,
      getState: () => state,
      getDBState: (s) => s,
      log: makeLog(logs),
      getReportOpts: () => ({}),
      appId: "large-state-test",
      budgets,
    });
    await mgr.flushPersist();
    mgr.setShuttingDown();
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
  return { logs, breaches: budgets.report()?.breaches.length ?? 0 };
}

Deno.test("large-state persist warn: size, threshold, Fix line with the declaration, chapter", async () => {
  const { logs } = await persistOnce({
    big: { blob: "x".repeat(PERSIST_CELL_WARN_BYTES + 1024) },
  });
  const warn = logs.find((l) => l.level === "warn" && l.msg.includes(`"big"`));
  assert(warn, JSON.stringify(logs));
  assertStringIncludes(warn.msg, "warn threshold 1.0 MB");
  assertStringIncludes(warn.msg, "Fix:");
  assertStringIncludes(warn.msg, `budgets: { cellState: "2MB" } })`);
  assert(!warn.msg.includes("payload"), "a per-cell line sized `payload`");
  assertHint(warn.msg, "persist warn");
});

Deno.test("large-state persist hard: every flush says the fix and the chapter", async () => {
  const { logs } = await persistOnce({
    huge: { blob: "x".repeat(PERSIST_CELL_HARD_BYTES + 4096) },
  });
  const err = logs.find((l) => l.level === "error" && l.msg.includes("hard"));
  assert(err, JSON.stringify(logs.map((l) => l.msg.slice(0, 80))));
  assertStringIncludes(err.msg, "Fix:");
  assertStringIncludes(err.msg, `cellState: "25MB"`);
  assertHint(err.msg, "persist hard");
});

Deno.test("large-state persist: a DECLARED cellState moves the warn line — under it is quiet", async () => {
  const { logs, breaches } = await persistOnce(
    { big: { blob: "x".repeat(2 * MB) } },
    4 * MB,
  );
  assertEquals(
    logs.filter((l) => l.level === "warn" || l.level === "error"),
    [],
    "a size the app declared must not warn — that is what declaring is for",
  );
  assertEquals(breaches, 0);
});

Deno.test("large-state persist: over a DECLARED cellState warns, says so, and records the breach", async () => {
  const { logs, breaches } = await persistOnce(
    { big: { blob: "x".repeat(5 * MB) } },
    4 * MB,
  );
  const warn = logs.find((l) => l.level === "warn" && l.msg.includes(`"big"`));
  assert(warn, JSON.stringify(logs));
  assertStringIncludes(warn.msg, "your cellState budget");
  assertStringIncludes(warn.msg, "raise the cellState budget you declared");
  assertHint(warn.msg, "persist declared");
  assertEquals(
    breaches,
    1,
    "a declared budget is a commitment: /health sees it",
  );
});

Deno.test("large-state persist: a declared cellState above 16MB lifts the hard line", async () => {
  const { logs } = await persistOnce(
    { big: { blob: "x".repeat(PERSIST_CELL_HARD_BYTES + 1024) } },
    20 * MB,
  );
  assertEquals(
    logs.filter((l) => l.level === "error"),
    [],
    "17MB under a declared 20MB is not an error on every flush",
  );
});

Deno.test("large-state persist: dev and prod say the same words", async () => {
  const g = globalThis as Record<string, unknown>;
  const prev = g.__aioDev;
  const texts: string[] = [];
  try {
    for (const dev of [true, false]) {
      g.__aioDev = dev;
      const { logs } = await persistOnce({
        big: { blob: "x".repeat(PERSIST_CELL_WARN_BYTES + 1024) },
      });
      texts.push(logs.find((l) => l.level === "warn")?.msg ?? "");
    }
  } finally {
    g.__aioDev = prev;
  }
  assert(texts[0], "dev warned");
  assertEquals(texts[0], texts[1]);
});

// ── the full-state frame (both transports) ──────────────────────────────

Deno.test("large-state broadcast: the full-state line carries the Fix and the chapter", async () => {
  const owner = () => ({});
  const json = JSON.stringify({ rows: "x".repeat(2 * MB) });
  const logs = await logsDuring(() =>
    warnBigFullState(json, () => ({ rows: { r: "x".repeat(2 * MB) } }), owner)
  );
  const hit = logs.find((l) => l.msg.includes("full-state frame"));
  assert(hit, JSON.stringify(logs));
  assertStringIncludes(hit.msg, "Fix:");
  assertStringIncludes(hit.msg, `cellState: "4MB"`);
  assertHint(hit.msg, "broadcast");
});

Deno.test({
  name:
    "large-state ws: the frame every client gets FIRST is guarded (persist off)",
  async fn() {
    // The gap this closes: with persist off and a big cell that only ever
    // changed by small patches, a WS app pushed its whole state on every
    // connect and no line anywhere said so. UDS had the check; WS did not.
    const big = cell("bigws", {
      state: { rows: "x".repeat(PERSIST_CELL_WARN_BYTES + 4096) },
      methods: {
        touch(s: { rows: string }) {
          s.rows += "y";
        },
      },
    });
    const logs = await logsDuring(async () => {
      await using srv = await testServer({ cells: [big] });
      const ws = new WebSocket(srv.url.replace(/^http/, "ws") + "/ws");
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("no state frame")), 5000);
          ws.onmessage = (e) => {
            if (String(e.data).startsWith(`{"v":2,"t":"state"`)) {
              clearTimeout(t);
              resolve();
            }
          };
          ws.onerror = () => {
            clearTimeout(t);
            reject(new Error("ws error"));
          };
        });
      } finally {
        const closed = new Promise((r) => (ws.onclose = r));
        ws.close();
        await closed;
      }
    });
    const hit = logs.find((l) =>
      l.level === "warn" && l.msg.includes("full-state frame")
    );
    assert(
      hit,
      `connect-time frame must be guarded on WS; got ${
        JSON.stringify(
          logs.filter((l) => l.level !== "debug").map((l) =>
            l.msg.slice(0, 90)
          ),
        )
      }`,
    );
    assertStringIncludes(hit.msg, `"bigws"`);
    assertHint(hit.msg, "ws connect");
  },
});

// ── the runtime ceilings (cannot be raised) ─────────────────────────────

Deno.test("large-state ws ceiling: the refusal to a Deno peer says it cannot be raised, and the fix", () => {
  const msg = peerCeilingMessage("state", 70 * MB, 64 * MB, 3);
  assertStringIncludes(msg, "70.0 MB");
  assertStringIncludes(msg, "cannot be raised");
  assertStringIncludes(msg, "Fix:");
  assertHint(msg, "ws ceiling");
});

Deno.test("large-state cli: a terminal client told the frame is too large gets the fix", () => {
  const msg = frameTooLargeMessage("Frame too large", 4000);
  assertStringIncludes(msg, "Frame too large");
  assertStringIncludes(msg, "Fix (in the app):");
  assertStringIncludes(msg, "Retrying in 4000ms.");
  assertHint(msg, "cli");
});

// ── pressure, dev freeze, UDS inbound ───────────────────────────────────

Deno.test("large-state pressure: the payload hint names both budgets and the chapter", () => {
  const lines: string[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 100,
    rateThreshold: 1000,
    budgets: createBudgetLedger({}),
    onConsole: (l) => lines.push(...l),
  });
  try {
    pm.onBroadcast("client-1", 3 * MB);
  } finally {
    pm.destroy();
  }
  const hint = lines.find((l) => l.includes("hint:"));
  assert(hint, JSON.stringify(lines));
  assertStringIncludes(hint, declareLargeState(3 * MB));
  assertHint(hint, "pressure");
});

Deno.test("large-state pressure: the bandwidth hint names visible (not the removed ui:) and the chapter", async () => {
  const lines: string[] = [];
  const pm = createPressureMonitor({
    payloadThreshold: 1e12,
    rateThreshold: 1000,
    bandwidthThreshold: 1,
    budgets: createBudgetLedger({}),
    onConsole: (l) => lines.push(...l),
  });
  try {
    pm.onBroadcast("client-1", 4096);
    await new Promise((r) => setTimeout(r, 1050)); // the rate needs ≥1s of data
    pm.onBroadcast("client-1", 4096);
  } finally {
    pm.destroy();
  }
  const hint = lines.find((l) => l.includes("hint:"));
  assert(hint, JSON.stringify(lines));
  assertStringIncludes(hint, "visible");
  assert(!hint.includes("ui filters"), hint);
  assertHint(hint, "bandwidth");
});

Deno.test("large-state dev freeze: the skip notice names the fix and the chapter", async () => {
  const g = globalThis as Record<string, unknown>;
  const prev = g.__aioFreezeSkipped;
  delete g.__aioFreezeSkipped;
  try {
    const logs = await logsDuring(() => noteFreezeSkipped("declared state"));
    const hit = logs.find((l) => l.msg.includes("dev freeze skipped"));
    assert(hit, JSON.stringify(logs));
    assertStringIncludes(hit.msg, "Fix:");
    assertHint(hit.msg, "dev freeze");
  } finally {
    g.__aioFreezeSkipped = prev;
  }
});

Deno.test({
  name:
    "large-state uds: an inbound frame over the ceiling names the knob and the chapter",
  ignore: Deno.build.os === "windows", // Deno.connect unix; named pipes elsewhere
  async fn() {
    const dir = await tempDir("aio-uds-ceiling-");
    const socketPath = join(dir, "c.sock");
    const uds = createUDSListener(socketPath, () => ({}), () => {}, () => {});
    try {
      // The writer is a CHILD process, as the Electron main process is.
      const code = `const c = await Deno.connect({ path: ${
        JSON.stringify(socketPath)
      }, transport: "unix" });
c.readable.pipeTo(new WritableStream()).catch(() => {});
const chunk = new TextEncoder().encode("x".repeat(1 << 20));
const w = c.writable.getWriter(); // write() alone may write PART of a chunk
try { for (let i = 0; i < 11; i++) await w.write(chunk); } catch { /* closed */ }
await new Promise((r) => setTimeout(r, 300));
try { w.releaseLock(); c.close(); } catch { /* closed */ }`;
      let said = false;
      const logs = await logsDuring(async () => {
        const out = await new Deno.Command(Deno.execPath(), {
          args: ["eval", code],
          stdout: "null",
          stderr: "null",
        }).output();
        assertEquals(out.code, 0, "the writer child exits cleanly");
        // The server drains its side after the child is gone.
        for (let i = 0; i < 100 && !said; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }, (level) => {
        if (level === "error") said = true;
      });
      const hit = logs.find((l) =>
        l.level === "error" && l.msg.includes("UDS frame ceiling")
      );
      assert(hit, JSON.stringify(logs.map((l) => l.msg.slice(0, 90))));
      assertStringIncludes(hit.msg, "maxMessageBytes");
      assertStringIncludes(hit.msg, "Fix:");
      assertStringIncludes(hit.msg, LARGE_STATE_DOC);
    } finally {
      uds.shutdown();
      await dropTempDir(dir);
    }
  },
});
