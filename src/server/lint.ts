// Startup linter — validates config and src/ before running
// Extracted from aio.ts. Checks state, config, App.tsx, imports, dependencies.
import { UI_ENTRY } from "./app-files.ts";
import { ESBUILD_SPEC } from "../build/esbuild-shared.ts";

import { join } from "@std/path";
import {
  buildBrowserImportMap,
  readAppDenoImports,
} from "./server-html-importmap.ts";
import { log } from "../diagnostics/logger-api.ts";

/** The framework's own SERVER entries — absent from the browser import map ON
 *  PURPOSE (SQLite, workers, the filesystem). A generic "add the npm package"
 *  hint sends the user after a package that does not exist, so this category
 *  of mistake gets the real explanation. THE list also lives in
 *  graph-validator.ts's SERVER_ONLY_SPECS. */
const AIO_SERVER_SPECS = new Set(["aio/server"]);

/** Does a path exist? (`Deno.stat` without the throw.) @internal */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The warning for a bare specifier a `.tsx` file imports that the browser
 *  import map cannot resolve. Named so the two call sites (side-effect
 *  imports and named imports) cannot drift apart. @internal */
export function browserImportWarning(file: string, spec: string): string {
  if (AIO_SERVER_SPECS.has(spec)) {
    return `${file}: "${spec}" is aio's SERVER entry (SQLite, workers, the ` +
      `filesystem) imported from a browser file — the browser import map ` +
      `omits it deliberately, so the page dies at boot with "Failed to ` +
      `resolve module specifier". This is a server-only module in a client ` +
      `graph, NOT a missing dependency: there is no npm package to add. ` +
      `Move the import into a cell METHOD ` +
      `(\`const { createDB } = await import("${spec}")\` — methods run on ` +
      `the server), or into a *.server.ts module imported lazily.`;
  }
  return `${file}: import "${spec}" won't work in browser — dev mode ` +
    `transpiles but doesn't bundle. Map it for the browser ` +
    `(\`"${spec}": "npm:${spec}"\` in deno.json imports), or move the ` +
    `import to a server-side .ts file and reach it from a cell method.`;
}

/** Startup lint result — ok/warn/hint/fail arrays */
export type Lint = {
  ok: string[];
  warn: string[];
  hint: string[];
  fail: string[];
};

/** Checks state, config, App.tsx existence, and common mistakes.
 *  Public name (alpha52): `checkCells` — `lint` collided with aiol's project
 *  linter of the same name and is the deprecated alias through beta. */
export async function lint(
  state: unknown,
  config: { reduce?: unknown; execute?: unknown },
  baseDir: string,
  prod = false,
  headless = false,
  useElectron = true,
  // THE ui-entry decider's value (`ui.entry`, default App.tsx). The boot check
  // hardcoded "App.tsx", so an app that legitimately named another component
  // failed its OWN boot lint — the framework's second decider for a fact the
  // server already knows.
  uiEntry = UI_ENTRY,
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

  // Prod mode or headless: App.tsx not needed.
  //
  // Say what is TRUE, not what is usually true: `--client=server-only` on an
  // app that HAS an App.tsx printed "✓ headless (no App.tsx)" next to the file
  // sitting right there, which reads as "your component was not found".
  if (headless) {
    const hasUi = await exists(join(baseDir, uiEntry));
    r.ok.push(
      hasUi
        ? `headless (${uiEntry} present, not served — --client=server-only)`
        : `headless (no ${uiEntry})`,
    );
  } else if (prod) {
    r.ok.push("prod");
  } else {
    const appFile = join(baseDir, uiEntry);
    try {
      const src = await Deno.readTextFile(appFile);
      if (!src.includes("export default")) {
        r.warn.push(
          `${uiEntry} has no \`export default\` — add it so the framework can mount your component`,
        );
      } else {
        r.ok.push(uiEntry);
      }
      if (src.includes("createRoot")) {
        r.hint.push(
          `${uiEntry} has createRoot — remove it, the framework handles mounting`,
        );
      }
      if (/import\s+React[\s,{]/.test(src)) {
        r.hint.push(
          `${uiEntry} has \`import React\` — not needed, JSX transforms are automatic`,
        );
      }
    } catch {
      r.fail.push(`${uiEntry} not found at ${appFile}`);
      r.hint.push(
        "  create it: export default function App() { return <div>Hello</div> }",
      );
    }
  }

  // Specifiers available in the browser import map — everything else silently
  // fails in the browser. ASK THE MAP BUILDER, don't re-declare it: this was a
  // hand-maintained copy of the framework defaults ("keep in sync with…"), and
  // being a copy it could not know the app's own npm packages — which
  // buildBrowserImportMap DOES map (npm: → CDN). So an app that added a UI
  // dependency was told, on every boot, that a working import "won't work in
  // browser — move this import to a server-side .ts file". Following that
  // advice breaks working code; ignoring it teaches people to ignore the whole
  // check.
  const BROWSER_IMPORTS = new Set(
    Object.keys(buildBrowserImportMap(readAppDenoImports(baseDir))),
  );

  try {
    for await (const entry of Deno.readDir(baseDir)) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      // A test file is never part of the browser bundle, so browser-import and
      // legacy-path advice about it is pure noise (it fired on this repo's own
      // suite the moment a .test.tsx landed next to a booted app).
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      const content = await Deno.readTextFile(join(baseDir, entry.name));
      // Anchored to a real import/export STATEMENT: a file that merely mentions
      // the legacy path in a string (a lint rule, a test fixture) is not
      // importing from it. Same "a mention is not a use" rule aiol follows.
      if (
        /(?:^|\n)\s*(?:import|export)\b[^\n]*from\s*['"]\.\.\/dep\/aio\//
          .test(content)
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
            browserImportWarning(entry.name, spec),
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
            browserImportWarning(entry.name, spec),
          );
        }
      }
    }
  } catch {
    // aio-ok: baseDir not existing is already reported as a hard failure above,
    // and reporting it twice from one lint run reads as two problems.
  }

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
          "electron installed but its binary is missing (postinstall skipped) — " +
            "run `deno task install:electron`, " +
            "or `deno task dev:electron`/`compile:electron` (they auto-install)",
        );
      } catch {
        // aio-ok: this stat only distinguishes "installed but no binary" from
        // "not installed"; the not-installed case is reported by electron.ts
        // with the command that fixes it, so there is nothing to add here.
      }
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
    // The failures themselves, not just how many there were. They are printed
    // above by `log.error`, but this Error is the only thing that survives into
    // a test runner's report, `am logs --json`, or a supervisor's crash line —
    // and "3 error(s) — fix and restart" tells that reader nothing about WHICH
    // three. Carrying the text costs nothing and is the difference between a
    // report you can act on and one you have to go and re-run to understand.
    throw new Error(
      `${r.fail.length} configuration error(s) — fix and restart:\n` +
        r.fail.map((e) => `  • ${e}`).join("\n"),
    );
  }
}

/** Validate cell defs / startup config without booting — the alpha52 name of
 *  {@linkcode lint} (renamed: extras' `lint` collided with aiol's project
 *  linter; `lint` stays a working deprecated alias through beta). */
export const checkCells = lint;
