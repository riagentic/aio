// `am replay` sends the INPUTS of a run — never what those inputs caused.
//
// Replay re-dispatches journal rows against a live app, and the live app's own
// machinery re-creates everything a replayed action causes. Two failures came
// from sending those rows as well, both measured:
//
//  • an async method's `cell:__setX` write-set row HALTED the run ("framework-
//    internal action type … not dispatchable from trojan") right after
//    `--dry` had promised N actions — and accepting it would double-apply,
//    because re-running the method already re-applies its writes;
//  • a schedule-born action applied TWICE: `later(4)` arms a timer that
//    dispatches `inc(4)`; replaying both gave +9 and a history of `4, 4`,
//    where the run had +5.
//
// The journal now records each action's `cause` (`input` | `effect`), by
// provenance, and replay sends inputs only. Proven end to end: a real run
// writes the journal, a fresh app receives the replay, and the two states
// must be equal.
import { assert, assertEquals } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { schedule, self } from "../mod.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { cmdReplay, planReplay } from "../src/am/am-cmd-timeline.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";
import type { JournalRow } from "../src/am/record.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RS = { n: number; hist: number[]; label: string };

function makeCell() {
  return cell("rp", {
    state: { n: 0, hist: [] as number[], label: "" },
    methods: {
      inc(s, by: number) {
        s.n += by;
        s.hist.push(by);
      },
      later(s, by: number) {
        s.n += 1;
        s.$do(schedule.after("rp-later", 20, self("inc", by)));
      },
      async slow(s, by: number) {
        s.n += by;
        await sleep(10);
        s.hist.push(-by);
        s.label = "slow" + by;
      },
    },
  });
}

async function boot(dir: string, appId: string, port: number) {
  _resetAioRuntime();
  const c = makeCell();
  const app = await aio.run({
    cells: [c],
    appId,
    journal: true,
    dbPath: `${dir}/state.db`,
    // No snapshot during the run, so the journal keeps every row.
    persistDebounceMs: 999_999,
    libraryMode: true,
    singleton: false,
    client: "server-only",
    port,
    baseDir: dir,
  } as never);
  return { c: c as unknown as RS, app };
}

const post = async (port: number, type: string, args: unknown[]) => {
  const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ type, payload: { args } }),
  });
  assertEquals(r.status, 200, await r.text());
};

async function capture(fn: () => Promise<void>): Promise<unknown> {
  const orig = console.log;
  let captured: unknown;
  console.log = (v: unknown) => {
    captured = typeof v === "string" ? JSON.parse(v) : v;
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return captured;
}

Deno.test("am replay: a run with a schedule-born action and an async write-set replays to the same state", async () => {
  const srcDir = await tempDir("aio-replay-src-");
  const srcPort = freePort();
  const src = await boot(srcDir, `replay-src-${Deno.pid}`, srcPort);
  let expected: RS;
  let journalPath: string;
  try {
    await post(srcPort, "rp:later", [4]);
    await sleep(120); // the timer fires inc(4)
    await post(srcPort, "rp:slow", [3]);
    await sleep(80); // the write-set commits
    await post(srcPort, "rp:inc", [2]);
    expected = JSON.parse(JSON.stringify({
      n: src.c.n,
      hist: src.c.hist,
      label: src.c.label,
    }));
    assertEquals(expected.n, 1 + 4 + 3 + 2, "the source run itself");
    // Copied BEFORE the stop: a clean stop's final snapshot compacts it.
    journalPath = `${srcDir}/captured.journal`;
    await Deno.copyFile(`${srcDir}/state.db.journal`, journalPath);
    const rows = (await Deno.readTextFile(journalPath)).trim().split("\n")
      .map((l) => JSON.parse(l) as JournalRow & { cause?: string });
    const causes = rows.map((r) =>
      `${r.type}(${(r.payload as { args?: unknown[] })?.args ?? ""}):${r.cause}`
    );
    // The async body commits once per await boundary — how many write-sets
    // is the batcher's business; that every one is effect-born is not.
    assert(
      causes.some((c) => c === "rp:__setSlow():effect") &&
        causes.filter((c) => c.startsWith("rp:__setSlow")).every((c) =>
          c.endsWith(":effect")
        ),
      causes.join("\n"),
    );
    assertEquals(
      causes.filter((c) => !c.startsWith("rp:__setSlow")),
      [
        "rp:later(4):input",
        "rp:inc(4):effect",
        "rp:slow(3):input",
        "rp:inc(2):input",
      ],
      "every journal row says what caused it",
    );
  } finally {
    await src.app.close();
  }

  // --dry and the real run count the SAME rows.
  const dry = await capture(() =>
    cmdReplay([`--from=${journalPath}`, "--dry"], {
      json: true,
    } as unknown as GlobalFlags)
  ) as {
    count: number;
    entries: { type: string }[];
    notSent: { type: string; reason: string }[];
  };
  assertEquals(dry.count, 3);
  assertEquals(dry.entries.map((e) => e.type), [
    "rp:later",
    "rp:slow",
    "rp:inc",
  ]);
  assertEquals(
    [...new Set(dry.notSent.map((k) => `${k.type}:${k.reason}`))],
    ["rp:inc:effect", "rp:__setSlow:write-set"],
  );

  const dstDir = await tempDir("aio-replay-dst-");
  const dstPort = freePort();
  const dstId = `replay-dst-${Deno.pid}`;
  const dst = await boot(dstDir, dstId, dstPort);
  try {
    const res = await capture(() =>
      cmdReplay([`--from=${journalPath}`], {
        json: true,
        port: dstPort,
        app: dstId,
      } as unknown as GlobalFlags)
    ) as { replayed: number; results: { ok: boolean }[] };
    assertEquals(res.replayed, 3, JSON.stringify(res));
    assert(res.results.every((r) => r.ok), JSON.stringify(res));
    await sleep(150); // the replayed `later` re-arms its own timer
    assertEquals(
      { n: dst.c.n, hist: [...dst.c.hist], label: dst.c.label },
      expected,
      "the replayed app must reach the state the run reached — +9 and " +
        "`4, 4` is the schedule-born inc sent a second time",
    );
  } finally {
    await dst.app.close();
    _resetAioRuntime();
  }
});

Deno.test("planReplay: a journal written before `cause` existed still skips internal rows, and says the rest are unattributed", () => {
  const plan = planReplay([
    { seq: 1, type: "c:later", payload: { args: [4] } },
    { seq: 2, type: "c:inc", payload: { args: [4] } },
    { seq: 3, type: "c:__setSlow", payload: {} },
    { seq: 4, type: "aio:__timeTravel", payload: { cmd: "undo", cells: {} } },
  ]);
  assertEquals(plan.send.map((r) => r.seq), [1, 2]);
  assertEquals(plan.skip.map((k) => k.reason), ["write-set", "time-travel"]);
  assertEquals(plan.unattributed, 2);
});
