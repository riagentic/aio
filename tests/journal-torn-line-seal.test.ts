// An unterminated last journal line is SEALED at open, never appended to.
//
// A crash between a write and its newline (or a kill mid-write) leaves the
// journal's last line without "\n". The next boot read it — intact or torn —
// and then `append` wrote its JSON straight after whatever the file ended
// with, so the new entry FUSED with the old line: one unparseable line holding
// two entries. The boot after that skipped the fused line as "1 torn line
// (a crash mid-write)", losing an entry the previous boot had already
// recovered AND the entry it acked, printed the warning twice, and — when the
// old line was torn — re-issued its seq to the new entry.
//
// Now: at open, a non-empty journal not ending in "\n" gets one "\n" before
// anything is appended; an unparseable line's `"seq":N` is scraped so a seq
// is never re-issued; the warning counts ENTRIES (a fused line is two), says
// "fused" rather than blaming a crash for it, and prints once per boot.
//
// The FILE FORMAT IS UNCHANGED: one JSON entry per line, "\n"-terminated.
// A journal written by an older build reads back identically; the only new
// bytes on disk are the single "\n" that seals a torn tail.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { createJournal, replayJournal } from "../src/server/journal.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type S = { n: number };
const reduce = (s: S, a: { type: string; payload?: unknown }) => ({
  state: a.type === "add" ? { n: s.n + (a.payload as number) } : s,
});

/** Every torn-journal line the callback printed. */
async function tornWarnings(
  fn: () => void | Promise<void>,
): Promise<string[]> {
  const out: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  const cap = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.warn = cap;
  console.error = cap;
  console.log = cap;
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return out.filter((l) => l.includes("journal:") && l.includes("torn"));
}

/** run1: two acked adds (5, 7), then the process dies. */
function run1(path: string): void {
  const j = createJournal(path);
  j.append({ type: "add", payload: 5 }, 1);
  j.append({ type: "add", payload: 7 }, 2);
}

Deno.test("journal: case B — only the trailing newline is missing: the recovered entries and the next acked one all survive", async () => {
  const dir = await tempDir("aio-journal-seal-b-");
  try {
    const path = join(dir, "journal");
    run1(path);
    const text = await Deno.readTextFile(path);
    await Deno.writeTextFile(path, text.replace(/\n$/, ""));
    assert(!(await Deno.readTextFile(path)).endsWith("\n"), "tail stripped");

    // run2: boots, recovers both, acks add 9, dies before any persist.
    const warned2 = await tornWarnings(() => {
      const j = createJournal(path);
      const r = replayJournal({ n: 0 }, j.readSince(0), reduce);
      assertEquals(r.state, { n: 12 }, "both entries recovered");
      assertEquals(j.append({ type: "add", payload: 9 }, 3), 3);
    });
    assertEquals(warned2, [], "an intact line is not torn");
    const lines = (await Deno.readTextFile(path)).split("\n").filter(Boolean);
    assertEquals(
      lines.map((l) => JSON.parse(l).seq),
      [1, 2, 3],
      `every entry on its own line, not fused:\n${lines.join("\n")}`,
    );

    // run3: nothing is lost, nothing is warned.
    const warned3 = await tornWarnings(() => {
      const j = createJournal(path);
      const r = replayJournal({ n: 0 }, j.readSince(0), reduce);
      assertEquals(r.state, { n: 21 }, "5 + 7 + 9 — the acked add survives");
      assertEquals(r.replayed, 3);
    });
    assertEquals(warned3, []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal: case A — a torn last line: its seq is never re-issued, the next acked entry survives, and the warning prints once", async () => {
  const dir = await tempDir("aio-journal-seal-a-");
  try {
    const path = join(dir, "journal");
    run1(path);
    const bytes = await Deno.readFile(path);
    await Deno.writeFile(path, bytes.slice(0, bytes.length - 10)); // tears seq 2

    // run2: the torn entry (seq 2) is genuinely lost — said once, by seq.
    let seq9 = 0;
    const warned2 = await tornWarnings(() => {
      const j = createJournal(path);
      const r = replayJournal({ n: 0 }, j.readSince(0), reduce);
      assertEquals(r.state, { n: 5 }, "seq 1 replays; seq 2 is the torn one");
      seq9 = j.append({ type: "add", payload: 9 }, 3);
    });
    assertEquals(seq9, 3, "seq 2 belongs to the torn entry — never re-issued");
    assertEquals(warned2.length, 1, `once per boot:\n${warned2.join("\n")}`);
    assertStringIncludes(warned2[0]!, "seq 2");
    assertStringIncludes(warned2[0]!, "1 entry lost");

    // run3: seq 1 and 3 replay; the tear is still said, still once —
    // open + readSince + the compaction inside setWatermark all parse it.
    const warned3 = await tornWarnings(() => {
      const j = createJournal(path);
      const r = replayJournal({ n: 0 }, j.readSince(0), reduce);
      assertEquals(r.state, { n: 14 }, "5 + 9");
      assertEquals(r.replayed, 2);
      j.setWatermark(3); // compacts — must not repeat the warning
    });
    assertEquals(warned3.length, 1, `once per boot:\n${warned3.join("\n")}`);
    // Compaction dropped the torn line; the next boot has nothing to say.
    const warned4 = await tornWarnings(() => {
      createJournal(path).readSince(0);
    });
    assertEquals(warned4, []);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal: a line an OLDER build fused is reported as two lost entries, not a crash", async () => {
  const dir = await tempDir("aio-journal-seal-fused-");
  try {
    const path = join(dir, "journal");
    await Deno.writeTextFile(
      path,
      `{"seq":1,"type":"add","payload":5,"ts":1}\n` +
        `{"seq":2,"type":"add","payload":7,"ts":2}` +
        `{"seq":3,"type":"add","payload":9,"ts":3}\n`,
    );
    let next = 0;
    const warned = await tornWarnings(() => {
      const j = createJournal(path);
      assertEquals(j.readSince(0).map((e) => e.seq), [1]);
      next = j.currentSeq() + 1;
    });
    assertEquals(next, 4, "seq 3 is inside the fused line — never re-issued");
    assertEquals(warned.length, 1, warned.join("\n"));
    assertStringIncludes(warned[0]!, "fused");
    assertStringIncludes(warned[0]!, "2 entries lost");
    assertStringIncludes(warned[0]!, "seq 2, 3");
    assert(
      !warned[0]!.includes("crash mid-write"),
      `a fused line is not a crash: ${warned[0]}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal: a torn BATCH is a crash mid-write that took all its entries — not a fused line", async () => {
  // One `__aioBatch` line holds several entries (journal.ts J1): a tear
  // inside it loses every one of them, and it is the ordinary crash tear.
  const dir = await tempDir("aio-journal-seal-batch-");
  try {
    const path = join(dir, "journal");
    await Deno.writeTextFile(
      path,
      `{"seq":1,"type":"add","payload":5,"ts":1}\n` +
        `{"seq":3,"type":"__aioBatch","fmt":2,"ts":2,"entries":[` +
        `{"seq":2,"type":"add","payload":7,"ts":2},{"seq":3,"type":"ad`,
    );
    let next = 0;
    const warned = await tornWarnings(() => {
      const j = createJournal(path);
      assertEquals(j.readSince(0).map((e) => e.seq), [1]);
      next = j.currentSeq() + 1;
    });
    assertEquals(next, 4, "the batch's seqs are never re-issued");
    assertEquals(warned.length, 1, warned.join("\n"));
    assertStringIncludes(warned[0]!, "crash mid-write");
    assertStringIncludes(warned[0]!, "2 entries lost");
    assert(!warned[0]!.includes("fused"), warned[0]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal: a real boot seals the torn tail before its first append", async () => {
  const dir = await tempDir("aio-journal-seal-boot-");
  const dbPath = join(dir, "data.db");
  const c = cell("jseal_counter", {
    state: { n: 0 },
    methods: {
      add(s: { n: number }, by: number) {
        s.n += by;
      },
    },
  });
  try {
    // run1 died after acking two adds, before the newline of the second.
    await Deno.writeTextFile(
      dbPath + ".journal",
      [5, 7].map((by, i) =>
        JSON.stringify({
          seq: i + 1,
          type: "jseal_counter:add",
          payload: { args: [by] },
          ts: i + 1,
        })
      ).join("\n"),
    );
    _resetAioRuntime();
    const app = await aio.run({
      cells: [c],
      appId: "jseal",
      journal: true,
      dbPath,
      persistDebounceMs: 999999,
      libraryMode: true,
      client: "server-only",
      baseDir: dir,
    });
    try {
      await (c as unknown as { add: (n: number) => Promise<void> }).add(9);
      assertEquals(
        (app.getState() as { jseal_counter: S }).jseal_counter.n,
        21,
      );
      const lines = (await Deno.readTextFile(dbPath + ".journal")).split("\n")
        .filter(Boolean);
      assertEquals(
        lines.map((l) => JSON.parse(l).seq),
        [1, 2, 3],
        `the acked add is on its own line:\n${lines.join("\n")}`,
      );
    } finally {
      await app.close();
      _resetAioRuntime();
    }
  } finally {
    await dropTempDir(dir);
  }
});
