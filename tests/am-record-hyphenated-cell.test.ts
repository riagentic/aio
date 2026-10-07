// `am record` must write a replay test that type-checks for a cell whose name
// has a hyphen.
//
// `cell()` accepts /^[A-Za-z_][\w\-]*$/ ("hyphens ok" — `flc-counter`), and
// `findCellDefinitions` looks for `[\w-]+` names, so a hyphenated cell is a
// supported case. But `generateReplayTest` splices the CELL NAME into the
// source as an identifier: `import { flcCounter as flc-counter }`,
// `bootCells([flc-counter])`, `await flc-counter.inc(2)` — a syntax error, so
// the generated file cannot run at all.
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { generateReplayTest } from "../src/am/record.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

Deno.test("am record: a hyphenated cell name yields a replay test that passes deno check", async () => {
  const dir = await tempDir("hunt-r4-record-hyphen-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "tests"));
    await Deno.writeTextFile(
      join(dir, "src", "counter.ts"),
      `import { cell } from "aio";
export const flcCounter = cell("flc-counter", {
  state: { count: 0 },
  methods: { inc(s, by: number) { s.count += by; } },
});
`,
    );
    const file = join(dir, "tests", "flow.test.ts");
    await Deno.writeTextFile(
      file,
      generateReplayTest(
        [{ type: "flc-counter:inc", payload: { args: [2] } }],
        {
          name: "flow",
          cellFiles: {
            "flc-counter": { spec: "../src/counter.ts", binding: "flcCounter" },
          },
        },
      ),
    );
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["check", "--config", CONFIG, file],
      cwd: dir,
      env: { ...Deno.env.toObject(), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(o.stdout) +
      new TextDecoder().decode(o.stderr);
    assertEquals(
      o.code,
      0,
      `deno check failed on the generated file:\n${text}\n---\n${await Deno
        .readTextFile(file)}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});
