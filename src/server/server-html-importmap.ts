// Browser import map generation — npm packages → esm.sh CDN URLs.

import { join, resolve } from "@std/path";
import { CDN } from "./server-html-constants.ts";

/** Read the app's `deno.json` imports — THE input to the browser import map.
 *
 *  Scaffolded apps keep the config at the project root (`baseDir/..`); flat
 *  apps (entry next to deno.json) and repo examples run from cwd. First
 *  readable config wins.
 *
 *  This lives beside the map builder because "which specifiers exist in the
 *  browser" is one fact with two askers: the dev server (which SERVES the map)
 *  and the startup linter (which warns about imports that won't resolve). The
 *  linter used to hand-maintain a copy of the framework defaults — and could
 *  not see npm packages at all, so every app that added an npm UI dependency
 *  got a confident "import 'x' won't work in browser — move it to a
 *  server-side .ts file" about an import the import map resolves fine. */
export function readAppDenoImports(baseDir: string): Record<string, string> {
  const absBaseDir = resolve(baseDir);
  const candidates = [
    join(absBaseDir, "..", "deno.json"),
    join(absBaseDir, "deno.json"),
    join(Deno.cwd(), "deno.json"),
  ];
  for (const candidate of candidates) {
    try {
      const imports = JSON.parse(Deno.readTextFileSync(candidate)).imports;
      if (imports && typeof imports === "object") {
        return imports as Record<string, string>;
      }
      return {};
    } catch {
      /* try next — missing/invalid config falls through to defaults */
    }
  }
  // Nothing readable. A `deno.jsonc` sitting right there is the likely reason,
  // and it is a SILENT one: the map is built without the app's npm packages, so
  // the browser fails to resolve a specifier that Deno resolves fine on the
  // server — a blank screen whose cause is a file extension. (`am` and the file
  // watcher both accept .jsonc, so an app can plausibly be using it.) Say it
  // once per path instead.
  for (const c of candidates) {
    const jsonc = c + "c";
    if (_warnedJsonc.has(jsonc)) continue;
    try {
      Deno.statSync(jsonc);
    } catch {
      continue;
    }
    _warnedJsonc.add(jsonc);
    console.warn(
      `[aio] ${jsonc} found but no readable deno.json — the browser import ` +
        `map is built from deno.json ONLY, so this app's npm imports will NOT ` +
        `resolve in the browser ("Failed to resolve module specifier"). ` +
        `Rename it to deno.json (JSON, no comments).`,
    );
  }
  return {};
}

const _warnedJsonc = new Set<string>();

/** Test isolation — re-arm the one-shot deno.jsonc warning. @internal */
export function _resetImportMapWarnings(): void {
  _warnedJsonc.clear();
}

/** Generates browser import map from framework defaults + deno.json npm packages.
 *  npm packages → esm.sh CDN URLs. jsr/local imports are skipped (handled differently).
 *  `opts.vendorImmer` — the dev server found a local immer and serves it at
 *  /__aio/vendor/immer.js (offline-capable dev; the CDN is only a fallback). */
export function buildBrowserImportMap(
  denoImports: Record<string, string>,
  opts: { vendorImmer?: boolean } = {},
): Record<string, string> {
  const imports: Record<string, string> = {
    "aio": "/__aio/ui.js",
    "aio/air": "/__aio/air.js",
    "aio/browser": "/__aio/ui.js",
    "aio/jsx-runtime": "/__aio/jsx-runtime.ts",
    // The built-in updates cell. A separate entry because importing it is how
    // an app opts in — it must resolve in the browser for a UI to bind
    // `updates.available`, and nowhere else.
    "aio/updates": "/__aio/updates.ts",
    "aio/feedback": "/__aio/feedback.ts",
  };
  for (const [name, specifier] of Object.entries(denoImports)) {
    if (!specifier.startsWith("npm:")) continue;
    if (imports[name]) continue; // don't override defaults
    const bare = specifier.slice(4); // strip 'npm:'
    imports[name] = `${CDN}/${bare}`;
  }
  // The framework's own browser-side runtime deps must resolve even when the
  // app's deno.json doesn't (or can't) list them — src/state-core.ts imports
  // "immer", so a missing mapping is a BLANK SCREEN in dev/transpile mode.
  // A local copy wins even over an app CDN pin: it resolves app-node_modules
  // first (so an app pin is honored via its own install) and works offline.
  // esm.sh is the last resort only. Keep the CDN version in sync w/ deno.json.
  if (opts.vendorImmer) imports["immer"] = "/__aio/vendor/immer.js";
  else imports["immer"] ??= `${CDN}/immer@10.2.0`;
  return imports;
}
