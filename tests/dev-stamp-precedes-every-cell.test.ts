// `__aioDev` is stamped before the FIRST `cell()` of a dev server, whichever
// module the app imports first.
//
// The stamp lives in `src/server/aio-boot.ts` (at import) and the dev-only
// gates that fire inside `cell()` — the freeze of declared state, the retired
// cell-config refusals — read it at that moment. A cell module is usually the
// first thing an entry imports, before anything names `aio.run`. That is safe
// for one reason: ES modules evaluate an imported module's whole static graph
// before the importer's body runs, so `import { cell } from "aio"` has already
// evaluated `aio-boot.ts` by the time `cell(…)` executes.
//
// The reason stops holding the day some OTHER public entry exports `cell`
// without reaching the server graph (`aio/state-core` does not export it
// today — importing it from there is a link error). The guard below makes that
// red, instead of a dev server that silently runs its cells as prod.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const BOOT = new URL("../src/server/aio-boot.ts", import.meta.url).href;

async function run(args: string[], cwd: string): Promise<string> {
  const r = await new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(120_000),
  }).output();
  const out = new TextDecoder().decode(r.stdout);
  assertEquals(r.code, 0, out + new TextDecoder().decode(r.stderr));
  return out;
}

Deno.test("dev stamp: a cell module imported FIRST already sees __aioDev at cell(); --prod does not", async () => {
  const dir = await tempDir("aio-devstamp-first-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: `${ROOT}mod.ts`, immer: "npm:immer@10.2.0" },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "cell.ts"),
      `import { cell } from "aio";
export const c = cell("first", { state: { a: { b: 1 } }, methods: {} });
const g = globalThis as Record<string, unknown>;
console.log("AT_CELL=" + String(g.__aioDev) + ":" +
  Object.isFrozen((c as unknown as { __aio: { state: object } }).__aio.state));
`,
    );
    // The entry's first import is the cell module; nothing else precedes it.
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { c } from "./cell.ts";\nvoid c;\n`,
    );
    const dev = await run(["run", "-A", "--no-lock", "app.ts"], dir);
    assert(dev.includes("AT_CELL=true:true"), dev);
    const prod = await run(["run", "-A", "--no-lock", "app.ts", "--prod"], dir);
    assert(prod.includes("AT_CELL=undefined:false"), prod);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("dev stamp: every public entry that exports `cell` reaches aio-boot.ts", async () => {
  const dj = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json"))) as {
    exports: Record<string, string>;
  };
  // `./amui` is an app (it boots when imported), not a library entry.
  const entries = Object.entries(dj.exports).filter(([k]) => k !== "./amui")
    .map(([k, v]) => [k, new URL(v, `file://${ROOT}`).href] as const);
  const probe = await tempDir("aio-devstamp-entries-");
  try {
    await Deno.writeTextFile(
      join(probe, "probe.ts"),
      `const entries = ${JSON.stringify(entries)};
const out: string[] = [];
for (const [name, url] of entries) {
  const m = await import(url);
  if ("cell" in m) out.push(name + "|" + url);
}
console.log("CELL_ENTRIES=" + JSON.stringify(out));
Deno.exit(0);
`,
    );
    const text = await run(
      [
        "run",
        "-A",
        "--no-check",
        "--config",
        join(ROOT, "deno.json"),
        join(probe, "probe.ts"),
      ],
      ROOT,
    );
    const line = text.split("\n").find((l) => l.startsWith("CELL_ENTRIES="));
    assert(line, text);
    const withCell = JSON.parse(line.slice("CELL_ENTRIES=".length)) as string[];
    assert(
      withCell.length > 0,
      "no public entry exports cell — the probe is broken",
    );
    assert(withCell.some((e) => e.startsWith(".|")), "`aio` exports cell");
    for (const e of withCell) {
      const [name, url] = e.split("|") as [string, string];
      const info = JSON.parse(
        await run(
          ["info", "--json", "--config", join(ROOT, "deno.json"), url],
          ROOT,
        ),
      ) as { modules: { specifier: string }[] };
      assert(
        info.modules.some((m) => m.specifier === BOOT),
        `"${name}" exports cell but its graph never evaluates aio-boot.ts — ` +
          `a cell module importing cell from it gets no __aioDev stamp in dev`,
      );
    }
  } finally {
    await dropTempDir(probe);
  }
});
