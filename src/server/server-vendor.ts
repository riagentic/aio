// server-vendor.ts — serve the framework's own browser-side npm deps locally.
// Dev/transpile mode used to resolve "immer" via the esm.sh CDN, which made
// DEV REQUIRE THE INTERNET (offline/air-gapped dev = blank screen). The dev
// server now serves immer from the local install at /__aio/vendor/immer.js;
// the CDN remains only as a fallback when no local copy can be found.

/** Cached vendor module source (read + patched once per process). */
let _immerSource: string | null | undefined;

/** Locate the local immer ESM build. `import.meta.resolve` follows the
 *  package's "import" condition to dist/immer.mjs when a node_modules exists
 *  (framework repo, scaffolded apps — both ship one via nodeModulesDir). */
function resolveImmerPath(): string | null {
  // App's own install first (honors the app's version pin), then whatever
  // the framework resolves against, then the framework repo's node_modules.
  const candidates: string[] = [
    `file://${Deno.cwd()}/node_modules/immer/dist/immer.mjs`,
  ];
  try {
    const url = import.meta.resolve("immer");
    if (url.startsWith("file:")) candidates.push(url);
  } catch { /* no resolvable immer — filesystem probes remain */ }
  candidates.push(
    `file://${
      new URL("../../node_modules", import.meta.url).pathname
    }/immer/dist/immer.mjs`,
  );
  for (const c of candidates) {
    try {
      const path = new URL(c).pathname;
      Deno.statSync(path);
      return path;
    } catch { /* next candidate */ }
  }
  return null;
}

/** The immer ESM source ready for the browser, or null when no local copy
 *  exists. `process.env.NODE_ENV` is substituted (the standard bundler
 *  define) — kept at "development" so immer's real error messages survive. */
export function loadVendorImmer(): string | null {
  if (_immerSource !== undefined) return _immerSource;
  const path = resolveImmerPath();
  if (!path) {
    _immerSource = null;
    return null;
  }
  try {
    _immerSource = Deno.readTextFileSync(path).replaceAll(
      "process.env.NODE_ENV",
      '"development"',
    );
  } catch {
    _immerSource = null;
  }
  return _immerSource;
}

/** True when the dev server can serve immer itself (no CDN needed). */
export function hasVendorImmer(): boolean {
  return loadVendorImmer() !== null;
}

/** Test hook — clear the cache so resolution runs again. */
export function _resetVendorCache(): void {
  _immerSource = undefined;
}
