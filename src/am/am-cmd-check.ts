/**
 * @module
 * `am check` — does this app's client graph actually BUILD?
 *
 * `deno check` type-checks. It does not bundle, and in aio those are different
 * questions with different answers: `"aio"` resolves to `mod.ts` for the
 * type-checker and to `browser-air.ts` for the browser bundle. TypeScript
 * checks the UNION; the bundle gets the INTERSECTION. So anything server-only
 * imported into a cell type-checks cleanly and then fails to build.
 *
 * A field report called this the only defect in its whole write-up, and the
 * reason is not that the failure is obscure — the graph validator catches it at
 * dev boot and names file, line, column and fix. The reason is WHEN it arrives:
 * after `deno task check`, the tool the author trusts and the one CI runs, has
 * already said the code is fine. Worse, it pushed that author to a
 * stringly-typed workaround (`compose: [self("cancel")]` became
 * `["studio:cancel"]`, which no rename follows) to get past a green check that
 * was lying.
 *
 * So the answer is not a better error. It is that `deno task check` stops being
 * green. This is the half `deno check` cannot do, and the scaffold's `check`
 * task runs both — exactly the treatment `lint` already gets, where one task
 * runs `deno lint` AND `aiol` because a task's name has to be true.
 */
import { isAbsolute, resolve } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { projectRoot } from "./am-cmd-process.ts";
import {
  BLOCKING_CATEGORIES,
  type GraphError,
  validateGraph,
} from "../server/graph-validator.ts";
import { transpile } from "../server/server-transpile.ts";
import {
  buildBrowserImportMap,
  readAppDenoImports,
} from "../server/server-html-importmap.ts";
import { hasVendorImmer } from "../server/server-vendor.ts";
import { UI_ENTRY } from "../server/app-files.ts";
import { resolveAppDir } from "../build/build-config.ts";
import { resolveEntryPath } from "../server/paths.ts";
import { readDenoJsonSync } from "../server/deno-json.ts";

/** One finding, formatted the way an editor and a human both read it. */
function line(e: GraphError): string {
  const where = e.line ? `${e.file}:${e.line}` : e.file;
  return `  ${where}\n    ${e.message}\n    fix: ${e.fix}`;
}

export async function cmdCheck(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const root = projectRoot();
  const entryRel = flags.entry ?? args.find((a) => !a.startsWith("-")) ??
    UI_ENTRY;
  const baseDir = resolveAppDir(
    root,
    resolveEntryPath(readDenoJsonSync(root)?.config),
  );
  const entry = isAbsolute(entryRel) ? entryRel : resolve(baseDir, entryRel);

  try {
    Deno.statSync(entry);
  } catch {
    // A server-only app has no client graph, and that is not a failure — it is
    // the whole point of `client: "server-only"`. Saying "checked nothing" out
    // loud beats exiting 0 in a way indistinguishable from "checked and clean".
    // Said out loud, and on stderr, because "checked nothing" must never be
    // mistaken for "checked and clean" — that confusion IS the bug this
    // command exists to remove, and re-creating it one layer up would be a
    // poor joke.
    // ALWAYS, in every mode. stderr does not corrupt the JSON on stdout, and
    // the mode that suppressed this was `--json` — which is CI, the one reader
    // who most needs to know the gate looked at nothing.
    {
      console.error(
        `warning: am check: NOTHING CHECKED — no UI entry at ${entry}.\n` +
          `  A server-only app has no client graph and this is correct for it.\n` +
          `  Otherwise the entry is elsewhere: pass it (\`am check path/App.tsx\`)\n` +
          `  or declare it in deno.json \`entry\`, or this task is green for\n` +
          `  looking at nothing.`,
      );
    }
    out(
      { entry, checked: false, reason: "no-ui-entry", errors: [] },
      mode,
      () => "",
    );
    return;
  }

  let graph;
  try {
    graph = await validateGraph(
      entry,
      buildBrowserImportMap(readAppDenoImports(baseDir), {
        vendorImmer: hasVendorImmer(),
      }),
      (s, f) => transpile(s, f),
    );
  } catch (e) {
    outError(
      `could not walk the client graph from ${entry}: ` +
        `${e instanceof Error ? e.message : e}`,
      mode,
    );
    Deno.exit(1);
  }

  const blocking = graph.errors.filter((e) =>
    BLOCKING_CATEGORIES.has(e.category)
  );
  const warnings = graph.errors.filter((e) =>
    !BLOCKING_CATEGORIES.has(e.category)
  );

  if (mode === "json") {
    out(
      {
        entry,
        checked: true,
        modules: graph.modules.size,
        errors: blocking,
        warnings,
      },
      mode,
    );
  } else {
    if (blocking.length) {
      console.error(
        `\n${blocking.length} module error(s) — this app type-checks and will ` +
          `NOT bundle:\n${blocking.map(line).join("\n")}\n`,
      );
    }
    if (warnings.length) {
      console.error(
        `${warnings.length} warning(s):\n${warnings.map(line).join("\n")}\n`,
      );
    }
    if (!blocking.length) {
      out(
        `client graph OK — ${graph.modules.size} module(s) from ${entry}` +
          (warnings.length ? ` (${warnings.length} warning(s) above)` : ""),
        mode,
      );
    }
  }

  // Warnings never fail the check: the author is expected to live with some of
  // them, and a gate that cries wolf is one people learn to pass with `|| true`.
  if (blocking.length) Deno.exit(1);
}
