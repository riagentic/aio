// The suite's own files set `Deno.env` and `chdir` on the promise that no other
// file runs beside them in-process; `deno test --parallel` breaks it (one
// process, files as workers, one env). The harness says so once
// (`_oneSuiteFileAtATime`, test-strict.ts) — and only then. Two planted suite
// files, each arming the store sandbox at load, run in a child `deno test`:
// with `--parallel` the second loads while the first still runs (it waits for
// the second's marker), so the overlap is certain, not a timing guess.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));
const SAID = "[aio:testing]";

/** A planted suite file `name`: arms the sandbox at load, then (when `wait`)
 *  writes its marker and waits for the other's. */
const plant = (name: string, other: string, marks: string) =>
  `import { _sandboxHomeStores } from "../../src/testing/test-strict.ts";
_sandboxHomeStores();
Deno.test(${JSON.stringify(name)}, async () => {
  if (Deno.env.get("PLANT_WAIT") !== "1") return;
  await Deno.writeTextFile(${JSON.stringify(join(marks, name))}, "");
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      await Deno.stat(${JSON.stringify(join(marks, other))});
      return;
    } catch { /* aio-ok: not there yet */ }
    if (Date.now() > until) throw new Error("the other file never ran");
    await new Promise((r) => setTimeout(r, 20));
  }
});
`;

Deno.test("test-strict: two suite files in one process are said once; one at a time, nothing", async () => {
  // Under tests/ — the guard judges this repo's suite only; removed below.
  // aio-ok: it must be INSIDE tests/, which the temp root is not
  const dir = Deno.makeTempDirSync({
    dir: join(REPO, "tests"),
    prefix: ".plant-",
  });
  const marks = await tempDir("one-file-at-a-time-");
  try {
    await Deno.writeTextFile(join(dir, "a.ts"), plant("a", "b", marks));
    await Deno.writeTextFile(join(dir, "b.ts"), plant("b", "a", marks));
    const run = async (parallel: boolean) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "test",
          "-A",
          ...(parallel ? ["--parallel"] : []),
          join(dir, "a.ts"),
          join(dir, "b.ts"),
        ],
        cwd: REPO,
        env: { DENO_JOBS: "2", PLANT_WAIT: parallel ? "1" : "0" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      const text = d.decode(o.stdout) + d.decode(o.stderr);
      assert(o.success, text);
      return text.split(SAID).length - 1;
    };
    assertEquals(await run(true), 1, "--parallel: said once");
    assertEquals(await run(false), 0, "one file at a time: silent");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await dropTempDir(marks);
  }
});
