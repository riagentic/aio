/**
 * @module
 * `am testgen` — write a typed test client from what the app actually renders.
 *
 * `ui.App["tab-settings"]` is a string key, and a typo in one is a runtime
 * `undefined` rather than a compile error (llama.master §11, §18).
 *
 * The GENERATOR already existed and already answered that: `generateUITypes`
 * types the surface, so `ui.App.SubmitButton.click()` autocompletes and a
 * renamed button breaks the test at compile time. What did not exist was a way
 * to run it without writing a script first — importing happy-dom, constructing
 * a document, importing the App and the cells, and remembering to re-run it.
 * That ceremony is why an app that HAD the feature available kept using string
 * keys.
 *
 * Types come from the RENDER, not from parsing TSX: what is on the surface is
 * what a test can address, and a `t=` prop inside a branch that never renders
 * is not a locator anyone can use.
 */
import { dirname, resolve } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { projectRoot } from "./am-cmd-process.ts";
import { isAbsolute } from "@std/path";
import { readDenoJsonSync } from "../server/deno-json.ts";
import { UI_ENTRY } from "../server/app-files.ts";
import { resolveAppDir } from "../build/build-config.ts";
import { resolveEntryPath } from "../server/paths.ts";
import { renderHeadlessSurface } from "../server/server-surface.ts";
// The GENERATOR only — a pure string function over a plain surface object.
// Not the harness: `testUI` boots cells and mounts a renderer, and none of
// that belongs in the CLI. The boundary matrix records this widening and why.
import { generateUITypes } from "../testing/ui-testgen.ts";
import type { UISurfaceNode } from "../air/ui-surface.ts";

/** Where the generated client goes unless `--out` says otherwise. */
export const DEFAULT_TESTGEN_OUT = "tests/ui.gen.ts";

/** `am testgen [entry] [--out=tests/ui.gen.ts]` */
export async function cmdTestgen(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const root = projectRoot();
  // The SAME resolution `am check` uses — two spellings of "where is the UI
  // entry" is how they come to disagree about which file an app has.
  const entryRel = flags.entry ?? args.find((a) => !a.startsWith("-")) ??
    UI_ENTRY;
  const baseDir = resolveAppDir(
    root,
    resolveEntryPath(readDenoJsonSync(root)?.config),
  );
  const entry = isAbsolute(entryRel) ? entryRel : resolve(baseDir, entryRel);
  let exists = true;
  try {
    Deno.statSync(entry);
  } catch {
    exists = false;
  }
  if (!exists) {
    // LOUD, not a silent success. "Wrote 0 types" and "there is no UI" are the
    // same file on disk, and only one of them is a problem.
    outError(
      `am testgen: no UI entry found${
        entryRel ? ` at ${entryRel}` : ""
      } — nothing to generate types from.\n` +
        `  pass it (\`am testgen src/App.tsx\`), or declare \`entry\` in ` +
        `deno.json. A server-only app has no UI client and needs none.`,
      mode,
    );
    Deno.exit(1);
  }

  const rendered = await renderHeadlessSurface(entry, true);
  if (!rendered.ok) {
    outError(`am testgen: ${rendered.error}`, mode);
    Deno.exit(1);
  }
  const roots = rendered.roots as UISurfaceNode[];
  const root0 = roots[0];
  if (!root0) {
    outError(
      `am testgen: the UI entry rendered nothing addressable. A component ` +
        `that returns null, or one whose every element lacks an accessible ` +
        `name, has no surface — and a typed client for it would be an empty ` +
        `interface that compiles and helps nobody.`,
      mode,
    );
    Deno.exit(1);
  }

  const outPath = resolve(
    root,
    args.find((a) => a.startsWith("--out="))?.slice(6) ?? DEFAULT_TESTGEN_OUT,
  );
  const src = generateUITypes(root0);
  await Deno.mkdir(dirname(outPath), { recursive: true });
  await Deno.writeTextFile(outPath, src);

  const rel = outPath.startsWith(root + "/")
    ? outPath.slice(root.length + 1)
    : outPath;
  const components = countComponents(root0);
  out(
    { file: rel, components, bytes: src.length },
    mode,
    `✓ ${rel} — ${components} component${components === 1 ? "" : "s"} typed\n` +
      `  import type { TypedTestUI } from "./${
        rel.split("/").pop()
      }" and cast: ` +
      `\`const ui = await testUI(App) as TypedTestUI\`\n` +
      `  re-run after a UI change — the types describe what RENDERS, so a ` +
      `renamed button breaks the test at compile time`,
  );
}

/** How many distinct components the surface carries — the number that tells a
 *  reader whether the generator saw their app or a fragment of it. */
function countComponents(node: UISurfaceNode): number {
  const seen = new Set<string>();
  const walk = (n: UISurfaceNode) => {
    seen.add(n.component);
    n.children.forEach(walk);
  };
  walk(node);
  return seen.size;
}
