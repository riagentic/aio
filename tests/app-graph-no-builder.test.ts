// A compiled app carries its module graph — so what `aio` imports, every app
// ships. Two one-line imports of a config rule once pulled the whole builder
// in behind them: the fleet, every target's packager, the compile step and
// the Android template, 23 modules and 210 KB minified in every desktop
// binary, plus esbuild in the app's npm graph. None of it can run there.
//
// This walks the CODE edges (a type-only import is erased) from the entry an
// app imports and names every `src/build` module they reach. The list is
// exact: a new name here is a module every app will carry, so it is added on
// purpose or the import is moved (see src/build/config-rules.ts).
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

interface Info {
  roots: string[];
  modules: Array<{
    specifier: string;
    dependencies?: Array<{ code?: { specifier?: string } }>;
  }>;
}

/** Every module the entry's code imports, statically or by a literal
 *  `import()` — what `deno compile` embeds. */
async function codeGraph(entry: string): Promise<Set<string>> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "--no-lock", entry],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const info = JSON.parse(new TextDecoder().decode(out.stdout)) as Info;
  const deps = new Map(
    info.modules.map((m) => [
      m.specifier,
      (m.dependencies ?? []).flatMap((d) => d.code?.specifier ?? []),
    ]),
  );
  const seen = new Set<string>();
  const queue = [...info.roots];
  while (queue.length) {
    const s = queue.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    queue.push(...deps.get(s) ?? []);
  }
  return seen;
}

Deno.test("app graph: importing aio reaches the runtime's own build modules and none of the builder", async () => {
  const graph = await codeGraph("mod.ts");
  const here = new URL("../src/", import.meta.url).href;
  const build = [...graph].filter((s) => s.startsWith(`${here}build`))
    .map((s) => s.slice(here.length)).sort();
  assertEquals(build, [
    "build/app-icon.ts", // the served icon and the tray/window icon
    "build/app-theme.ts", // the default stylesheet
    "build/build-css.ts", // the dev css step
    "build/build-flags.ts", // the CLI names build flags to refuse them
    "build/build-integrity.ts", // dev bundling of http imports
    "build/build-shape.ts", // what a build puts in an out dir: the version leaves out only that
    "build/build-version.ts", // the update check compares versions
    "build/capabilities.ts", // an update's capability manifest
    "build/client-bundle.ts", // the dev bundler
    "build/config-rules.ts",
    "build/esbuild-plugin.ts",
    "build/esbuild-shared.ts",
    "build/graph-audit.ts",
    "build/graph-eval.ts",
    "build/ship.ts", // release manifests and their signatures
  ]);
  // The bundler is loaded by a computed specifier where a dev server needs
  // it; a static edge would put it in every app's npm graph.
  assertEquals([...graph].filter((s) => s.startsWith("npm:esbuild")), []);
  assert(graph.has(`${here}server/aio.ts`), "the walk reached the runtime");
});
