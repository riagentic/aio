// server-vendor.ts — serve the framework's own browser-side npm deps locally.
// Dev/transpile mode used to resolve "immer" via the esm.sh CDN, which made
// DEV REQUIRE THE INTERNET (offline/air-gapped dev = blank screen). The dev
// server now serves immer from the local install at /__aio/vendor/immer.js;
// the CDN remains only as a fallback when no local copy can be found.

import { fromFileUrl, join } from "@std/path";
import { log } from "../diagnostics/logger-api.ts";
import { readAppLocalAliases } from "./server-html-importmap.ts";

/** Cached vendor module source (read + patched once per source), keyed by
 *  the app's own immer file ("" = the resolved install). */
const _immerSource = new Map<string, string | null>();

/** The app's OWN local immer (`"immer": "./vendor/immer.js"` in deno.json)
 *  as a path, else undefined. The bundle's alias gives the app AND the
 *  framework exactly this file, so the dev vendor route serves it too: one
 *  immer, dev and build alike (docs/build/imports.md). */
export function appLocalImmer(baseDir: string): string | undefined {
  const url = readAppLocalAliases(baseDir).immer;
  return url?.startsWith("file:") ? fromFileUrl(url) : undefined;
}

/** The candidate paths for a local immer ESM build, in order — as PLAIN
 *  FILESYSTEM PATHS, never URL strings.
 *
 *  This used to build `file://${Deno.cwd()}/…` by hand and read `.pathname`
 *  back off it. Both halves are lossy: a cwd of `/home/me/My Apps/proj`
 *  produced `/home/me/My%20Apps/…` (percent-encoded, so `statSync` throws),
 *  and on Windows `.pathname` yields `/C:/…`. Every candidate then failed, dev
 *  fell back to the esm.sh CDN WITHOUT a word, and the offline-dev guarantee
 *  this file exists for was gone on any machine whose path contains a space.
 *  `fromFileUrl` is the one conversion that survives both.
 *
 *  App's own install first (honors the app's version pin), then whatever the
 *  framework resolves against, then the framework repo's node_modules.
 *
 *  Exported as the test seam: the encoding contract is a unit test, not a
 *  filesystem accident. */
export function _immerCandidates(cwd: string = Deno.cwd()): string[] {
  const candidates = [join(cwd, "node_modules", "immer", "dist", "immer.mjs")];
  try {
    const url = import.meta.resolve("immer");
    if (url.startsWith("file:")) candidates.push(fromFileUrl(url));
  } catch { /* no resolvable immer — filesystem probes remain */ }
  try {
    candidates.push(
      join(
        fromFileUrl(new URL("../../node_modules", import.meta.url)),
        "immer",
        "dist",
        "immer.mjs",
      ),
    );
  } catch { /* bundled/non-file module URL — the cwd probe remains */ }
  return candidates;
}

/** The first candidate that exists on disk, or null. */
function resolveImmerPath(): string | null {
  for (const path of _immerCandidates()) {
    try {
      Deno.statSync(path);
      return path;
    } catch { /* next candidate */ }
  }
  return null;
}

/** The immer ESM source ready for the browser, or null when no local copy
 *  exists. `process.env.NODE_ENV` is substituted (the standard bundler
 *  define) — kept at "development" so immer's real error messages survive.
 *  `appImmer` (appLocalImmer) is THE source when given; one that cannot be
 *  read is said out loud, since the build cannot bundle it either. */
export function loadVendorImmer(appImmer?: string): string | null {
  const key = appImmer ?? "";
  const cached = _immerSource.get(key);
  if (cached !== undefined) return cached;
  const path = appImmer ?? resolveImmerPath();
  let src: string | null = null;
  if (path) {
    try {
      src = Deno.readTextFileSync(path).replaceAll(
        "process.env.NODE_ENV",
        '"development"',
      );
    } catch (e) {
      if (appImmer) {
        log.warn(
          `deno.json maps "immer" to ${appImmer}, which cannot be read ` +
            `(${
              e instanceof Error ? e.message : e
            }) — the page falls back to ` +
            `the CDN copy, and the build cannot bundle it at all.`,
        );
      }
    }
  }
  _immerSource.set(key, src);
  return src;
}

/** True when the dev server can serve immer itself (no CDN needed). */
export function hasVendorImmer(appImmer?: string): boolean {
  return loadVendorImmer(appImmer) !== null;
}

/** Test hook — clear the cache so resolution runs again. */
export function _resetVendorCache(): void {
  _immerSource.clear();
}
