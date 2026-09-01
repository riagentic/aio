/**
 * @module
 * `am where <file>` — which execution context does this file run in?
 *
 * aio has one syntax and six places it executes, and almost nothing in a
 * source file says which one you are in. That invisibility is what makes the
 * framework pleasant to write and it is where the expensive bugs live: a
 * `Deno.*` call in a module the browser links, a hidden-field read in a
 * reducer that replays client-side, a static `*.server.ts` import.
 *
 * The graph validator already computes the answer. `GraphResult.modules` is
 * every module reachable from the UI entry, and `eager` is the subset the
 * browser links STATICALLY at boot — which is exactly how it tells a blocking
 * import from a deferred one. This is a presentation layer over that, so
 * "which context am I in?" stops being a thing you learn by breaking prod.
 *
 * The verdict is derived, never guessed: a file the walk never reached is not
 * in the client graph, and that is a fact about the graph, not an opinion.
 */
import { basename, isAbsolute, relative, resolve } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, kv, out, outError, stack } from "./am-output.ts";
import { projectRoot } from "./am-cmd-process.ts";
import { type GraphResult, validateGraph } from "../server/graph-validator.ts";
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
import {
  context,
  contextNote,
  SIDE,
  WHERE_DOC,
} from "../diagnostics/contexts.ts";

/** Where a file runs, as the graph can prove it. */
export type WhereVerdict =
  | "browser-eager"
  | "browser-deferred"
  | "server-only"
  | "unreached"
  /** No graph could be BUILT here — which is not the same fact as "this app
   *  has no client graph", and folding the two was this command's own worst
   *  bug: run from the wrong directory it called a `.tsx` component
   *  `server-only` and told the reader `Deno.*` was fine, contradicting the
   *  lint rule the same release shipped. A confidently wrong answer is worse
   *  than no tool for this class — the standard `reportHiddenRead` already
   *  states: "a bug that yields a plausible value is worse than one that stops
   *  the page." */
  | "unknown";

/** The rules that follow from a verdict — rendered from `CONTEXTS`, THE
 *  execution-context vocabulary, so this command, the docs table and every
 *  error string are three renderings of one fact rather than three claims
 *  that happen to agree today. Pure: the whole verdict is a table lookup. */
export function whereRules(
  verdict: WhereVerdict,
  serverSuffix: boolean,
  /** Does this file define cells? A cell file is TWO contexts at once — the
   *  module is linked into the browser bundle, and its methods run on the
   *  server — and saying only the first is how a reader concludes that an
   *  async method cannot use `Deno.*`. Found by running `am where` on a
   *  scaffolded app's own `cell.ts`. */
  definesCells = false,
): { headline: string; rules: string[] } {
  // The rules a context implies, in the vocabulary's own words.
  const denoRule = (yes: boolean) =>
    yes
      ? "`Deno.*`, `@std/*`, the filesystem, the network: yes"
      : "`Deno.*` and `@std/*`: NO — this code is in a browser";
  const hiddenRule = (yes: boolean) =>
    yes
      ? "reads the FULL state, hidden (`visible.exclude`) fields included"
      : "hidden (`visible.exclude`) fields: a read THROWS, dev and prod alike";

  if (serverSuffix) {
    const c = context("a `*.server.ts` module");
    return {
      headline: `server only — the context is in the filename (${
        SIDE[c.side]
      })`,
      rules: [
        denoRule(c.deno),
        hiddenRule(c.hiddenFields),
        `reach it with \`await import("./x.server.ts")\` — ${
          contextNote(c.name)
        }: a static import is a refused build AND a refused dev boot`,
      ],
    };
  }
  switch (verdict) {
    case "browser-eager": {
      const body = context("a component body");
      const handler = context("an event handler");
      return {
        headline:
          `the browser links this at boot (static import from the UI) — ${
            SIDE[body.side]
          }`,
        rules: [
          denoRule(body.deno),
          hiddenRule(body.hiddenFields),
          // NAME the other context; do not splice its clause in. Every
          // `surprise` is written from inside its OWN context ("reads here do
          // not subscribe"), so pasting one into a sentence about a different
          // context produces a line that contradicts itself — which is what
          // this said before anyone ran it: "a read subscribes ONLY in a
          // component body — reads here do not subscribe".
          `a read subscribes ONLY in ${body.name}; from ${handler.name} ` +
          `(or a timer, or after an \`await\`) it does not`,
          ...(definesCells
            ? [
              `this file DEFINES CELLS, so it is two contexts at once: the ` +
              `module above is linked into the bundle, while ${
                context("an async method").name
              } in it runs in ${SIDE.server} and may use \`Deno.*\` — put ` +
              `the imports it needs in a \`*.server.ts\` module, never at ` +
              `the top of this one`,
            ]
            : []),
        ],
      };
    }
    case "browser-deferred":
      return {
        headline:
          `reached only through a dynamic import — the browser may never load ` +
          `it, so it is ${SIDE.client} the moment it does`,
        rules: [
          "`Deno.*` here is safe ONLY while nothing static imports this file",
          "one static import from a client-reachable module moves it to " +
          "browser-eager, and every `Deno.*` in it becomes a blank page",
          "if it is server-only on purpose, say so in the NAME: `*.server.ts`",
        ],
      };
    case "server-only": {
      const async = context("an async method");
      const sync = context("a sync method");
      return {
        headline: `not in the client graph — ${SIDE.server}`,
        rules: [
          denoRule(async.deno),
          hiddenRule(async.hiddenFields),
          `the exception is ${contextNote(sync.name)}`,
        ],
      };
    }
    case "unreached":
      return {
        headline: `not reachable from the UI entry — ${SIDE.server}`,
        rules: [
          "nothing the browser loads imports it, so it is server context",
          "…or it is dead code — the graph cannot tell those apart",
        ],
      };
    case "unknown":
      return {
        headline: "unknown — no client graph could be built here",
        rules: [
          "this is NOT a verdict about the file: nothing was walked, so " +
          "nothing is known about which context it runs in",
          "run from the app root, or name the UI entry: `am where <file> " +
          "--entry=ui/App.tsx`",
          `the map is still true whatever the graph says: ${WHERE_DOC}`,
        ],
      };
  }
}

/** Shortest static import chain from `entry` to `file`, or null. The chain is
 *  the ANSWER to "why is this in the browser": a verdict with no chain is a
 *  claim, and a claim is what sent people looking in the wrong file. */
export function importChain(
  graph: GraphResult,
  entry: string,
  file: string,
): string[] | null {
  if (entry === file) return [entry];
  const seen = new Set([entry]);
  let frontier: string[][] = [[entry]];
  while (frontier.length) {
    const next: string[][] = [];
    for (const path of frontier) {
      for (const dep of graph.modules.get(path.at(-1)!)?.deps ?? []) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        const grown = [...path, dep];
        if (dep === file) return grown;
        next.push(grown);
      }
    }
    frontier = next;
  }
  return null;
}

export async function cmdWhere(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const target = args[0];
  if (!target) {
    outError(
      "usage: am where <file>\n" +
        "  Which execution context does this file run in — and why.\n" +
        "  Answered from the module graph the dev server already walks.\n" +
        `  The full map: ${WHERE_DOC}`,
      mode,
    );
    Deno.exit(1);
  }
  const root = projectRoot();
  const file = isAbsolute(target) ? target : resolve(root, target);
  try {
    Deno.statSync(file);
  } catch {
    fail(`no such file: ${file}`, mode);
  }

  // The UI entry the app actually declares — the same decider the dev server
  // uses. Asking a different question here than the server asks is how the two
  // come to disagree about what ships.
  const entryRel = flags.entry ?? UI_ENTRY;
  // The app dir, not a hardcoded `<root>/src`. A literal layout standing in for
  // a rule is this repo's oldest rot: it is right for the scaffold and wrong
  // for a monorepo package, a `ui.entry` in a subdirectory, or any app that
  // simply put its code elsewhere.
  const baseDir = resolveAppDir(
    root,
    resolveEntryPath(readDenoJsonSync(root)?.config),
  );
  const entry = resolve(baseDir, entryRel);
  let graph: GraphResult | null = null;
  // WHY there is no graph, because the two reasons are different facts and
  // answering them the same way is what made this command lie.
  let noGraph: "no-ui-entry" | "build-failed" | null = null;
  try {
    Deno.statSync(entry);
  } catch {
    noGraph = "no-ui-entry";
  }
  if (!noGraph) {
    try {
      graph = await validateGraph(
        entry,
        buildBrowserImportMap(readAppDenoImports(baseDir), {
          vendorImmer: hasVendorImmer(),
        }),
        (s, f) => transpile(s, f),
      );
    } catch {
      noGraph = "build-failed";
    }
  }

  const serverSuffix = /\.server\.tsx?$/.test(basename(file));
  // A `.tsx` file is client context BY CONSTRUCTION — the rule the aiol lint
  // shipped in the same release — so "I could not walk a graph" must never
  // out-rank it. Without this, one release's two halves disagreed about one
  // file.
  const looksLikeUi = /\.tsx$/.test(file) && !serverSuffix;
  const verdict: WhereVerdict = !graph
    ? (noGraph === "build-failed" || looksLikeUi ? "unknown" : "server-only")
    : graph.eager.has(file)
    ? "browser-eager"
    : graph.modules.has(file)
    ? "browser-deferred"
    : "unreached";
  const chain = graph ? importChain(graph, entry, file) : null;
  const rel = (p: string) => relative(root, p) || basename(p);
  // A `cell(` call is enough: this only ADDS a true sentence, so a false
  // positive costs a line and a false negative costs nothing that was there
  // before.
  const definesCells = /\bcell\s*\(\s*["'`]/.test(
    Deno.readTextFileSync(file),
  );
  const { headline, rules } = whereRules(verdict, serverSuffix, definesCells);

  // ONE call for both modes — the house renderer. `--json` is a superset of
  // the human answer, never a different one.
  out(
    {
      file: rel(file),
      verdict,
      serverSuffix,
      headline,
      rules,
      chain: chain?.map(rel) ?? null,
      entry: graph ? rel(entry) : null,
      modules: graph?.modules.size ?? 0,
    },
    mode,
    () =>
      stack(
        kv([
          { label: "file", value: rel(file) },
          { label: "context", value: headline },
          ...(chain
            ? [{ label: "reached by", value: chain.map(rel).join("  →  ") }]
            : []),
        ]),
        rules.map((r) => `  · ${r}`).join("\n"),
        `  the full map: ${WHERE_DOC}`,
      ),
  );
}
