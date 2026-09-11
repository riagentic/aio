// stack-remap.ts — the one place that knows the client bundle's source map.
//
// The forwarder (browser/console-intercept.ts) sends a message, a call site and
// sometimes a stack. All three carry GENERATED positions, because a browser
// never applies a source map to the string form of `Error.stack` — devtools
// maps frames for display only. Whoever renders the text has to do it, and that
// is the server.
//
// ONE holder, set once per bundle. The alternative — each log writer parsing
// the map itself — is the "two deciders" shape: two caches of one fact, drifting
// the moment a reload replaces the bundle under one of them.

import {
  parseSourceMap,
  remapStack,
  type SourceMapIndex,
} from "./sourcemap.ts";

let _map: SourceMapIndex | null = null;
/** Positions are rewritten only for frames in the bundle this map describes.
 *  A stack can mention an extension's script or an already-mapped path, and
 *  running those through the bundle's map produces a confident wrong answer —
 *  worse than the generated position it replaced. */
let _only: RegExp = /$^/;

/** Install the client bundle's source map. `null` (or an unparseable map)
 *  clears it, and every remap becomes the identity — a reload that fails to
 *  produce a map must not leave the previous one in place, mapping new
 *  positions through an old bundle. */
export function setClientSourceMap(
  json: string | null | undefined,
  // REQUIRED, and no default. `src/diagnostics/` may not import `src/server/`
  // (the boundary matrix), so spelling the bundle's filename here would put a
  // second copy of `BUNDLE_JS` in a folder that cannot see the first — the
  // drift `one-fact-one-spelling` exists to catch, and which it catches even
  // in a comment. The caller knows the name; it is the one place that reads
  // the constant.
  bundleName: string,
): void {
  _map = json ? parseSourceMap(json) : null;
  const esc = bundleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  _only = new RegExp(`(^|/)${esc}$`);
}

/** Is a map installed? Used by the diagnostics that report why a position was
 *  not improved, so "no map" is never confused with "the map had no answer". */
export function hasClientSourceMap(): boolean {
  return _map !== null;
}

/** Rewrite every bundle position in `text` to its original source position.
 *  Identity when no map is installed, and identity for any position the map
 *  does not cover — best-effort by construction, like the call-site capture it
 *  serves. */
export function remapClientText(text: string): string {
  if (!_map || !text) return text;
  try {
    return remapStack(text, _map, { only: _only });
  } catch {
    // aio-ok: this sits inside the channel a browser reports its own errors
    // on. A remapper that throws takes the report with it, and the position it
    // was improving was already readable-if-useless.
    return text;
  }
}

/** Forget the installed map.
 *
 *  Its own function rather than `setClientSourceMap(null, …)`: clearing needs
 *  no bundle name, and inventing one to satisfy a parameter is how a literal
 *  gets re-introduced in the folder that may not read the constant. Called
 *  between tests by `_resetAioRuntime` — a map from one test remapping another
 *  test's forwarded positions is a wrong answer that looks like a right one. */
export function clearClientSourceMap(): void {
  _map = null;
  // Matches nothing: with no map installed there is nothing to scope, and a
  // leftover pattern would be a claim about a bundle that is not loaded.
  _only = /$^/;
}

/** @internal Test seam — drop the installed map.
 *
 *  The map is process-global by design (one bundle, one server), so a test
 *  that installs one would leak it into every file that ran after it — and the
 *  thing it leaks into is the channel a browser reports its own errors on.
 *  Nothing in `src/` calls this, and nothing should. */
// aio-ok: a test-only seam; src/ calling it would mean discarding a map it just loaded
export function _resetClientSourceMap(): void {
  clearClientSourceMap();
}
