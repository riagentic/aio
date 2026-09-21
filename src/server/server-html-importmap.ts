// Browser import map generation — npm packages → esm.sh CDN URLs.

import { readDenoJsonSync } from "./deno-json.ts";
import { dirname, join, resolve } from "@std/path";
import { CDN } from "./server-html-constants.ts";
import { log } from "../diagnostics/logger-api.ts";

/** How far up from a workspace member to look for the workspace root that
 *  holds the shared import map. A member two levels down is the documented
 *  layout (`packages/app`); the bound only stops a walk to `/`. */
const WORKSPACE_MAX_DEPTH = 8;

/** Read the app's `deno.json`/`deno.jsonc` imports — THE input to the browser
 *  import map, and (for `am check`) THE statement of what DENO can resolve.
 *
 *  Scaffolded apps keep the config at the project root (`baseDir/..`); flat
 *  apps (entry next to the config) and repo examples run from cwd. First
 *  readable config wins, and in a Deno workspace the root's imports are merged
 *  under the member's — exactly what Deno itself resolves with.
 *
 *  `null` means NOTHING was readable — a different fact from `{}` ("read it,
 *  it declares no imports"), and the two collapsed into one value is how
 *  `am check` reported three fabricated blocking errors ("`aio` is missing
 *  from this app's deno.json imports") against an app `deno check` accepts.
 *  Callers that only need a map for the browser coalesce with `?? {}`; the
 *  caller that GATES on the map must skip its gate on `null`.
 *
 *  This lives beside the map builder because "which specifiers exist in the
 *  browser" is one fact with two askers: the dev server (which SERVES the map)
 *  and the startup linter (which warns about imports that won't resolve). The
 *  linter used to hand-maintain a copy of the framework defaults — and could
 *  not see npm packages at all, so every app that added an npm UI dependency
 *  got a confident "import 'x' won't work in browser — move it to a
 *  server-side .ts file" about an import the import map resolves fine. */
export function readAppDenoImports(
  baseDir: string,
): Record<string, string> | null {
  const absBaseDir = resolve(baseDir);
  const candidates = [
    join(absBaseDir, ".."),
    absBaseDir,
    Deno.cwd(),
  ];
  for (const dir of candidates) {
    const found = readConfigDir(dir);
    if (!found) continue;
    return withWorkspaceImports(dir, ownImports(found.config));
  }
  return null;
}

/** The config in `dir` — BOTH names Deno accepts, read the way Deno reads
 *  them (JSONC). A file that exists and does not parse is not silence: it is
 *  said once, then treated as unreadable so the next candidate still gets a
 *  chance. */
function readConfigDir(
  dir: string,
): { config: Record<string, unknown>; path: string } | null {
  try {
    return readDenoJsonSync(dir);
  } catch (e) {
    const key = `parse:${dir}`;
    if (!_warned.has(key)) {
      _warned.add(key);
      log.warn(
        `[aio] ${e instanceof Error ? e.message : String(e)}\n` +
          `  Until it parses, aio cannot see this app's "imports": the ` +
          `browser import map is built from the framework defaults alone, ` +
          `and \`am check\` skips the deno.json import gate.`,
      );
    }
    return null;
  }
}

/** The config's own `imports`, or `{}` when it declares none. */
function ownImports(config: Record<string, unknown>): Record<string, string> {
  const imports = config.imports;
  return imports && typeof imports === "object" && !Array.isArray(imports)
    ? imports as Record<string, string>
    : {};
}

/** The member paths a workspace-root config lists, or null when it is not a
 *  workspace root. Deno spells it as an array; the object form carries the
 *  same list under `members`. */
function workspaceMembers(config: Record<string, unknown>): string[] | null {
  const ws = config.workspace;
  const nested = ws && typeof ws === "object" && !Array.isArray(ws)
    ? (ws as Record<string, unknown>).members
    : undefined;
  const list = Array.isArray(ws) ? ws : Array.isArray(nested) ? nested : null;
  return list ? list.filter((m): m is string => typeof m === "string") : null;
}

/** Deno workspaces: the ROOT's import map applies to every member, and the
 *  member's own entries override it. A member whose config declares no
 *  `imports` of its own therefore resolves `aio` perfectly well — `deno check`
 *  in it exits 0 — while reading the member config ALONE says "this app
 *  declares no aio imports" and fabricates a blocking `am check` error. So the
 *  root is found (walking up until an ancestor config lists this directory as
 *  a member) and merged underneath. */
function withWorkspaceImports(
  memberDir: string,
  memberImports: Record<string, string>,
): Record<string, string> {
  let dir = resolve(memberDir);
  const member = dir;
  for (let i = 0; i < WORKSPACE_MAX_DEPTH; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const found = readConfigDir(dir);
    if (!found) continue;
    const members = workspaceMembers(found.config);
    if (!members) continue;
    if (!members.some((m) => resolve(dir, m) === member)) continue;
    return { ...ownImports(found.config), ...memberImports };
  }
  return memberImports;
}

const _warned = new Set<string>();

/** Test isolation — re-arm the one-shot config warnings. @internal */
export function _resetImportMapWarnings(): void {
  _warned.clear();
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
    // The component kit. `docs/ui/kit.md` tells every app to
    // `import { Button, Input } from "aio/ui"` — and the specifier resolved
    // nowhere in the browser, so the page died on an unmapped bare import
    // (a blank screen) while fmt, check, lint, aiol, doctor and the whole test
    // suite stayed green: a field report hit exactly this. Anything the docs
    // tell an app to import from a PAGE has to be in this map.
    "aio/ui": "/__aio/ui/mod.ts",
    // React migration shims — PERMANENT surface (2026-07-06), and
    // docs/basics/migration.md shows them imported from a COMPONENT. Missing
    // here, that import was the `aio/ui` blank screen again: the symbols all
    // exist, so every gate stayed green while the page died on an unmapped
    // bare specifier. Safe to serve because these routes TRANSPILE rather than
    // bundle — `src/air-compat.ts` reaches `./air/compat.ts` at
    // `/__aio/air/compat.ts`, the same URL `/__aio/air.js` already loads, so
    // the browser instantiates AIR once, not twice.
    "aio/air/compat": "/__aio/air-compat.ts",
    // Adapter authors: docs/ui/air-advanced.md tells them to build on this.
    // Its module-level `enablePatches()` runs once for the same reason —
    // src/browser/* already reaches it at exactly this URL.
    "aio/state-core": "/__aio/state-core.ts",
    // `import "aio/client-only"` — the marker a module uses to declare that it
    // must not run on the server. It is imported BY browser code, so the
    // specifier has to resolve in a page or the import that declares the rule
    // is the thing that breaks it (the `aio/ui` blank screen, again). Three
    // lines and a constant; the generic /__aio/*.ts route serves it in dev and
    // the bundler inlines it in prod.
    //
    // `aio/server-only` is deliberately NOT here: it is in SERVER_ONLY_SPECS,
    // so a page that reaches it is told the category. Its whole purpose is to
    // be unreachable from a browser.
    "aio/client-only": "/__aio/client-only.ts",
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
