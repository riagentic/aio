// `am timeline` / `am replay` CLI (risoto #4): range parsing, offline journal
// rendering, and dry-run replay. Live paths hit a running app's trojan channel
// (covered in am-timeline-e2e + timeline route tests); here we cover the pure
// logic and the file-driven offline modes deterministically.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  cmdReplay,
  cmdTimeline,
  parseRange,
} from "../src/am/am-cmd-timeline.ts";
import { parseJournalEntries } from "../src/am/record.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const FLAGS = { json: true } as unknown as GlobalFlags;

/** Capture JSON printed via console.log during `fn`. */
async function capture(fn: () => Promise<void>): Promise<unknown> {
  const orig = console.log;
  let captured: unknown;
  console.log = (v: unknown) => {
    captured = typeof v === "string" ? safeJson(v) : v;
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return captured;
}
const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

async function withJournal(
  lines: unknown[],
  fn: (path: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "data.db.journal");
  await Deno.writeTextFile(
    path,
    lines.map((l) => JSON.stringify(l)).join("\n"),
  );
  try {
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ── parseRange ───────────────────────────────────────────────────────────────

Deno.test("parseRange: N..M is inclusive", () => {
  assertEquals(parseRange("5..12"), { lo: 5, hi: 12 });
});
Deno.test("parseRange: single N is just that seq", () => {
  assertEquals(parseRange("7"), { lo: 7, hi: 7 });
});
Deno.test("parseRange: absent → everything", () => {
  assertEquals(parseRange(undefined), { lo: -Infinity, hi: Infinity });
});
Deno.test("parseRange: garbage → NaN sentinel", () => {
  const r = parseRange("abc");
  assert(Number.isNaN(r.lo) && Number.isNaN(r.hi));
});

// ── parseJournalEntries (seq preserved) ──────────────────────────────────────

Deno.test("parseJournalEntries: keeps seq + ts, sorts, drops torn tail", () => {
  const text = [
    JSON.stringify({ seq: 2, type: "c:b", payload: { args: [2] }, ts: 20 }),
    JSON.stringify({ seq: 1, type: "c:a", payload: { args: [1] }, ts: 10 }),
    '{"seq":3,"type":"c:c","payl',
  ].join("\n");
  const rows = parseJournalEntries(text);
  assertEquals(rows.map((r) => r.seq), [1, 2]);
  assertEquals(rows[0]!.ts, 10);
});

// ── cmdTimeline --from (offline) ─────────────────────────────────────────────

Deno.test("cmdTimeline --from: renders journal rows (no diffs offline)", async () => {
  await withJournal([
    { seq: 1, type: "counter:inc", payload: { args: [1] }, ts: 100 },
    { seq: 2, type: "counter:inc", payload: { args: [2] }, ts: 200 },
  ], async (path) => {
    const res = await capture(() => cmdTimeline([`--from=${path}`], FLAGS)) as {
      entries: { seq: number; type: string }[];
    };
    assertEquals(res.entries.length, 2);
    assertEquals(res.entries[1]!.type, "counter:inc");
  });
});

Deno.test("cmdTimeline --from with --lines keeps only the last N", async () => {
  await withJournal([
    { seq: 1, type: "c:a", payload: {}, ts: 1 },
    { seq: 2, type: "c:b", payload: {}, ts: 2 },
    { seq: 3, type: "c:c", payload: {}, ts: 3 },
  ], async (path) => {
    const res = await capture(() =>
      cmdTimeline(
        [`--from=${path}`],
        { json: true, lines: 2 } as unknown as GlobalFlags,
      )
    ) as { entries: { seq: number }[] };
    assertEquals(res.entries.map((e) => e.seq), [2, 3]);
  });
});

// ── cmdReplay --dry ──────────────────────────────────────────────────────────

Deno.test("cmdReplay --dry: lists the range without dispatching", async () => {
  await withJournal([
    { seq: 1, type: "c:a", payload: {}, ts: 1 },
    { seq: 2, type: "c:b", payload: {}, ts: 2 },
    { seq: 3, type: "c:c", payload: {}, ts: 3 },
  ], async (path) => {
    const res = await capture(() =>
      cmdReplay([`--from=${path}`, "2..3", "--dry"], FLAGS)
    ) as { dryRun: boolean; count: number; entries: { seq: number }[] };
    assertEquals(res.dryRun, true);
    assertEquals(res.count, 2);
    assertEquals(res.entries.map((e) => e.seq), [2, 3]);
  });
});

Deno.test("cmdReplay --dry: a single-seq range selects one action", async () => {
  await withJournal([
    { seq: 1, type: "c:a", payload: {}, ts: 1 },
    { seq: 2, type: "c:b", payload: {}, ts: 2 },
  ], async (path) => {
    const res = await capture(() =>
      cmdReplay([`--from=${path}`, "2", "--dry"], FLAGS)
    ) as { count: number; entries: { type: string }[] };
    assertEquals(res.count, 1);
    assertEquals(res.entries[0]!.type, "c:b");
  });
});
