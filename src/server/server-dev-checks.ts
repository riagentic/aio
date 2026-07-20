// Dev-mode startup validation — server-only import scanning + graph validation
import { join } from "@std/path";
import { type GraphResult, validateGraph } from "./graph-validator.ts";
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
      const isWarning = (c: string) =>
        c === "server-only-api" || c === "circular-dependency";
      const warnings = result.errors.filter((e) => isWarning(e.category));
      const blocking = result.errors.filter((e) => !isWarning(e.category));
      if (result.valid) {
        debug(
          `graph: ✓ ${result.modules.size} modules validated (${
            result.durationMs.toFixed(0)
          }ms)${warnings.length ? ` (${warnings.length} warnings)` : ""}`,
        );
      } else {
        for (const err of blocking) {
          debug(
            `graph: ✖ ${err.file}${
              err.line ? `:${err.line}` : ""
            } — ${err.message}`,
          );
          debug(`  FIX: ${err.fix}`);
        }
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
