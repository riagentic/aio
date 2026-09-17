// What `am record` writes must type-check and RUN.
//
// It emitted `await using h = bootCells([counter, stats]);` — but bootCells
// returns a Promise of the handle, so `deno check` failed (TS2851 on the
// using, TS2339 on `h.settle`) and running it threw "Symbol(Symbol.dispose) is
// not a function" on the first line. tests/am-record.test.ts only ever matched
// substrings of the output, which a broken file satisfies as well as a working
// one. This lays the output out beside real cells and runs `deno check` and
// `deno test` on it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { generateReplayTest } from "../src/am/record.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CONFIG = new URL("../deno.json", import.meta.url).pathname;

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

Deno.test("am record: the generated replay test passes deno check and deno test", async () => {
  const dir = await tempDir("am-record-runs-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "tests"));
    await Deno.writeTextFile(
      join(dir, "src", "counter.ts"),
      `import { cell } from "aio";
export const counter = cell("counter", {
  state: { count: 0, label: "" },
  methods: {
    inc(s, by: number) { s.count += by; },
    setLabel(s, l: string) { s.label = l; },
    async slow(s, n: number) { await Promise.resolve(); s.count += n; },
  },
});
`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "stats.ts"),
      `import { cell } from "aio";
export const stats = cell("stats", {
  state: { map: {} as Record<string, number> },
  methods: { put(s, k: string, v: number) { s.map[k] = v; } },
});
`,
    );
    const file = join(dir, "tests", "flow.test.ts");
    await Deno.writeTextFile(
      file,
      generateReplayTest([
        { type: "counter:inc", payload: { args: [3] } },
        { type: "counter:setLabel", payload: { args: ["L1"] } },
        { type: "stats:put", payload: { args: ["a.b", 4] } },
        { type: "counter:slow", payload: { args: [2], _callId: "x" } },
        { type: "counter:__setSlow", payload: { mutations: [] } },
      ], { name: "flow", source: "the running app's timeline" }),
    );

    const check = await deno(["check", file], dir);
    assertEquals(check.code, 0, `deno check failed:\n${check.text}`);
    const run = await deno(["test", "-A", file], dir);
    assertEquals(run.code, 0, `the generated test failed:\n${run.text}`);
  } finally {
    await dropTempDir(dir);
  }
});

// ── The import names the DEFINING file ───────────────────────────────────────
//
// `am record` imported each cell by its NAME — `../src/timer.ts` — for a cell
// that lived in src/cell.ts, so `deno task check` was red until the file was
// edited (h3 F8). The real `am record`, from a journal, in a project laid out
// that way, must write an import that type-checks and runs.
Deno.test("am record: imports the cell from the file that defines it", async () => {
  const dir = await tempDir("am-record-deffile-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "tests"));
    await Deno.writeTextFile(
      join(dir, "src", "cell.ts"),
      `import { cell } from "aio";
// cell("timer") in a comment is not the definition
const timerCell = cell("timer", {
  state: { remaining: 25 },
  methods: {
    setLength(s, m: number) { s.remaining = m; },
  },
});
export { timerCell };
`,
    );
    const journal = join(dir, "journal.jsonl");
    await Deno.writeTextFile(
      journal,
      JSON.stringify({
        seq: 1,
        type: "timer:setLength",
        payload: { args: [5] },
      }) +
        "\n",
    );
    const am = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        CONFIG,
        new URL("../src/am.ts", import.meta.url).pathname,
        "record",
        "tests/rec.test.ts",
        `--from=${journal}`,
      ],
      cwd: dir,
      env: {
        ...Deno.env.toObject(),
        NO_COLOR: "1",
        AIO_APPS_DIR: join(dir, ".aio-home"),
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    assertEquals(
      am.code,
      0,
      `am record failed:\n${d.decode(am.stdout)}${d.decode(am.stderr)}`,
    );
    const src = await Deno.readTextFile(join(dir, "tests", "rec.test.ts"));
    assertStringIncludes(
      src,
      `import { timerCell as timer } from "../src/cell.ts";`,
    );
    assert(!src.includes("GUESS"), `nothing was guessed:\n${src}`);
    const check = await deno(["check", join(dir, "tests", "rec.test.ts")], dir);
    assertEquals(check.code, 0, `deno check failed:\n${check.text}\n${src}`);
    const run = await deno(
      ["test", "-A", join(dir, "tests", "rec.test.ts")],
      dir,
    );
    assertEquals(run.code, 0, `the generated test failed:\n${run.text}`);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("generateReplayTest: an unresolved cell import is marked a GUESS", () => {
  const src = generateReplayTest([
    { type: "ghost:go", payload: { args: [] } },
  ]);
  assertStringIncludes(
    src,
    `import { ghost } from "../src/ghost.ts"; // a GUESS`,
  );
  assertStringIncludes(src, "import paths marked GUESS");
});
