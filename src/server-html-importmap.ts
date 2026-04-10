// Browser import map generation — npm packages → esm.sh CDN URLs.

import { CDN } from "./server-html-constants.ts";

/** Generates browser import map from framework defaults + deno.json npm packages.
 *  npm packages → esm.sh CDN URLs. jsr/local imports are skipped (handled differently). */
export function buildBrowserImportMap(
  denoImports: Record<string, string>,
): Record<string, string> {
  const imports: Record<string, string> = {
    "aio": "/__aio/ui.js",
    "aio/air": "/__aio/air.js",
    "aio/browser": "/__aio/ui.js",
    "aio/jsx-runtime": "/__aio/jsx-runtime.ts",
  };
  for (const [name, specifier] of Object.entries(denoImports)) {
    if (!specifier.startsWith("npm:")) continue;
    if (imports[name]) continue; // don't override defaults
    const bare = specifier.slice(4); // strip 'npm:'
    imports[name] = `${CDN}/${bare}`;
  }
  return imports;
}
