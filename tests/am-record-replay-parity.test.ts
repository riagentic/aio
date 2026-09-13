// A test `am record` generates must reach the state the recorded app reached —
// not a state the app never had.
//
// Measured on one cell (an `onInit` that dispatches an async `scan`, two
// overlapping calls of a read-await-write method, a scheduled `inc`): the live
// app ended `{ n: 11, scans: 1, hist: [scan, race1, race1, inc] }`, and the
// test generated from its timeline ended `{ n: 12, scans: 2, hist: [scan,
// scan, race1, race2, inc] }`. Three separate defects:
//
//  • The `onInit` dispatch was recorded as an INPUT (cause absent), so the
//    generated test called `scan()` — and `bootCells` ran the cell's own
//    `onInit`, which dispatched it again. Boot re-creates what `onInit`
//    dispatches; it is `cause: "effect"`, exactly like a timer a method arms.
//  • The two calls OVERLAPPED live (both read `n` before either wrote it — a
//    lost update) and were replayed one `await` after another, which cannot
//    lose the update. Each write-set now names the call whose run produced it
//    (`call`), so the generator knows a later call started before an earlier
//    one finished writing, and starts them together (`Promise.all`).
//  • The header said "replay of 7 actions" for four calls: it counted the
//    `h.advance(…)` lines it had emitted for pacing.
//
// Proven the only way that counts: record a real app, generate, `deno check`
// and `deno test` the output, and require the live end state.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { generateReplayTest, timelineActions } from "../src/am/record.ts";
import type { TimelineEntry } from "../src/server/timeline.ts";

const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CELL = `import { cell, schedule, self } from "aio";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const rc = cell("rc", {
  state: { n: 0, scans: 0, hist: [] as string[] },
  onInit(app) { app.dispatch({ type: "rc:scan", payload: {} }); },
  methods: {
    async scan(s) { await sleep(5); s.scans++; s.hist.push("scan"); },
    async raceRead(s) { const v = s.n; await sleep(30); s.n = v + 1; s.hist.push("race" + s.n); },
    later(s) { s.$do(schedule.after("l", 50, self("inc"))); },
    inc(s) { s.n += 10; s.hist.push("inc"); },
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("am record: an onInit dispatch, an overlapping pair and a timer replay to the live state", async () => {
  const dir = await tempDir("am-record-parity-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "tests"));
    const cellFile = join(dir, "src", "rc.ts");
    await Deno.writeTextFile(cellFile, CELL);

    _resetAioRuntime();
    const { rc } = await import(`file://${cellFile}`);
    const port = freePort();
    const app = await aio.run({
      cells: [rc],
      appId: `record-parity-${Deno.pid}`,
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
      const post = async (type: string) => {
        const r = await fetch(
          `http://127.0.0.1:${port}/__aio/trojan/dispatch`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-AIO": "1" },
            body: JSON.stringify({ type, payload: { args: [] } }),
          },
        );
        await r.body?.cancel();
      };
      await sleep(60); // onInit's scan lands
      // Two clients, the same instant: both read n = 0.
      await Promise.all([post("rc:raceRead"), post("rc:raceRead")]);
      await sleep(80); // both write-sets land
      await post("rc:later");
      await sleep(120); // the scheduled inc lands
      live = JSON.parse(
        JSON.stringify({ n: rc.n, scans: rc.scans, hist: rc.hist }),
      );
      entries = ((await (await fetch(
        `http://127.0.0.1:${port}/__aio/trojan/timeline`,
      )).json()) as { entries: TimelineEntry[] }).entries;
    } finally {
      await app.close();
      _resetAioRuntime();
    }
    assertEquals(
      live,
      { n: 11, scans: 1, hist: ["scan", "race1", "race1", "inc"] },
      "the live run lost the update (the premise of this test)",
    );
    const scan = entries.find((e) => e.type === "rc:scan");
    assertEquals(
      scan?.cause,
      "effect",
      `boot re-runs onInit, so its dispatch is caused: ${JSON.stringify(scan)}`,
    );

    const test = generateReplayTest(timelineActions(entries), {
      name: "flow",
      source: "the running app's timeline",
    }).replace(
      /\s*\/\/ TODO: assert final state.*\n/,
      `\n  assertEquals(JSON.parse(JSON.stringify({ n: rc.n, scans: rc.scans, ` +
        `hist: rc.hist })), ${JSON.stringify(live)});\n`,
    );
    assert(
      !test.includes("rc.scan()"),
      `onInit's scan is not called:\n${test}`,
    );
    assertStringIncludes(test, "Promise.all([");
    assertStringIncludes(test, "replay of 3 actions");
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

Deno.test("generateReplayTest: calls whose runs overlapped start together; the header counts calls", () => {
  const src = generateReplayTest([
    { type: "c:a", payload: { args: [], _callId: "A" }, ts: 0 },
    { type: "c:b", payload: { args: [], _callId: "B" }, ts: 1 },
    { type: "c:__setA", cause: "effect", call: "A", ts: 20 },
    { type: "c:__setB", cause: "effect", call: "B", ts: 21 },
    { type: "c:tick", cause: "effect", ts: 40 },
    { type: "c:d", payload: { args: [2] }, ts: 50 },
    { type: "c:e", payload: { args: [], _callId: "E" }, ts: 60 },
    // Started after E's run left its last trace: sequential.
    { type: "c:__setE", cause: "effect", call: "E", ts: 70 },
    { type: "c:f", payload: { args: [], _callId: "F" }, ts: 80 },
  ]);
  assertStringIncludes(
    src,
    "  await Promise.all([\n    c.a(),\n    c.b(),\n  ]);\n",
  );
  assertStringIncludes(src, "  await c.d(2);\n");
  assertStringIncludes(src, "  await c.e();\n");
  assertStringIncludes(src, "  await c.f();\n");
  assert(!/Promise\.all\(\[\n\s+c\.e\(\)/.test(src), src);
  assertStringIncludes(src, "replay of 5 actions");
});

Deno.test("generateReplayTest: a call that threw inside an overlapping group still asserts the rejection", () => {
  const src = generateReplayTest([
    { type: "c:a", payload: { args: [], _callId: "A" }, threw: true },
    { type: "c:b", payload: { args: [1], _callId: "B" } },
    { type: "c:__setA", cause: "effect", call: "A" },
  ]);
  assertStringIncludes(
    src,
    "  await Promise.all([\n    assertRejects(() => c.a()), // threw in the recorded run\n    c.b(1),\n  ]);\n",
  );
  assertStringIncludes(src, "assertRejects } from");
});

Deno.test("generateReplayTest: an argument JSON cannot spell is still a valid literal", () => {
  const src = generateReplayTest([
    { type: "c:m", payload: { args: [1, undefined, 2] } },
    { type: "c:n", payload: { args: [undefined] } },
    { type: "c:o", payload: { args: [[undefined, 3n], { k: undefined }] } },
  ]);
  // `c.m(1, , 2)` is a syntax error; `c.n()` changes the arity.
  assertStringIncludes(src, "await c.m(1, undefined, 2);");
  assertStringIncludes(src, "await c.n(undefined);");
  assertStringIncludes(src, 'await c.o([undefined,3n], {"k":undefined});');
});

// A call made from inside another call's run is part of the OUTER call: the
// outer one is not over until the inner one it awaits is. Attributed to the
// inner call's own id, an outer method whose only writes come from the call it
// awaits read as over at its first line, and a call that overlapped it was
// replayed after it.
Deno.test("timeline: a nested call's write-set names the OUTER call; a timer it armed names none", async () => {
  const dir = await tempDir("am-record-nested-");
  try {
    const cellFile = join(dir, "nest.ts");
    await Deno.writeTextFile(
      cellFile,
      `import { cell, schedule, self } from "${
        new URL("../mod.ts", import.meta.url).pathname
      }";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const nest = cell("nest", {
  state: { n: 0, t: 0 },
  methods: {
    async outer(s) { await (nest as any).inner(); s.$do(schedule.after("t", 10, self("tick"))); },
    async inner(s) { await sleep(5); s.n++; },
    tick(s) { s.t++; },
  },
});
`,
    );
    _resetAioRuntime();
    const { nest } = await import(`file://${cellFile}`);
    const port = freePort();
    const app = await aio.run({
      cells: [nest],
      appId: `record-nested-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      dbPath: ":memory:",
    } as never);
    let entries: TimelineEntry[];
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ type: "nest:outer", payload: { args: [] } }),
      });
      await r.body?.cancel();
      await sleep(80);
      entries = ((await (await fetch(
        `http://127.0.0.1:${port}/__aio/trojan/timeline`,
      )).json()) as { entries: TimelineEntry[] }).entries;
    } finally {
      await app.close();
      _resetAioRuntime();
    }
    const outerId = (entries.find((e) => e.type === "nest:outer")?.payload as {
      _callId?: string;
    })?._callId;
    assert(outerId, JSON.stringify(entries));
    const byType = (t: string) => entries.find((e) => e.type === t);
    assertEquals(byType("nest:inner")?.call, outerId, JSON.stringify(entries));
    assertEquals(byType("nest:__setInner")?.call, outerId);
    assertEquals(byType("nest:tick")?.cause, "effect");
    assertEquals(
      byType("nest:tick")?.call,
      undefined,
      "a timer is not the run",
    );
  } finally {
    await dropTempDir(dir);
  }
});

// A tick of the APP's `schedules:` stays an INPUT — the one boot-time source
// that is not `effect`. `bootCells` boots cells, not the app config, so nothing
// in a generated test re-creates the tick: tagged `effect`, `am record` dropped
// it and the test ended short of the live state. (A cell's `onInit` is the
// opposite case — every harness runs it — see the first test.)
Deno.test("am record: a config schedules: tick is an input, and the replay reaches the live state", async () => {
  const dir = await tempDir("am-record-cfgsched-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "tests"));
    const cellFile = join(dir, "src", "sc.ts");
    await Deno.writeTextFile(
      cellFile,
      `import { cell } from "aio";
export const sc = cell("sc", {
  state: { n: 0, hist: [] as string[] },
  methods: {
    bump(s) { s.n *= 2; s.hist.push("bump"); },
    add(s, by: number) { s.n += by; s.hist.push("add"); },
  },
});
`,
    );
    _resetAioRuntime();
    const { sc } = await import(`file://${cellFile}`);
    const port = freePort();
    const app = await aio.run({
      cells: [sc],
      appId: `record-cfgsched-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      dbPath: ":memory:",
      schedules: [{
        id: "bump",
        after: 60,
        action: { type: "sc:bump", payload: { args: [] } },
      }],
    } as never);
    let live: unknown;
    let entries: TimelineEntry[];
    try {
      const post = async (by: number) => {
        const r = await fetch(
          `http://127.0.0.1:${port}/__aio/trojan/dispatch`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-AIO": "1" },
            body: JSON.stringify({ type: "sc:add", payload: { args: [by] } }),
          },
        );
        await r.body?.cancel();
      };
      await post(3);
      await sleep(150); // the tick lands
      await post(1);
      live = JSON.parse(JSON.stringify({ n: sc.n, hist: sc.hist }));
      entries = ((await (await fetch(
        `http://127.0.0.1:${port}/__aio/trojan/timeline`,
      )).json()) as { entries: TimelineEntry[] }).entries;
    } finally {
      await app.close();
      _resetAioRuntime();
    }
    assertEquals(live, { n: 7, hist: ["add", "bump", "add"] });
    const tick = entries.find((e) => e.type === "sc:bump");
    assertEquals(tick?.cause, undefined, JSON.stringify(tick));

    const test = generateReplayTest(timelineActions(entries), {
      name: "flow",
    }).replace(
      /\s*\/\/ TODO: assert final state.*\n/,
      `\n  assertEquals(JSON.parse(JSON.stringify({ n: sc.n, hist: sc.hist })), ` +
        `${JSON.stringify(live)});\n`,
    );
    assertStringIncludes(test, "await sc.bump();");
    const file = join(dir, "tests", "flow.test.ts");
    await Deno.writeTextFile(file, test);
    const run = await deno(["test", "-A", file], dir);
    assertEquals(run.code, 0, `replay:\n${run.text}\n${test}`);
  } finally {
    await dropTempDir(dir);
  }
});
