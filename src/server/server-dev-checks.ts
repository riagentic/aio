// Dev-mode startup validation — server-only import scanning + graph validation
import { join } from "@std/path";
import {
  BLOCKING_CATEGORIES,
  type GraphResult,
  validateGraph,
} from "./graph-validator.ts";
import { transpile } from "./server-transpile.ts";

/** Regex matching non-type imports from @std/ or node: — these fail in the browser */
const SERVER_ONLY_RE =
  /(?:import|export)\s+(?!type\s).*?\s+from\s+['"]((?:@std\/|node:)[^'"]+)['"]/g;

/** Scan src/ files for server-only imports that would fail in the browser */
export function scanServerOnlyImports(
  absBaseDir: string,
  debug: (msg: string) => void,
): void {
  const scanFiles: string[] = [];
  try {
    for (const entry of Deno.readDirSync(absBaseDir)) {
      if (
        entry.isFile &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.endsWith(".test.ts")
      ) {
        scanFiles.push(entry.name);
      }
    }
    // Check cells/ subdirectory if it exists
    try {
      for (const entry of Deno.readDirSync(join(absBaseDir, "cells"))) {
        if (
          entry.isFile && entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts")
        ) {
          scanFiles.push("cells/" + entry.name);
        }
      }
    } catch { /* no cells dir */ }
  } catch { /* can't read dir */ }

  for (const name of scanFiles) {
    try {
      const content = Deno.readTextFileSync(join(absBaseDir, name));
      // Only check files with cell() definitions or .tsx
      if (!content.includes("cell(") && !name.endsWith(".tsx")) continue;
      for (const m of content.matchAll(SERVER_ONLY_RE)) {
        const lineIdx = content.slice(0, m.index).split("\n").length;
        debug(
          `⚠ ${name}:${lineIdx} — "${
            m[1]
          }" is server-only, will fail in browser`,
        );
        debug(`  fix: move to server-only file or use dynamic import`);
      }
    } catch { /* file not found */ }
  }
}

function fileExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Handle returned by startGraphValidation — await done, read/update result */
export interface GraphValidationHandle {
  done: Promise<void>;
  getResult: () => GraphResult | null;
  setResult: (r: GraphResult) => void;
}

/** Start async graph validation. Returns handle to await completion and read result. */
export function startGraphValidation(
  absBaseDir: string,
  importMapObj: Record<string, string>,
  debug: (msg: string) => void,
  uiEntry = "App.tsx", // AIO-8.1
): GraphValidationHandle {
  let graphResult: GraphResult | null = null;
  const entrypoint = join(absBaseDir, uiEntry);

  if (!fileExists(entrypoint)) {
    const set = (r: GraphResult) => {
      graphResult = r;
    };
    return {
      done: Promise.resolve(),
      getResult: () => graphResult,
      setResult: set,
    };
  }

  const graphTranspile = (s: string, f: string) => transpile(s, f);
  const done = validateGraph(entrypoint, importMapObj, graphTranspile)
    .then((result) => {
      graphResult = result;
      // server-only-import is a GUARANTEED client break (sandboxed renderer
      // can't load node:/omitted-aio-symbols) → blocking. server-only-api
      // (conditional Deno.* / maybe-safe @std) + circular imports are warnings.
      // ONE decider for "does this break the client", shared with the
      // diagnostic page (`BLOCKING_CATEGORIES`). This used to be a second,
      // hand-written list of the WARNING categories — it happened to agree, and
      // the first new category would have split them silently: the terminal
      // calling something a warning while the browser served the you-are-broken
      // page, or the reverse.
      const warnings = result.errors.filter((e) =>
        !BLOCKING_CATEGORIES.has(e.category)
      );
      const blocking = result.errors.filter((e) =>
        BLOCKING_CATEGORIES.has(e.category)
      );
      if (result.valid) {
        debug(
          `graph: ✓ ${result.modules.size} modules validated (${
            result.durationMs.toFixed(0)
          }ms)${warnings.length ? ` (${warnings.length} warnings)` : ""}`,
        );
      } else {
        // Blocking = guaranteed client break. The diagnostic page covers the
        // browser; print loudly here too so the terminal names the file even
        // if no browser is open.
        console.error(
          `[aio] graph: ${blocking.length} error(s) will break the browser client:`,
        );
        for (const err of blocking) {
          console.error(
            `  ✖ ${err.file}${err.line ? `:${err.line}` : ""} — ${err.message}`,
          );
          console.error(`    FIX: ${err.fix}`);
        }
        // What ✖ MEANS, in the terminal, every time. A field report read the
        // two blocks as "an error and a warning printed together while dev
        // started anyway" — a hard error that does not stop the process reads
        // as a warning with a scarier icon unless the consequence is stated.
        // The server deliberately keeps running (the fix hot-reloads); it is
        // just not serving the app while it does.
        console.error(
          `  ⛔ the browser is being served the DIAGNOSTIC PAGE, not your app` +
            ` — the fix hot-reloads, no restart needed.`,
        );
      }
      // server-only-api = CONDITIONAL break (Deno.* in a client-reachable
      // module blank-screens only when that path runs in the browser). It was
      // debug-only — invisible in a normal `deno task dev` terminal — which is
      // exactly the "green locally, blank screen in the browser" trap from the
      // machine field report (U1). Print a compact, always-visible warning
      // block naming each file:line. Dev-stricter only; prod is untouched.
      // Only EAGER (statically-reachable) server-only usage can blank-screen —
      // that's the always-visible warning. `deferred` findings live behind a
      // dynamic import (the escape hatch), so the browser never loads them:
      // report those quietly at debug level, not in the loud block.
      const allApi = warnings.filter((e) => e.category === "server-only-api");
      const apiWarnings = allApi.filter((e) => !e.deferred);
      const deferredCount = allApi.length - apiWarnings.length;
      if (apiWarnings.length > 0) {
        const MAX_SHOWN = 10;
        console.warn(
          `[aio] graph: server-only API reachable from the browser bundle ` +
            `(blank-screens if it runs client-side):`,
        );
        for (const err of apiWarnings.slice(0, MAX_SHOWN)) {
          console.warn(
            `  ⚠ ${err.file}${err.line ? `:${err.line}` : ""} — ${err.message}`,
          );
        }
        if (apiWarnings.length > MAX_SHOWN) {
          console.warn(`  … and ${apiWarnings.length - MAX_SHOWN} more`);
        }
        console.warn(
          `  Fix: move server-only I/O into a *.server.ts module and ` +
            `dynamic-import it from the cell method (docs/build/imports.md).`,
        );
      }
      if (deferredCount > 0) {
        debug(
          `graph: ${deferredCount} server-only symbol(s) behind dynamic ` +
            `imports (server-only path — not in the browser bundle)`,
        );
      }
      if (result.durationMs > 1000) {
        debug(
          `graph: ⚠ validation took ${
            result.durationMs.toFixed(0)
          }ms (budget: 1000ms)`,
        );
      }
    }).catch((err) => debug(`graph: startup validation failed — ${err}`));

  const setResult = (r: GraphResult) => {
    graphResult = r;
  };
  return { done, getResult: () => graphResult, setResult };
}
