// What `am record` writes must type-check and RUN.
//
// It emitted `await using h = bootCells([counter, stats]);` — but bootCells
// returns a Promise of the handle, so `deno check` failed (TS2851 on the
// using, TS2339 on `h.settle`) and running it threw "Symbol(Symbol.dispose) is
// not a function" on the first line. tests/am-record.test.ts only ever matched
// substrings of the output, which a broken file satisfies as well as a working
// one. This lays the output out beside real cells and runs `deno check` and
// `deno test` on it.
import { assertEquals } from "@std/assert";
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
