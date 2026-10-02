// The sharded suite runner (scripts/test-shards.ts) and the changed-only
// runner (scripts/test-changed.ts): their pure planning functions.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  cpuFence,
  expandDirs,
  failures,
  followShard,
  freeCores,
  headerTracker,
  junitTimes,
  lastHeader,
  plan,
  pumpToLog,
  quietMsOf,
  quietWatch,
  REAL_WINDOW,
  shardsOf,
  unrunFiles,
  wholeNumber,
} from "../scripts/test-shards.ts";
import { relativeImports } from "../scripts/test-changed.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

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

Deno.test("failures: intentional worker-crash Uncaught is not a failure after ok", () => {
  const log = [
    "worker crash: enable() keeps the cell's last committed state ... ok (50ms)",
    "ok | 4 passed | 0 failed (2s)",
    'error: Uncaught (in worker "aio-cell:wcr@test-abc") Error: worker loop died',
    'error: Uncaught (in worker "aio-cell:wdiff@test-def") Error: worker loop died',
    'error: Uncaught (in worker "aio-cell:boomcell") (in promise) Error: worker died on load',
    "error: Import 'file:///x/tests/nope.test.ts' failed, not found.",
  ].join("\n");
  assertEquals(failures(log), [
    "error: Import 'file:///x/tests/nope.test.ts' failed, not found.",
  ]);
});

Deno.test("failures: worker-crash Uncaught still counts when the suite did not pass", () => {
  const log =
    'error: Uncaught (in worker "aio-cell:wcr@test-abc") Error: worker loop died\n';
  assertEquals(failures(log), [
    'error: Uncaught (in worker "aio-cell:wcr@test-abc") Error: worker loop died',
  ]);
});

Deno.test("failures: intentional minify typecheck error is not a failure after ok", () => {
  const log = [
    "minify: a type error in the ORIGINAL still fails the build, and no stage is left ... ok (2s)",
    "ok | 2 passed | 0 failed (3s)",
    "error: Type checking failed.",
    "error: Import 'file:///x/tests/nope.test.ts' failed, not found.",
  ].join("\n");
  assertEquals(failures(log), [
    "error: Import 'file:///x/tests/nope.test.ts' failed, not found.",
  ]);
});

Deno.test("failures: Type checking failed still counts when the suite did not pass", () => {
  assertEquals(failures("error: Type checking failed.\n"), [
    "error: Type checking failed.",
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

Deno.test("cpuFence: a run leaves the first cores free and runs niced", () => {
  const all = { taskset: true, nice: true };
  // 32 cores, 4 kept free: pinned to 4-31, 28 usable — the shard count is
  // derived from `usable`, not from the whole machine.
  assertEquals(cpuFence(32, 4, "linux", all), {
    usable: 28,
    prefix: ["taskset", "-c", "4-31", "nice", "-n", "10"],
  });
  // No taskset (or not linux): nice alone, still fewer shards.
  assertEquals(cpuFence(32, 4, "darwin", all).prefix, ["nice", "-n", "10"]);
  assertEquals(
    cpuFence(32, 4, "linux", { taskset: false, nice: true }).usable,
    28,
  );
  // A machine smaller than the reserve still runs — on one core, unpinned.
  assertEquals(cpuFence(4, 4, "linux", all), {
    usable: 1,
    prefix: ["nice", "-n", "10"],
  });
  // Never EVERY core, whatever is asked: reserving zero still leaves one for
  // the OS/desktop (system stability), a negative request clamps, and a
  // non-finite one does too. This is the setting that used to pin 0-(n-1).
  assertEquals(cpuFence(32, 0, "linux", all), {
    usable: 31,
    prefix: ["taskset", "-c", "1-31", "nice", "-n", "10"],
  });
  assertEquals(cpuFence(32, -4, "linux", all).usable, 31);
  assertEquals(cpuFence(32, NaN, "linux", all).usable, 31);
});

Deno.test("freeCores: AIO_TEST_FREE_CORES is a whole number, or the run refuses", () => {
  assertEquals(freeCores(undefined), 4);
  assertEquals(freeCores("0"), 0);
  assertEquals(freeCores("20"), 20);
  // `Number("abc")` is NaN, and the fence reads a non-finite request as "keep
  // one core": a typo took 31 of 32 cores and said nothing.
  for (const bad of ["abc", "", " ", "1.5", "-2", "4 cores", "0x4", "NaN"]) {
    assertThrows(() => freeCores(bad), Error, "AIO_TEST_FREE_CORES", bad);
  }
});

Deno.test("unrunFiles: every listed file must be SEEN running — a green summary does not say so", () => {
  // What deno 2.9 prints (measured), colour and all.
  const log = [
    "note ./tests/exit.test.ts called `Deno.exit(0)` from outside any test. " +
    "The isolate was terminated; remaining test files will continue.",
    "\x1b[0m\x1b[38;5;245mrunning 1 test from ./tests/a.test.ts\x1b[0m",
    "a ... ok (1ms)",
    "running 0 tests from ./tests/none.test.ts",
    "running 0 tests from ./tests/empty.test.ts",
    "running 2 tests from ./tests/ignored.test.ts",
    "x ... ignored (0ms)",
    "y ... ignored (0ms)",
    "running 12 tests from ./amui/src/b.test.tsx",
    "",
    "ok | 13 passed | 0 failed | 2 ignored (9ms)",
  ].join("\n");
  const blank = (f: string) => f === "tests/empty.test.ts";
  const judge = (...files: string[]) => unrunFiles(log, files, blank);
  assertEquals(
    judge("tests/a.test.ts", "amui/src/b.test.tsx", "tests/ignored.test.ts"),
    [],
  );
  // However the file was named on the command line.
  assertEquals(judge("./tests/a.test.ts", "tests\\a.test.ts"), []);
  const at = (root: string, ...files: string[]) =>
    unrunFiles(log, files, blank, root);
  assertEquals(
    at(
      "/r/repo",
      "/r/repo/tests/a.test.ts",
      "tests/../tests/a.test.ts",
      "./tests/./a.test.ts",
      "/r/repo/amui/../amui/src/b.test.tsx",
    ),
    [],
  );
  // The same name under another root is another file.
  assert(
    at("/r/repo", "/r/other/tests/a.test.ts")[0]!.includes("never started"),
  );
  // A path with a space is one path, in a header and in a note.
  const spaced = "running 1 test from ./tests/sp ace/i.test.ts\n" +
    "note ./tests/sp ace/x.test.ts called `Deno.exit(0)` from outside any test.";
  assertEquals(unrunFiles(spaced, ["tests/sp ace/i.test.ts"], blank), []);
  assert(
    unrunFiles(spaced, ["tests/sp ace/x.test.ts"], blank)[0]!
      .includes("called Deno.exit(0)"),
  );
  // A file with nothing in it has nothing to run — the one exception.
  assertEquals(judge("tests/empty.test.ts"), []);
  const one = (file: string) => {
    const out = judge("tests/a.test.ts", file);
    assertEquals(out.length, 1, file);
    return out[0]!;
  };
  assert(
    one("tests/exit.test.ts").startsWith(
      "tests/exit.test.ts called Deno.exit(0) outside any test",
    ),
  );
  assert(
    one("tests/none.test.ts").startsWith("tests/none.test.ts ran 0 tests"),
  );
  assert(
    one("tests/gone.test.ts").startsWith("tests/gone.test.ts never started"),
  );
  // A header for ANOTHER file is not this one's.
  assert(one("tests/a.test.tsx").includes("never started"));
  // An exit AFTER its tests were listed still ended the file early.
  assert(
    unrunFiles(
      "running 3 tests from ./tests/late.test.ts\n" +
        "note ./tests/late.test.ts called `Deno.exit(0)` from outside any test.",
      ["tests/late.test.ts"],
      blank,
    )[0]!.includes("called Deno.exit(0)"),
  );
});

Deno.test("expandDirs: a directory argument is the test files under it, so each is judged by name", async () => {
  const root = await tempDir("aio-shards-dirs-");
  try {
    const put = async (rel: string) => {
      await Deno.mkdir(join(root, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(root, rel), "");
    };
    for (
      const rel of [
        "tests/sub/a.test.ts",
        "tests/sub/deep/b_test.tsx",
        "tests/sub/helper.ts",
        "tests/sub/node_modules/x.test.ts",
        "tests/sub/.hidden/y.test.ts",
        "tests/top.test.ts",
      ]
    ) await put(rel);
    assertEquals(await expandDirs(["tests/sub"], root), [
      "tests/sub/a.test.ts",
      "tests/sub/deep/b_test.tsx",
    ]);
    // Absolute, and beside a file: a file stays as it was named, a path that
    // does not exist stays for deno to refuse, nothing is listed twice.
    assertEquals(
      await expandDirs(
        [
          join(root, "tests/sub/deep"),
          "tests/top.test.ts",
          "tests/gone.test.ts",
          "tests/sub",
        ],
        root,
      ),
      [
        "tests/sub/deep/b_test.tsx",
        "tests/top.test.ts",
        "tests/gone.test.ts",
        "tests/sub/a.test.ts",
      ],
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("lastHeader / headerTracker: the file a shard is in, however its output is cut into chunks", () => {
  const one =
    "\x1b[0m\x1b[38;5;245mrunning 1 test from ./tests/a.test.ts\x1b[0m";
  const many = "running 12 tests from ./amui/src/b c.test.tsx";
  assertEquals(lastHeader(""), null);
  assertEquals(
    lastHeader("a ... ok (1ms)\nnot running 2 tests from x\n"),
    null,
  );
  assertEquals(
    lastHeader(`${one}\na ... ok\n`),
    "running 1 test from ./tests/a.test.ts",
  );
  assertEquals(lastHeader(`${one}\na ... ok\n${many}\nb ...`), many);

  const whole = `${one}\na ... ok (1ms)\n${many}\n` + "x".repeat(20_000) +
    "\nb ... ";
  // Every cut point of a header, and every chunk size.
  for (const size of [1, 7, 64, 100_000]) {
    const at = headerTracker();
    const seen: (string | null)[] = [];
    for (let i = 0; i < whole.length; i += size) {
      at.feed(whole.slice(i, i + size));
      if (seen.at(-1) !== at.last()) seen.push(at.last());
    }
    assertEquals(at.last(), many, `chunks of ${size}`);
    // A header counts once its line is whole — never a cut one.
    assertEquals(
      seen.filter((h) => h !== null),
      size === 100_000
        ? [many]
        : ["running 1 test from ./tests/a.test.ts", many],
      `chunks of ${size}`,
    );
  }
  assertEquals(headerTracker().last(), null);
});

Deno.test("pumpToLog: every chunk is on the log before the next is read, and the whole text comes back", async () => {
  const bytes = new TextEncoder().encode("running 1 test — né\nok ✓\n");
  // Cut inside a multi-byte character.
  const cuts = [0, 3, 19, 20, 27, bytes.length];
  const chunks = cuts.slice(1).map((end, i) => bytes.slice(cuts[i]!, end));
  const written: number[] = [];
  const order: string[] = [];
  const log = {
    // A short write: the rest of the chunk must follow.
    write(p: Uint8Array): Promise<number> {
      const n = Math.min(2, p.length);
      written.push(...p.subarray(0, n));
      return Promise.resolve(n);
    },
  };
  const seen: string[] = [];
  const text = await pumpToLog(
    new ReadableStream<Uint8Array>({
      pull(c) {
        order.push(`read ${written.length}`);
        const next = chunks.shift();
        if (next) c.enqueue(next);
        else c.close();
      },
    }, { highWaterMark: 0 }),
    log,
    (t) => {
      order.push(`seen ${written.length}`);
      seen.push(t);
    },
  );
  assertEquals(text, "running 1 test — né\nok ✓\n");
  assertEquals(seen.join(""), text);
  assertEquals(new Uint8Array(written), bytes);
  // What was read is on the log, whole, when it is seen and before more is read.
  // …in whole characters: the first byte of the `✓`, which the fourth chunk
  // ends with, waits for the other two.
  assertEquals(order, [
    "read 0",
    "seen 3",
    "read 3",
    "seen 19",
    "read 19",
    "seen 20",
    "read 20",
    "seen 26",
    "read 26",
    `seen ${bytes.length}`,
    `read ${bytes.length}`,
  ]);
  // A stream that ENDS inside a character: what was cut is still told (as
  // U+FFFD), not dropped with the decoder's last bytes.
  const cut = new TextEncoder().encode("ok é").slice(0, -1);
  const tail: number[] = [];
  const told: string[] = [];
  const ended = await pumpToLog(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(cut);
        c.close();
      },
    }),
    {
      write: (p) => {
        tail.push(...p);
        return Promise.resolve(p.length);
      },
    },
    (t) => told.push(t),
  );
  assertEquals(ended, "ok \uFFFD");
  // …to the log and to whoever listens alike: all three hold the same text.
  assertEquals(told.join(""), ended);
  assertEquals(new TextDecoder().decode(new Uint8Array(tail)), ended);
});

Deno.test("pumpToLog: two streams into one log never split a character between them", async () => {
  // stdout and stderr of one shard, each cut inside a character, taking
  // turns: on disk every character is whole, whichever stream wrote last.
  const enc = new TextEncoder();
  const disk: number[] = [];
  const log = {
    write(p: Uint8Array): Promise<number> {
      disk.push(...p);
      return Promise.resolve(p.length);
    },
  };
  const turns: (() => void)[] = [];
  const stream = (text: string, cut: number) => {
    const bytes = enc.encode(text);
    const parts = [bytes.slice(0, cut), bytes.slice(cut)];
    return new ReadableStream<Uint8Array>({
      pull(c) {
        // One chunk per turn, handed out below in a fixed order.
        return new Promise<void>((go) =>
          turns.push(() => {
            const next = parts.shift();
            if (next) c.enqueue(next);
            else c.close();
            go();
          })
        );
      },
    }, { highWaterMark: 0 });
  };
  const seen: string[] = [];
  const both = Promise.all([
    pumpToLog(stream("A😀A\n", 3), log, (t) => seen.push(t)),
    pumpToLog(stream("B€B\n", 2), log, (t) => seen.push(t)),
  ]);
  // out, err, out, err, … until both have closed.
  let rounds = 0;
  for (;; rounds++) {
    await new Promise((r) => setTimeout(r, 0));
    if (turns.length === 0) break;
    for (const turn of turns.splice(0)) turn();
  }
  assertEquals(rounds, 3, "two chunks and the close, for each stream");
  assertEquals(await both, ["A😀A\n", "B€B\n"]);
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(new Uint8Array(disk));
  assert(!text.includes("\uFFFD"), text);
  assertEquals(text, seen.join(""));
  assertEquals([...text].sort().join(""), [..."A😀A\nB€B\n"].sort().join(""));
  // The halves really did take turns: one stream's text is not in one piece.
  assert(!text.includes("A😀A"), text);
});

Deno.test("quietMsOf: digits only, in range, every occurrence read, the last one counts", () => {
  assertEquals(quietMsOf([]), 300_000);
  assertEquals(quietMsOf(["tests/a.test.ts", "--shards=2"]), 300_000);
  assertEquals(quietMsOf(["--quiet-ms=1"]), 1);
  assertEquals(quietMsOf(["--quiet-ms=2147483647"]), 2 ** 31 - 1);
  assertEquals(quietMsOf(["--quiet-ms=5000", "x", "--quiet-ms=7000"]), 7000);
  const bad = [
    "abc",
    "",
    "0",
    "-5",
    "-0",
    "+5",
    " 5",
    "5 ",
    "5\n",
    "05",
    "5.0",
    "0.5",
    "0x10",
    "0b11",
    "1e3",
    "1_000",
    "５",
    "Infinity",
    "2147483648",
    "99999999999999999999",
  ];
  assertEquals(bad.length, 20);
  for (const value of bad) {
    const refusal = `test-shards: --quiet-ms=${value} is not a whole number ` +
      `of milliseconds from 1 to 2147483647`;
    assertEquals(quietMsOf([`--quiet-ms=${value}`]), refusal, value);
    // …wherever it stands among good ones.
    assertEquals(
      quietMsOf(["--quiet-ms=5000", `--quiet-ms=${value}`]),
      refusal,
      value,
    );
    assertEquals(
      quietMsOf([`--quiet-ms=${value}`, "--quiet-ms=5000"]),
      refusal,
      value,
    );
  }
  // A flag with no value gives no number.
  assertEquals(
    quietMsOf(["--quiet-ms", "5000"]),
    "test-shards: --quiet-ms is not a whole number of milliseconds from 1 " +
      "to 2147483647",
  );
  // Another flag that merely starts alike is not this one.
  assertEquals(quietMsOf(["--quiet-msx=abc", "--quietms=5"]), 300_000);
});

Deno.test("shardsOf: the flag, else the environment, else the fallback — read by the one reader of whole numbers", () => {
  assertEquals(shardsOf([], undefined, 7), 7);
  assertEquals(shardsOf(["tests/a.test.ts", "--quiet-ms=5"], undefined, 7), 7);
  assertEquals(shardsOf(["--shards=3"], undefined, 7), 3);
  assertEquals(shardsOf([], "4", 7), 4);
  // The flag wins over the environment; of two flags the last one counts.
  assertEquals(shardsOf(["--shards=3"], "4", 7), 3);
  assertEquals(shardsOf(["--shards=3", "--shards=256"], "abc", 7), 256);
  const bad = ["abc", "", "0", "-1", "0x", "0x10", "1e1", "1.5", " 2", "257"];
  assertEquals(bad.length, 10);
  for (const value of bad) {
    assertEquals(
      shardsOf([`--shards=${value}`], "4", 7),
      `test-shards: --shards=${value} is not a whole number of shards from ` +
        `1 to 256`,
      value,
    );
    // …a later good one does not excuse it.
    assertEquals(
      typeof shardsOf([`--shards=${value}`, "--shards=2"], undefined, 7),
      "string",
      value,
    );
    assertEquals(
      shardsOf([], value, 7),
      `test-shards: AIO_TEST_SHARDS=${value} is not a whole number of ` +
        `shards from 1 to 256`,
      value,
    );
  }
  assertEquals(
    shardsOf(["--shards", "2"], undefined, 7),
    "test-shards: --shards is not a whole number of shards from 1 to 256",
  );
  // THE reader itself: the bound is the caller's, the sentence names the
  // setting as it was written.
  assertEquals(wholeNumber("X=9", "9", 9, "things"), 9);
  assertEquals(
    wholeNumber("X=10", "10", 9, "things"),
    "test-shards: X=10 is not a whole number of things from 1 to 9",
  );
  assertEquals(
    wholeNumber("X", undefined, 9, "things"),
    "test-shards: X is not a whole number of things from 1 to 9",
  );
});

Deno.test("quietWatch: says so after each quiet interval, never sooner than one after the last output, and stops", async () => {
  const MS = 200;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let from = performance.now();
  const said: number[] = [];
  const early: string[] = [];
  const watch = quietWatch(MS, (quiet) => {
    said.push(quiet);
    const waited = performance.now() - from;
    if (waited < quiet - 2) early.push(`${quiet} after ${waited}`);
  });
  try {
    // Output half-way through: the interval starts over.
    await sleep(MS / 2);
    const before = said.length;
    watch.touch();
    from = performance.now();
    // Bounded: a watch that stops speaking fails here, it does not hang.
    const spoken = async (n: number) => {
      for (let i = 0; said.length < n && i < 40 * MS / 10; i++) await sleep(10);
    };
    await spoken(before + 3);
    // Again every interval, counting the whole silence.
    assertEquals(said.slice(before, before + 3), [MS, 2 * MS, 3 * MS]);
    watch.touch();
    from = performance.now();
    const again = said.length;
    await spoken(again + 1);
    assertEquals(said[again], MS);
    assertEquals(early, []);
  } finally {
    watch.stop();
  }
  const stopped = said.length;
  await sleep(MS * 2 + 50);
  assertEquals(said.length, stopped, "it spoke after stop()");
});

Deno.test("followShard: output on EITHER pipe starts the quiet interval over; the line names the file stdout last started", async () => {
  const MS = 200;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const HEADER = "running 1 test from ./tests/a.test.ts";
  const enc = new TextEncoder();
  for (const pipe of ["stdout", "stderr"] as const) {
    const ctl = {} as Record<
      "stdout" | "stderr",
      ReadableStreamDefaultController<Uint8Array>
    >;
    const stream = (name: "stdout" | "stderr") =>
      new ReadableStream<Uint8Array>({ start: (c) => void (ctl[name] = c) });
    const written: string[] = [];
    let last = performance.now();
    const said: [number, string | null][] = [];
    const early: string[] = [];
    const following = followShard(
      { stdout: stream("stdout"), stderr: stream("stderr") },
      {
        write: (p) => {
          written.push(new TextDecoder().decode(p));
          return Promise.resolve(p.length);
        },
      },
      MS,
      (quiet, header) => {
        said.push([quiet, header]);
        const waited = performance.now() - last;
        if (waited < quiet - 2) early.push(`${quiet} after ${waited}`);
      },
    );
    // Output half-way through the first interval, on this pipe.
    await sleep(MS / 2);
    const before = said.length;
    last = performance.now();
    ctl[pipe].enqueue(enc.encode(`${HEADER}\na ...`));
    for (let i = 0; said.length < before + 2 && i < 40 * MS / 10; i++) {
      await sleep(10);
    }
    ctl.stdout.close();
    ctl.stderr.close();
    const out = await following;
    // Only stdout carries the header.
    const header = pipe === "stdout" ? HEADER : null;
    assertEquals(said.slice(before, before + 2), [[MS, header], [
      2 * MS,
      header,
    ]], pipe);
    assertEquals(early, [], pipe);
    assertEquals(out[pipe], `${HEADER}\na ...`);
    assertEquals(written, [`${HEADER}\na ...`]);
    // Both pipes closed: it stops speaking.
    const stopped = said.length;
    await sleep(MS * 2 + 50);
    assertEquals(said.length, stopped, "it spoke after the shard ended");
  }
});
