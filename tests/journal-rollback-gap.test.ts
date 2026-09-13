// A journal is never replayed across a hole between it and a database that
// went back in time.
//
// `checkIntegrityOnBoot` restores `state.db.snapshot` over a damaged file. The
// snapshot is OLDER than the journal: every action between the two was
// compacted out of the journal when a later snapshot persisted it, and that
// later snapshot is the damaged file. Boot replayed the surviving tail onto the
// restored state anyway. Measured (r3 chaos hunt): snapshot at balance 50,
// three persisted `deposit(100)`, then `withdrawAll()` and `deposit(7)` in the
// tail, SIGKILL, corrupt `state.db` → the restart came back at 7 with history
// `[+10×5, "-50", "+7"]` — a withdrawal of 50 that never happened, logged as
// "journal: recovered 2 actions".
//
// The journal now records what each compaction dropped (`<journal>.base`); a
// store whose watermark is below it refuses replay loudly and the journal is
// parked beside the damaged database.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  createJournal,
  type JournalEntry,
  replayJournal,
} from "../src/server/journal.ts";
import { makeRedactor, REDACTED } from "../src/diagnostics/redact.ts";
import { createTimeline } from "../src/server/timeline.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const bank = cell("bank", {
  state: { balance: 0, history: [] },
  methods: {
    deposit(s, n) { s.balance += n; s.history.push("+" + n); },
    withdrawAll(s) {
      if (s.balance > 0) { s.history.push("-" + s.balance); s.balance = 0; }
    },
    // Enough bytes for several b-tree pages, so the corruption below lands
    // in real data rather than in an empty file.
    pad(s, n) { for (let i = 0; i < n; i++) s.history.push("x".repeat(200)); },
  },
});
const app = await aio.run({
  cells: [bank],
  appId: "journal-gap-probe",
  client: "server-only",
  journal: true,
  checkIntegrityOnBoot: true,
  persistDebounceMs: 40,
  port: PORT,
  appDir: DIR,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (Deno.env.get("PHASE") === "crash") {
  await bank.pad(200);
  for (let i = 0; i < 5; i++) await bank.deposit(10);
  await sleep(400);
  await app.db.snapshot(DIR + "/data/state.db.snapshot"); // balance 50
  for (let i = 0; i < 3; i++) await bank.deposit(100);
  await sleep(400); // persisted — and compacted out of the journal
  await bank.withdrawAll(); // the tail: -350 …
  await bank.deposit(7); //   … +7
  Deno.kill(Deno.pid, "SIGKILL");
} else if (Deno.env.get("PHASE") === "clean") {
  for (let i = 0; i < 5; i++) await bank.deposit(10);
  await sleep(400);
  await app.db.snapshot(DIR + "/data/state.db.snapshot"); // balance 50
  for (let i = 0; i < 3; i++) await bank.deposit(100);
  await app.close(); // the final flush compacts the journal empty
  Deno.exit(0);
} else if (Deno.env.get("PHASE") === "after-restore") {
  await bank.deposit(1); // acked on the restored backup — in the journal only
  Deno.kill(Deno.pid, "SIGKILL");
} else {
  Deno.writeTextFileSync(
    DIR + "/recovered.json",
    JSON.stringify({
      balance: bank.balance,
      history: bank.history.filter((h) => h[0] !== "x"),
    }),
  );
  Deno.exit(0);
}
`;

async function runChild(dir: string, phase: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase === "read" && !out.success) {
    throw new Error(`read child failed:\n${text}`);
  }
  return text;
}

/** Checkpoint the WAL into the file, then overwrite a slice of every page
 *  after the first — damage `quick_check` sees. */
function corrupt(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  let pages = 0;
  let size = 0;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    pages = (db.prepare("PRAGMA page_count").get() as { page_count: number })
      .page_count;
    size = (db.prepare("PRAGMA page_size").get() as { page_size: number })
      .page_size;
  } finally {
    db.close();
  }
  assert(pages > 2, `expected a multi-page database, got ${pages}`);
  const f = Deno.openSync(dbPath, { read: true, write: true });
  try {
    for (let pg = 2; pg <= pages; pg++) {
      f.seekSync((pg - 1) * size + 8, Deno.SeekMode.Start);
      f.writeSync(new Uint8Array(40).fill(0xab));
    }
  } finally {
    f.close();
  }
}

Deno.test("journal: an integrity-check restore is never replayed across the hole it leaves", async () => {
  const dir = await tempDir("aio-journal-gap-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const crashLog = await runChild(dir, "crash");
    const data = join(dir, "data");
    assert(
      await Deno.stat(join(data, "state.db.snapshot")).then(
        () => true,
        () => false,
      ),
      `the crash child never took its snapshot:\n${crashLog}`,
    );
    corrupt(join(data, "state.db"));

    const bootLog = await runChild(dir, "read");
    const recovered = JSON.parse(
      await Deno.readTextFile(join(dir, "recovered.json")),
    ) as { balance: number; history: string[] };
    assertEquals(
      recovered,
      { balance: 50, history: ["+10", "+10", "+10", "+10", "+10"] },
      `the restored snapshot is the state — replaying withdrawAll() onto it ` +
        `invents a withdrawal of 50.\n${bootLog}`,
    );
    assertStringIncludes(bootLog, "REFUSED to replay");
    const parked = [...Deno.readDirSync(data)].map((e) => e.name).filter((n) =>
      /^state\.db\.corrupt-.*\.journal$/.test(n)
    );
    assertEquals(
      parked.length,
      1,
      `the journal is kept beside the damaged database: ${
        [...Deno.readDirSync(data)].map((e) => e.name)
      }`,
    );
    assertStringIncludes(bootLog, parked[0]!, "the refusal names where it is");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal: a backup put back after a clean stop is not a refusal — and the next crash still replays", async () => {
  const dir = await tempDir("aio-journal-gap-backup-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const cleanLog = await runChild(dir, "clean");
    const data = join(dir, "data");
    // The operator restores yesterday's backup over a healthy database.
    for (const side of ["-wal", "-shm"]) {
      await Deno.remove(join(data, "state.db" + side)).catch(() => {});
    }
    await Deno.copyFile(join(data, "state.db.snapshot"), join(data, "state.db"))
      .catch((e) => {
        throw new Error(`no snapshot to restore (${e}):\n${cleanLog}`);
      });
    const restoreLog = await runChild(dir, "after-restore");
    const bootLog = await runChild(dir, "read");
    const recovered = JSON.parse(
      await Deno.readTextFile(join(dir, "recovered.json")),
    ) as { balance: number };
    assert(
      !restoreLog.includes("REFUSED") && !bootLog.includes("REFUSED"),
      `nothing was past the store to replay — no refusal:\n${restoreLog}\n${bootLog}`,
    );
    assertEquals(
      recovered.balance,
      51,
      `the deposit acked on the restored backup must be replayed after the ` +
        `crash:\n${bootLog}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

// ── The decider, without a process ──────────────────────────────────────────

const act = (type: string, n = 1) => ({ type, payload: { args: [n] } });

Deno.test("journal gap: a store at or past what compaction dropped has no gap", async () => {
  const dir = await tempDir("aio-journal-gap-unit-");
  try {
    const path = join(dir, "journal");
    const j = createJournal(path, { storedWatermark: 0 });
    for (let i = 0; i < 3; i++) j.append(act("c:m"), i);
    j.setWatermark(3);
    j.append(act("c:m"), 9);
    assertEquals(createJournal(path, { storedWatermark: 3 }).gap(), null);
    assertEquals(createJournal(path, { storedWatermark: 4 }).gap(), null);
    assertEquals(
      createJournal(path, { storedWatermark: 1 }).gap(),
      { stream: "actions", droppedThrough: 3, storeAt: 1 },
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal gap: a rollback with no compaction since keeps an intact, replayable tail", async () => {
  const dir = await tempDir("aio-journal-gap-intact-");
  try {
    const path = join(dir, "journal");
    const j = createJournal(path, { storedWatermark: 2 });
    j.append(act("c:m"), 1); // seq 3
    j.append(act("c:m"), 2); // seq 4
    const again = createJournal(path, { storedWatermark: 2 });
    assertEquals(again.gap(), null);
    assertEquals(again.readTail().map((e) => e.seq), [3, 4]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal gap: a journal from before the base is judged by its first seq", async () => {
  const dir = await tempDir("aio-journal-gap-legacy-");
  try {
    const path = join(dir, "journal");
    const line = (seq: number) =>
      JSON.stringify({ seq, type: "c:m", payload: { args: [1] }, ts: seq });
    Deno.writeTextFileSync(path, `${line(5)}\n${line(6)}\n`);
    assertEquals(createJournal(path, { storedWatermark: 4 }).gap(), null);
    assertEquals(createJournal(path, { storedWatermark: 5 }).gap(), null);
    assertEquals(
      createJournal(path, { storedWatermark: 2 }).gap(),
      { stream: "actions", droppedThrough: 4, storeAt: 2 },
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal gap: quarantine parks the journal and the next one starts clean, seq still rising", async () => {
  const dir = await tempDir("aio-journal-gap-quarantine-");
  try {
    const path = join(dir, "journal");
    const j = createJournal(path, { storedWatermark: 0 });
    for (let i = 0; i < 4; i++) j.append(act("c:m"), i);
    j.setWatermark(4);
    j.append(act("c:m"), 5); // seq 5
    const rolled = createJournal(path, { storedWatermark: 1 });
    assert(rolled.gap() !== null);
    rolled.quarantine(join(dir, "parked.journal"));
    assert(Deno.statSync(join(dir, "parked.journal")).isFile);
    assert(Deno.statSync(join(dir, "parked.journal.base")).isFile);
    assertEquals(rolled.gap(), null, "the hole left with the parked journal");
    assertEquals(rolled.append(act("c:m"), 6), 6, "no seq is reused");
    const next = createJournal(path, { storedWatermark: 1 });
    assertEquals(next.gap(), null);
    assertEquals(next.readTail().map((e) => e.seq), [6]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal: a tracked (sync) cell's lines go by its own watermark", async () => {
  const dir = await tempDir("aio-journal-cellwm-");
  try {
    const path = join(dir, "journal");
    const j = createJournal(path, { storedWatermark: 0 });
    j.trackCells({ log: 0 });
    j.append(act("log:add", 1), 1); // 1
    j.append(act("log:add", 2), 2); // 2
    j.append(act("kv:set", 3), 3); // 3
    // The KV snapshot persisted through seq 3 — it does not hold log's lines.
    j.setWatermark(3);
    assertEquals(j.readTail().map((e) => e.seq), [1, 2]);
    // The fold holding log's first write commits.
    j.setCellWatermark("log", 1);
    assertEquals(j.readTail().map((e) => e.seq), [2]);
    const lines = Deno.readTextFileSync(path).trim().split("\n");
    assertEquals(lines.map((l) => JSON.parse(l).seq), [2]);
    // Never re-issue a seq a fold claims, even when no line holds it.
    const reopened = createJournal(path, { storedWatermark: 3 });
    reopened.trackCells({ log: 9 });
    assertEquals(reopened.append(act("log:add", 4), 4), 10);
    // A store whose fold watermark went back is a hole for that cell.
    const back = createJournal(path, { storedWatermark: 3 });
    back.trackCells({ log: 0 });
    assertEquals(back.gap(), { stream: "log", droppedThrough: 1, storeAt: 0 });
    // …but a cell this build no longer tracks has no watermark to be behind.
    assertEquals(createJournal(path, { storedWatermark: 3 }).gap(), null);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("replayJournal: an entry's change to a key its watermark already covers is not applied again", () => {
  type S = Record<string, { n: number }>;
  const reduce = (s: S, a: { type: string }) => ({
    // One action, two cells — a KV cell and a sync cell with its own clock.
    state: a.type === "kv:both"
      ? { kv: { n: s.kv!.n + 1 }, sync: { n: s.sync!.n + 1 } }
      : s,
  });
  const e: JournalEntry = { seq: 5, type: "kv:both", ts: 0 };
  const out = replayJournal<S, { type: string }>(
    { kv: { n: 1 }, sync: { n: 0 } },
    [e],
    reduce,
    (key) => (key === "kv" ? 5 : 4),
  );
  assertEquals(out.state, { kv: { n: 1 }, sync: { n: 1 } });
});

Deno.test("worker patch batches: a redacted cell's values stay out of the journal and the timeline", async () => {
  const dir = await tempDir("aio-journal-worker-redact-");
  try {
    const redact = makeRedactor(["vault:unlockWith"]);
    const payload = {
      cell: "vault",
      ops: [{ op: "replace", path: ["secret"], value: "hunter2" }],
    };
    const path = join(dir, "journal");
    const j = createJournal(path, { redact });
    j.append({ type: "__aioWorkerPatch", payload }, 1);
    const text = Deno.readTextFileSync(path);
    assert(!text.includes("hunter2"), text);
    assertEquals(JSON.parse(text.trim()).redacted, true);

    const tl = createTimeline(10, redact);
    tl.record(
      1,
      "__aioWorkerPatch",
      payload,
      { vault: { secret: "" } },
      { vault: { secret: "hunter2" } },
      1,
      "vault:__worker",
    );
    const entry = tl.entries()[0]!;
    assertEquals(entry.payload, REDACTED);
    assert(!JSON.stringify(entry).includes("hunter2"), JSON.stringify(entry));
  } finally {
    await dropTempDir(dir);
  }
});
