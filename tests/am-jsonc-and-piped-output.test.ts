// Two `am` surfaces that read a project's config or write a machine's output,
// and got one of them wrong for a jsonc project / a piped stdout.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cmdFix } from "../src/am/am-cmd-fix.ts";
import { cmdAdd } from "../src/am/am-cmd-meta.ts";
import { VERSION } from "../src/server/aio-cli.ts";

/** Run `fn` with stdout captured (am writes its JSON document to console.log). */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines;
}

// `am fix` warms the dependency cache — the main reason to run it on a fresh
// clone. Its entry lookup used `JSON.parse` on `deno.json` only, so a single
// `//` comment (which Deno accepts, and which is the whole point of `.jsonc`)
// made the parse throw, the config read as null, and the entry fall back to
// the default `src/app.ts`. For an app whose entry is anywhere else the repair
// was then skipped with NO line of output at all, while the closing banner
// still said "Now run: deno task dev".
Deno.test("am fix: finds the entry in a COMMENTED deno.jsonc", async () => {
  const orig = Deno.cwd();
  const dir = await Deno.makeTempDir({ prefix: "am-jsonc-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.jsonc"),
      `{
  // This app's entry is not the scaffold default.
  "entry": "app/main.ts",
  "imports": { "aio": "jsr:@riagentic/aio@${VERSION}" },
  "tasks": { "dev": "deno run -A app/main.ts" }
}
`,
    );
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(
      join(dir, "app", "main.ts"),
      `import { aio } from "aio";\nawait aio.run({ appId: "x" });\n`,
    );
    Deno.chdir(dir);
    // --dry-run: report what it WOULD do, touch nothing, hit no network.
    const lines = await captureLog(() => cmdFix(["--dry-run"], { json: true }));
    const doc = JSON.parse(lines.at(-1)!) as {
      results: { name: string; outcome: string; note: string }[];
    };
    const cache = doc.results.find((r) => r.name === "dependencies cached");
    assert(cache, "the cache repair must be reported at all");
    assertEquals(
      cache.note,
      "deno cache app/main.ts",
      "the entry comes from the app's own config, comments and all",
    );
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

// `detectMode` is the one decider for output shape: a non-tty stdout IS json
// mode, which is how every other am command behaves. `am add cell` branched on
// `flags.json` instead, so a piped `am add cell x | jq -r .created` received
// the PRETTY STRING, JSON-stringified — valid JSON, wrong document.
Deno.test("am add cell: piped stdout gets the JSON document, not a stringified sentence", async () => {
  const orig = Deno.cwd();
  const dir = await Deno.makeTempDir({ prefix: "am-add-" });
  try {
    Deno.chdir(dir);
    // No `--json` flag: the mode comes from stdout not being a terminal,
    // exactly as it does under a pipe.
    const lines = await captureLog(() => cmdAdd(["cell", "todos"], {}));
    const parsed = JSON.parse(lines.at(-1)!);
    assertEquals(
      parsed,
      { created: "src/cell/todos.ts" },
      "a machine reader asked for a field, not for prose",
    );
    assert(await Deno.stat(join(dir, "src", "cell", "todos.ts")));
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});
