// The sharded suite runner (scripts/test-shards.ts) and the changed-only
// runner (scripts/test-changed.ts): their pure planning functions.
import { assert, assertEquals } from "@std/assert";
import {
  failures,
  junitTimes,
  plan,
  REAL_WINDOW,
} from "../scripts/test-shards.ts";
import { relativeImports } from "../scripts/test-changed.ts";

Deno.test("plan: every file lands in exactly one shard", () => {
  const files = Array.from({ length: 50 }, (_, i) => `tests/f${i}.test.ts`);
  const shards = plan(files, 7, {}, () => false);
  assertEquals(shards.flat().sort(), [...files].sort());
});

Deno.test("plan: real-window files all go to shard 0, in their order", () => {
  const files = [
    "tests/a.test.ts",
    "tests/electron-ipc.test.ts",
    "tests/b.test.ts",
    "tests/e2e-ui-chromium.test.ts",
    "tests/video-capture.test.ts",
  ];
  const win = (f: string) => /electron|chromium|video/.test(f);
  const shards = plan(files, 4, {}, win);
  assertEquals(shards[0]!.slice(0, 3), [
    "tests/electron-ipc.test.ts",
    "tests/e2e-ui-chromium.test.ts",
    "tests/video-capture.test.ts",
  ]);
  for (const s of shards.slice(1)) assert(!s.some(win));
});

Deno.test("plan: balances by measured time (slowest first)", () => {
  const t = { "a.ts": 30, "b.ts": 20, "c.ts": 12, "d.ts": 8 };
  const shards = plan(Object.keys(t), 2, t, () => false);
  const load = (s: string[]) =>
    s.reduce((n, f) => n + t[f as keyof typeof t], 0);
  assertEquals(shards.map(load).sort((x, y) => x - y), [32, 38]); // b+c · a+d
});

Deno.test("plan: more shards than files leaves no empty shard", () => {
  assertEquals(plan(["x.test.ts"], 8, {}, () => false), [["x.test.ts"]]);
  assertEquals(plan([], 3, {}, () => false), []);
});

Deno.test("REAL_WINDOW: by what a test starts, not by its name", () => {
  for (
    const src of [
      "const env = testDisplayEnv();",
      'env: { DISPLAY: ":0" }',
      "if (Deno.env.get('ELECTRON_E2E'))",
    ]
  ) assert(REAL_WINDOW.test(src), src);
  // a stubbed Electron main: named "electron", opens nothing
  assert(!REAL_WINDOW.test('import { relay } from "../src/electron/x.ts";'));
  // headless Chromium: no display, nothing to overlap — parallel
  assert(!REAL_WINDOW.test('launchChromium(bin, ["--headless=new"])'));
});

Deno.test("junitTimes: sums testcases per file, strips ./", () => {
  const xml = `<testsuites><testsuite name="./tests/a.test.ts">
    <testcase name="one" classname="./tests/a.test.ts" time="0.5"/>
    <testcase name="two" classname="./tests/a.test.ts" time="1.25"></testcase>
    <testcase name="x" classname="./tests/b.test.ts" time="2"/>
    <testcase name="bad" classname="./tests/b.test.ts" time="NaN"/>
  </testsuite></testsuites>`;
  assertEquals(junitTimes(xml), {
    "tests/a.test.ts": 1.75,
    "tests/b.test.ts": 2,
  });
});

Deno.test("failures: top-level FAILED lines only, colour stripped", () => {
  const log = [
    "running 2 tests from ./tests/a.test.ts",
    "ok case ... \x1b[32mok\x1b[0m (1ms)",
    "bad case ... \x1b[31mFAILED\x1b[0m (2ms)",
    "  nested step ... FAILED (1ms)",
  ].join("\n");
  assertEquals(failures(log), ["bad case ... FAILED (2ms)"]);
});

Deno.test("failures: the closing FAILURES list wins — it names every kind", () => {
  const log = [
    "bad case ... FAILED (2ms)",
    "",
    "\x1b[1m FAILURES \x1b[0m",
    "",
    "bad case => ./tests/a.test.ts:3:6",
    "./tests/b.test.ts (uncaught error)",
    "",
    "FAILED | 1 passed | 2 failed (1s)",
  ].join("\n");
  assertEquals(failures(log), [
    "bad case => ./tests/a.test.ts:3:6",
    "./tests/b.test.ts (uncaught error)",
  ]);
});

Deno.test("failures: a shard where nothing ran reports deno's error line", () => {
  const log =
    "error: Import 'file:///x/tests/nope.test.ts' failed, not found.\n";
  assertEquals(failures(log), [
    "error: Import 'file:///x/tests/nope.test.ts' failed, not found.",
  ]);
});

Deno.test("relativeImports: static, re-export, dynamic, side-effect", () => {
  const src = [
    `import { a } from "./a.ts";`,
    `import type { B } from '../b.ts';`,
    `export * from "./c.ts";`,
    `import "./d.ts";`,
    `const m = await import("./e.ts");`,
    `import { x } from "@std/assert";`,
    `import {\n  y,\n  z,\n} from "./multi.ts";`,
  ].join("\n");
  assertEquals(relativeImports(src).sort(), [
    "../b.ts",
    "./a.ts",
    "./c.ts",
    "./d.ts",
    "./e.ts",
    "./multi.ts",
  ]);
});
