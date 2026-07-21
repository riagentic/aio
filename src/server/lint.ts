// Startup linter — validates config and src/ before running
// Extracted from aio.ts. Checks state, config, App.tsx, imports, dependencies.
import { ESBUILD_SPEC } from "../build/esbuild-shared.ts";

import { join } from "@std/path";
import { log } from "../diagnostics/logger.ts";

/** Startup lint result — ok/warn/hint/fail arrays */
export type Lint = {
  ok: string[];
  warn: string[];
  hint: string[];
  fail: string[];
};

/** Checks state, config, App.tsx existence, and common mistakes */
export async function lint(
  state: unknown,
  config: { reduce?: unknown; execute?: unknown },
  baseDir: string,
  prod = false,
  headless = false,
  useElectron = true,
): Promise<Lint> {
  const r: Lint = { ok: [], warn: [], hint: [], fail: [] };

  if (state == null) r.fail.push("initial state is null/undefined");
  else if (typeof state !== "object") {
    r.fail.push(`initial state must be an object, got ${typeof state}`);
  } else {
    const keys = Object.keys(state as Record<string, unknown>);
    r.ok.push(`state (${keys.length} keys)`);
    const reserved = keys.filter((k) => k === "$p" || k === "$d");
    if (reserved.length) {
      r.warn.push(
        `state has reserved key(s): ${
          reserved.join(", ")
        } — rename them (e.g. $p → _patch, $d → _delete). These are used internally for delta patches and will cause data corruption.`,
      );
    }
    // Check JSON-serializability — Date, Map, Set, functions etc. break persistence/broadcast
    try {
      const json = JSON.stringify(state);
      const after = JSON.stringify(JSON.parse(json));
      if (json !== after) {
        r.warn.push(
          "state loses data on JSON round-trip — use primitives + plain objects/arrays only (no Date, Map, Set, functions, BigInt)",
        );
      }
    } catch (e) {
      r.warn.push(`state is not JSON-serializable: ${e}`);
    }
  }

  if (typeof config.reduce !== "function") {
    r.fail.push(
      "config.reduce must be a function: (state, action) => { state, effects }",
    );
  } else r.ok.push("reduce");

  if (typeof config.execute !== "function") {
    r.fail.push("config.execute must be a function: (app, effect) => void");
  } else r.ok.push("execute");

  // Prod mode or headless: App.tsx not needed
  if (headless) {
    r.ok.push("headless (no App.tsx)");
  } else if (prod) {
    r.ok.push("prod");
  } else {
    const appFile = join(baseDir, "App.tsx");
    try {
      const src = await Deno.readTextFile(appFile);
      if (!src.includes("export default")) {
        r.warn.push(
          "App.tsx has no `export default` — add it so the framework can mount your component",
        );
      } else {
        r.ok.push("App.tsx");
      }
      if (src.includes("createRoot")) {
        r.hint.push(
          "App.tsx has createRoot — remove it, the framework handles mounting",
        );
      }
      if (/import\s+React[\s,{]/.test(src)) {
        r.hint.push(
          "App.tsx has `import React` — not needed, JSX transforms are automatic",
        );
      }
    } catch {
      r.fail.push(`App.tsx not found at ${appFile}`);
      r.hint.push(
        "  create it: export default function App() { return <div>Hello</div> }",
      );
    }
  }

  // Specifiers available in the browser import map — everything else silently fails
  // Keep in sync with buildBrowserImportMap in server-html-importmap.ts.
  const BROWSER_IMPORTS = new Set([
    "aio",
    "aio/air",
    "aio/browser",
    "aio/jsx-runtime",
    "immer",
  ]);

  try {
    for await (const entry of Deno.readDir(baseDir)) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const content = await Deno.readTextFile(join(baseDir, entry.name));
      if (
        content.includes("from '../dep/aio/") ||
        content.includes('from "../dep/aio/')
      ) {
        r.hint.push(
          `${entry.name}: import from 'aio' instead of '../dep/aio/...'`,
        );
      }
      // Check execute.ts for swapped params — first param named 'effect' suggests old (effect, app) order
      if (entry.name === "execute.ts") {
        const match = content.match(/function\s+execute\s*\(\s*(\w+)/);
        if (match && /^effect$/i.test(match[1] ?? "")) {
          r.hint.push(
            `execute.ts: first param is "${
              match[1]
            }" — signature is execute(app, effect), matching reduce(state, action)`,
          );
        }
        // Check for sync I/O anti-patterns
        if (
          content.includes("Deno.readTextFileSync") ||
          content.includes("Deno.readDirSync") ||
          content.includes("Deno.statSync")
        ) {
          r.warn.push(
            "execute.ts: sync I/O (readTextFileSync, readDirSync, statSync) blocks the dispatch loop — use async versions (readTextFile, readDir, stat) instead",
          );
        }
        if (content.includes("Deno.writeTextFileSync")) {
          r.warn.push(
            "execute.ts: sync file write (writeTextFileSync) blocks — use async writeTextFile instead",
          );
        }
      }
      // Check reduce.ts for heavy patterns
      if (entry.name === "reduce.ts") {
        if (/for\s*\([^)]+\)\s*\{[^}]{500}/.test(content)) {
          r.hint.push(
            "reduce.ts: large loop detected — consider moving heavy computation to an effect",
          );
        }
      }
      // Check .tsx files for imports that won't resolve in the browser
      // Dev mode transpiles but doesn't bundle — only import-mapped specifiers work
      if (!prod && entry.name.endsWith(".tsx")) {
        // Bare side-effect imports: import 'foo'
        for (
          const m of content.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)
        ) {
          const spec = m[1];
          if (
            !spec || spec.startsWith(".") || spec.startsWith("/") ||
            BROWSER_IMPORTS.has(spec)
          ) continue;
          r.warn.push(
            `${entry.name}: import "${spec}" won't work in browser — dev mode transpiles but doesn't bundle. Move this import to a server-side .ts file, or use the npm package via an effect.`,
          );
        }
        // Named/default imports and re-exports: import { x } from 'foo', export { x } from 'foo'
        for (
          const m of content.matchAll(
            /(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
          )
        ) {
          const spec = m[1];
          if (
            !spec || spec.startsWith(".") || spec.startsWith("/") ||
            BROWSER_IMPORTS.has(spec)
          ) continue;
          // import type is erased by TS — never reaches the browser
          if (
            m[0].startsWith("import type ") ||
            m[0].startsWith("import type{") ||
            /^import\s*\{[^}]*\btype\b/.test(m[0]) // AIO-276: detect inline type import
          ) continue;
          r.warn.push(
            `${entry.name}: import "${spec}" won't work in browser — dev mode transpiles but doesn't bundle. Move this import to a server-side .ts file, or use the npm package via an effect.`,
          );
        }
      }
    }
  } catch { /* baseDir doesn't exist — already caught above */ }

  // Check esbuild — needed for dev mode TSX transpilation.
  // B-5: probe reality, not the filesystem. The transpiler loads esbuild via
  // `import("npm:esbuild@0.24.2")` (Deno's npm cache — no node_modules/ needed),
  // so the old `node_modules/esbuild` stat produced a false "not installed"
  // warning on every standard dev boot and was cwd-dependent. Resolve the same
  // way the transpiler does; only warn if that genuinely fails.
  if (!prod) {
    try {
      // COMPUTED specifier (not a literal) so `deno install`/`cache` don't
      // eagerly fetch the esbuild native binary just to reach this probe — it
      // resolves at runtime, the same way the transpiler loads it. Keeps `am`
      // (which imports aio.ts → lint.ts for VERSION) esbuild-free at install.
      const esbuildPkg = ESBUILD_SPEC; // shared pin (build/esbuild-shared.ts)
      await import(esbuildPkg);
    } catch {
      r.warn.push(
        "esbuild not installed — dev mode needs it for TSX transpilation. " +
          "Run with network access once to populate Deno's npm cache.",
      );
    }
  }

  // Check electron install scripts — only relevant when actually running in Electron mode
  if (!prod && useElectron) {
    try {
      const electronDir = join(Deno.cwd(), "node_modules", "electron", "dist");
      await Deno.stat(electronDir);
    } catch {
      try {
        // electron package exists but dist/ missing → scripts not approved
        await Deno.stat(join(Deno.cwd(), "node_modules", "electron"));
        r.hint.push(
          "electron installed but dist/ missing — run `deno task install:electron`",
        );
      } catch { /* electron not installed at all — handled by electron.ts */ }
    }
  }

  return r;
}

/** Formats lint results — compact when clean, detailed when issues found */
export function printLint(r: Lint): void {
  const hasIssues = r.warn.length + r.hint.length + r.fail.length > 0;
  if (!hasIssues) {
    log.info(`✓ ${r.ok.join(" · ")}`);
    return;
  }
  log.info("── checks ──");
  if (r.ok.length) log.info(`  ✓ ${r.ok.join(" · ")}`);
  for (const w of r.warn) log.warn(w);
  for (const h of r.hint) log.info(`  · ${h}`);
  for (const e of r.fail) log.error(e);
  if (r.fail.length) {
    throw new Error(`${r.fail.length} error(s) — fix and restart`);
  }
}
