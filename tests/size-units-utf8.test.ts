// Every size limit aio declares is in BYTES — and three of them measured
// UTF-16 code units.
//
// `budgets.cellState`, the persist warn/hard thresholds and
// `wsLimits.maxMessageBytes` all compared a limit written in bytes against
// `json.length`, which is characters. The two agree only for ASCII: a CJK
// document is ~3× its `length` in UTF-8, so an app with 900 KB of Japanese
// state was reported at 900 KB and was 2.7 MB on the wire and on disk, under
// budgets it had blown and warnings that never fired.
//
// Reports and warnings are measured in UTF-8 bytes now. A HARD refusal keeps
// the decision it makes today — a frame accepted yesterday is still accepted —
// but says loudly when the real byte size is over the limit it advertises.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { overUtf8, utf8Size } from "../src/protocol/utf8-size.ts";
import {
  _resetBigStateWarnings,
  BROADCAST_FULL_WARN_BYTES,
  warnBigFullState,
} from "../src/server/server-broadcast.ts";
import { budgetsFor, resetBudgets, setBudgets } from "../src/state/budgets.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { join } from "@std/path";
import {
  createPersistenceManager,
  PERSIST_CELL_WARN_BYTES,
} from "../src/server/persistence.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { createDB } from "../src/server-entry.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const enc = new TextEncoder();

function logsDuring(fn: () => void): { warn: string[]; error: string[] } {
  const warn: string[] = [], error: string[] = [];
  const prev = getLogger();
  setLogger({
    logDir: "",
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "warn") warn.push(msg);
      if (lvl === "error") error.push(msg);
    },
    perf: () => {},
    flush: () => Promise.resolve(),
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    fn();
  } finally {
    setLogger(prev);
  }
  return { warn, error };
}

Deno.test("utf8Size counts exactly what TextEncoder encodes", () => {
  const cases = [
    "",
    "plain ascii",
    "é",
    "日本語のテキスト",
    "emoji 👩‍👩‍👧‍👦 and 🇯🇵",
    "\u{10FFFF}",
    "lone high \ud800 surrogate",
    "lone low \udc00 surrogate",
    "pair 😀 ok",
    JSON.stringify({ 名前: "値", list: ["日", "本", 1, null] }),
  ];
  for (const s of cases) {
    assertEquals(utf8Size(s), enc.encode(s).byteLength, JSON.stringify(s));
  }
  // Fuzz: random code units, including unpaired surrogates.
  let seed = 7;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let t = 0; t < 200; t++) {
    let s = "";
    for (let i = 0; i < 1 + Math.floor(rand() * 40); i++) {
      s += String.fromCharCode(Math.floor(rand() * 0x11000));
    }
    assertEquals(utf8Size(s), enc.encode(s).byteLength, JSON.stringify(s));
  }
});

Deno.test("overUtf8 answers exactly what a byte count would", () => {
  const strings = ["", "abc", "日本語", "aé日", "👩‍👩‍👧‍👦"];
  for (const s of strings) {
    for (let limit = 0; limit <= 40; limit++) {
      assertEquals(
        overUtf8(s, limit),
        enc.encode(s).byteLength > limit,
        `${JSON.stringify(s)} over ${limit}`,
      );
    }
  }
});

Deno.test("broadcast: a CJK cell over the budget in BYTES is named", () => {
  _resetBigStateWarnings();
  resetBudgets();
  // Under the budget in characters, well over it in UTF-8 bytes — the state
  // that used to be reported as fine while it moved 3× its reported size.
  const chars = Math.floor(BROADCAST_FULL_WARN_BYTES / 2);
  const state = { catalog: { rows: "本".repeat(chars) }, nav: { tab: "a" } };
  const json = JSON.stringify(state);
  assert(
    json.length <= BROADCAST_FULL_WARN_BYTES,
    "instrument: under in chars",
  );
  assert(
    utf8Size(json) > BROADCAST_FULL_WARN_BYTES,
    "instrument: over in bytes",
  );
  const logs = logsDuring(() => warnBigFullState(json, () => state));
  const hit = logs.warn.find((w) => w.includes("full-state frame"));
  assert(hit, `an oversized frame must be named: ${JSON.stringify(logs)}`);
  assertStringIncludes(hit, '"catalog"');
  // …and the size it prints is the byte size, not the character count.
  assertStringIncludes(hit, "1.5 MB");
});

Deno.test("budgets: a breach is recorded in the declared unit — bytes", () => {
  _resetBigStateWarnings();
  const ledger = setBudgets({ cellState: 200_000 });
  try {
    const state = { docs: { body: "本".repeat(100_000) } }; // 100k chars, 300k bytes
    const json = JSON.stringify(state);
    assert(json.length < 200_000, "instrument: under the budget in chars");
    logsDuring(() => warnBigFullState(json, () => state));
    const breach = ledger.report()?.breaches.find((b) =>
      b.budget === "cellState"
    );
    assert(
      breach,
      `a declared budget blown by 50% must be recorded: ${
        JSON.stringify(ledger.report())
      }`,
    );
    assert(
      breach.worst > 200_000,
      `the reading has to be the byte size: ${breach.worst}`,
    );
  } finally {
    resetBudgets();
  }
});

Deno.test("budgets: /health measures cell state in bytes too", () => {
  resetBudgets();
  const ledger = setBudgets({ cellState: 200_000 });
  try {
    ledger.measureCellStates({ docs: { body: "本".repeat(100_000) } });
    const breach = ledger.report()?.breaches.find((b) =>
      b.budget === "cellState"
    );
    assert(
      breach && breach.worst > 200_000,
      `health's own sampling must agree with the broadcaster's: ${
        JSON.stringify(ledger.report())
      }`,
    );
  } finally {
    resetBudgets();
  }
});

Deno.test("budgets: the ledger a report lands in is the app's own", () => {
  // Guard against the fix above leaking into the process ledger.
  resetBudgets();
  assertEquals(budgetsFor().declared().cellState, undefined);
});

Deno.test("persist: a CJK cell over the warn threshold in BYTES is named", async () => {
  const dir = await tempDir("size-units-persist-");
  const db = createDB(join(dir, "kv.db"));
  const logs: Array<{ level: string; msg: string }> = [];
  const mkLog = (level: string) => (msg: string) => logs.push({ level, msg });
  try {
    await db.execute(SKV_SCHEMA);
    // Under the threshold in characters, half again over it in bytes: this
    // cell costs 1.5 MB on every flush and every broadcast and said nothing.
    const state: Record<string, unknown> = {
      docs: { body: "本".repeat(Math.floor(PERSIST_CELL_WARN_BYTES / 2)) },
    };
    const json = JSON.stringify(state.docs);
    assert(json.length < PERSIST_CELL_WARN_BYTES, "instrument: under in chars");
    assert(
      utf8Size(json) > PERSIST_CELL_WARN_BYTES,
      "instrument: over in bytes",
    );
    const mgr = createPersistenceManager({
      kvDb: sqliteKv(db),
      asyncDb: db,
      dbSchema: undefined,
      persistKey: "app-state",
      persistMode: "multi",
      persistMs: 1,
      getState: () => state,
      getDBState: (v) => v,
      log: {
        debug: mkLog("debug"),
        info: mkLog("info"),
        warn: mkLog("warn"),
        error: mkLog("error"),
        // deno-lint-ignore no-explicit-any
      } as any as Log,
      getReportOpts: () => ({}),
      appId: "size-units",
    });
    await mgr.flushPersist();
    const warn = logs.find((l) =>
      l.level === "warn" && l.msg.includes('cell "docs"')
    );
    assert(warn, `the cell must be named: ${JSON.stringify(logs)}`);
    assertStringIncludes(warn.msg, "1.5 MB");
    // The write still happened — a size report never costs data.
    assert(
      logs.some((l) => l.msg.includes("saved multi (1/1 cells written)")),
      `the cell is still persisted: ${JSON.stringify(logs)}`,
    );
  } finally {
    await db.close();
    await dropTempDir(dir);
  }
});

Deno.test("ws: a frame over maxMessageBytes in BYTES only is still accepted, and said", async () => {
  const dir = await tempDir("size-units-ws-");
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const port = freePort();
  const dispatched: string[] = [];
  const logs = { warn: [] as string[], error: [] as string[] };
  const prev = getLogger();
  setLogger({
    logDir: "",
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "warn") logs.warn.push(msg);
      if (lvl === "error") logs.error.push(msg);
    },
    perf: () => {},
    flush: () => Promise.resolve(),
    // deno-lint-ignore no-explicit-any
  } as any);
  const server = createServer({
    port,
    title: "Units",
    getUIState: () => ({ c: { n: 1 } }),
    dispatch: (a: unknown) => {
      dispatched.push((a as { type: string }).type);
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    syncIntervalMs: 10,
    wsLimits: { maxMessageBytes: 8_000, bytesPerSec: 5_000_000 },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const frame = JSON.stringify({
      v: 2,
      t: "action",
      d: { type: "c:put", payload: { body: "本".repeat(3_000) } },
    });
    assert(frame.length < 8_000, "instrument: under the limit in chars");
    assert(utf8Size(frame) > 8_000, "instrument: over it in bytes");
    ws.send(frame);
    await new Promise((r) => setTimeout(r, 300));
    // COMPAT: the refusal decision is unchanged — this frame was accepted
    // before the unit was fixed and is accepted now.
    assertEquals(dispatched, ["c:put"]);
    // …and the mismatch is no longer silent.
    const said = [...logs.warn, ...logs.error].find((m) =>
      m.includes("maxMessageBytes")
    );
    assert(
      said,
      `a frame over the declared byte limit must be said: ${
        JSON.stringify(logs)
      }`,
    );
  } finally {
    setLogger(prev);
    try {
      ws.close();
    } catch { /* gone */ }
    await server.shutdown();
    await new Promise((r) => setTimeout(r, 50));
    await dropTempDir(dir);
  }
});

Deno.test("broadcast: the size check does not rescan the frame on every send", () => {
  // It runs on EVERY full-state send. Counting bytes is O(n), so the latch has
  // to answer "already analyzed" before anything touches the string — or an
  // app over the limit pays a full scan of its state per frame, forever.
  _resetBigStateWarnings();
  resetBudgets();
  const state = { big: { blob: "本".repeat(2_000_000) } }; // ~6 MB
  const json = JSON.stringify(state);
  const t0 = performance.now();
  utf8Size(json);
  const oneScan = performance.now() - t0;
  logsDuring(() => warnBigFullState(json, () => state)); // the one analysis
  const t1 = performance.now();
  logsDuring(() => {
    for (let i = 0; i < 200; i++) warnBigFullState(json, () => state);
  });
  const repeats = performance.now() - t1;
  assert(
    repeats < oneScan * 10,
    `200 repeat checks took ${repeats.toFixed(1)}ms against ${
      oneScan.toFixed(1)
    }ms for a single byte count — the frame is being rescanned per send`,
  );
});

Deno.test("broadcast: a frame UNDER the limit is not rescanned on every send either", () => {
  // The half the latch missed. `overUtf8` settles a frame on its length alone
  // only below a THIRD of the limit; between that and the limit it counts the
  // whole string — and the "already measured" latch was written after that
  // call, so a frame that measured UNDER never reached it. An app with 900 KB
  // of ASCII state, comfortably inside its 1 MiB budget and warned about
  // nothing, paid a full 0.7 ms scan of its state on EVERY full-state send,
  // forever — where before the move to bytes this was one `length` compare.
  _resetBigStateWarnings();
  resetBudgets();
  const state = { big: { blob: "a".repeat(900_000) } };
  const json = JSON.stringify(state);
  assert(
    json.length * 3 > BROADCAST_FULL_WARN_BYTES &&
      utf8Size(json) < BROADCAST_FULL_WARN_BYTES,
    "instrument: the probe must sit in the band `overUtf8` has to count",
  );
  const t0 = performance.now();
  utf8Size(json);
  const oneScan = performance.now() - t0;
  warnBigFullState(json, () => state); // the one measurement
  const t1 = performance.now();
  for (let i = 0; i < 200; i++) warnBigFullState(json, () => state);
  const repeats = performance.now() - t1;
  assert(
    repeats < oneScan * 10,
    `200 checks of an UNDER-budget frame took ${repeats.toFixed(1)}ms ` +
      `against ${oneScan.toFixed(1)}ms for one byte count — it is rescanned ` +
      `per send`,
  );
});

Deno.test("broadcast: what the cheap gate hides is bounded, not permanent", () => {
  // The price of gating on code units: a frame that SHRANK in characters
  // while growing in bytes — the same text turned CJK — is under the largest
  // length already measured and never reaches the byte count. The gate
  // therefore reopens every LATCH_RECHECK_EVERY skipped sends, so the miss
  // costs rounds, not the life of the process.
  _resetBigStateWarnings();
  resetBudgets();
  const ascii = { big: { blob: "a".repeat(900_000) } }; // under, 900 KB
  const asciiJson = JSON.stringify(ascii);
  const cjk = { big: { blob: "本".repeat(400_000) } }; // 1.2 MB in 400k chars
  const cjkJson = JSON.stringify(cjk);
  assert(
    cjkJson.length < asciiJson.length &&
      utf8Size(cjkJson) > BROADCAST_FULL_WARN_BYTES,
    "instrument: the CJK frame must be shorter AND over the budget",
  );
  warnBigFullState(asciiJson, () => ascii);
  // …and now the shorter, heavier frame, every round.
  let said = 0;
  for (let i = 0; i < 600 && said === 0; i++) {
    const { warn } = logsDuring(() => warnBigFullState(cjkJson, () => cjk));
    if (warn.some((w) => w.includes("full-state frame"))) said = i + 1;
  }
  assert(said > 0 && said <= 300, `named after ${said} rounds, or never`);
});
