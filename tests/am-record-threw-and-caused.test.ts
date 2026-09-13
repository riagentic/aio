// What `am record` generates from a LIVE run must reproduce that run — even
// when a call in it threw, and when one action caused another.
//
//  • An async call that rejected was emitted as a bare
//    `await counter.slowThrow(1);`, so the generated test failed on the line
//    that faithfully reproduced the run. The timeline never learned the call
//    threw: the failure is a separate `__error` frame, which carried only the
//    method name. It now carries the `_callId`, the timeline marks the call,
//    and the generator emits `assertRejects`.
//  • An action a `$do` dispatched was emitted beside the call that dispatched
//    it, so the test applied it twice.
//
// Proven the only way that counts: record a real app, write the test, run
// `deno check` and `deno test` on it, and require the state it ends in to be
// the state the live app ended in.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { generateReplayTest, timelineActions } from "../src/am/record.ts";
import type { TimelineEntry } from "../src/server/timeline.ts";

const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CELL = `import { cell, schedule, self } from "aio";
export const counter = cell("counter", {
  state: { count: 0, hist: [] as number[] },
  methods: {
    inc(s, by: number) { s.count += by; s.hist.push(by); },
    twice(s, by: number) { s.count += 1; s.$do(schedule.next("twice", self("inc", by))); },
    async slowThrow(s, n: number) {
      s.count += n;
      await new Promise((r) => setTimeout(r, 5));
      s.hist.push(1000 + n);
      throw new Error("slowThrow");
    },
  },
});
`;

async function deno(args: string[], cwd: string) {
  const o = await new Deno.Command(Deno.execPath(), {
    args: [args[0]!, "--config", CONFIG, ...args.slice(1)],
    cwd,
    env: { ...Deno.env.toObject(), NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return { code: o.code, text: d.decode(o.stdout) + d.decode(o.stderr) };
}

Deno.test("am record: a live run with a thrown async call and a $do-born action generates a test that runs to the live state", async () => {
  const dir = await tempDir("am-record-threw-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "tests"));
    const cellFile = join(dir, "src", "counter.ts");
    await Deno.writeTextFile(cellFile, CELL);

    _resetAioRuntime();
    const { counter } = await import(`file://${cellFile}`);
    const port = freePort();
    const app = await aio.run({
      cells: [counter],
      appId: `record-threw-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      dbPath: ":memory:",
    } as never);
    let live: unknown;
    let entries: TimelineEntry[];
    try {
      const post = async (type: string, args: unknown[]) => {
        const r = await fetch(
          `http://127.0.0.1:${port}/__aio/trojan/dispatch`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-AIO": "1" },
            body: JSON.stringify({ type, payload: { args } }),
          },
        );
        await r.body?.cancel();
      };
      await post("counter:inc", [2]);
      await post("counter:slowThrow", [1]);
      await new Promise((r) => setTimeout(r, 60)); // the rejection lands
      await post("counter:twice", [5]);
      await new Promise((r) => setTimeout(r, 60)); // the scheduled inc lands
      await post("counter:inc", [3]);
      live = JSON.parse(
        JSON.stringify({ count: counter.count, hist: counter.hist }),
      );
      entries = ((await (await fetch(
        `http://127.0.0.1:${port}/__aio/trojan/timeline`,
      )).json()) as { entries: TimelineEntry[] }).entries;
    } finally {
      await app.close();
      _resetAioRuntime();
    }

    const call = entries.find((e) => e.type === "counter:slowThrow");
    assert(
      call?.threw,
      `the call that rejected is marked: ${JSON.stringify(call)}`,
    );
    const born = entries.filter((e) => e.type === "counter:inc");
    assertEquals(
      born.map((e) => e.cause ?? "input"),
      ["input", "effect", "input"],
      "the $do-dispatched inc says it was caused",
    );

    const test = generateReplayTest(timelineActions(entries), {
      name: "flow",
      source: "the running app's timeline",
    }).replace(
      /\s*\/\/ TODO: assert final state.*\n/,
      `\n  assertEquals(JSON.parse(JSON.stringify({ count: counter.count, ` +
        `hist: counter.hist })), ${JSON.stringify(live)});\n`,
    );
    assert(test.includes("assertRejects(() => counter.slowThrow(1))"), test);
    const file = join(dir, "tests", "flow.test.ts");
    await Deno.writeTextFile(file, test);

    const check = await deno(["check", file], dir);
    assertEquals(check.code, 0, `deno check failed:\n${check.text}\n${test}`);
    const run = await deno(["test", "-A", file], dir);
    assertEquals(
      run.code,
      0,
      `the generated test must reproduce the live state:\n${run.text}\n${test}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});
