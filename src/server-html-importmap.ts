// Browser import map generation — npm packages → esm.sh CDN URLs.

import { CDN } from "./server-html-constants.ts";

/** Generates browser import map from framework defaults + deno.json npm packages.
 *  npm packages → esm.sh CDN URLs. jsr/local imports are skipped (handled differently).
 *  When renderer is "aio", React CDN entries are omitted and aio/jsx-runtime points to native JSX. */
export function buildBrowserImportMap(
  denoImports: Record<string, string>,
  renderer?: "react" | "aio",
): Record<string, string> {
  const imports: Record<string, string> = renderer === "aio"
    ? {
      "aio": "/__aio/ui.js",
      "aio/air": "/__aio/air.js",
      "aio/browser": "/__aio/ui.js",
      "aio/jsx-runtime": "/__aio/jsx-runtime.ts",
    }
    : {
      "react": `${CDN}/react@18.3.1`,
      "react-dom/client": `${CDN}/react-dom@18.3.1/client`,
      "react/jsx-runtime": `${CDN}/react@18.3.1/jsx-runtime`,
      "aio": "/__aio/ui.js",
      "aio/air": "/__aio/air.js",
      "aio/browser": "/__aio/ui.js",
    };
  for (const [name, specifier] of Object.entries(denoImports)) {
    if (!specifier.startsWith("npm:")) continue;
    if (imports[name]) continue; // don't override defaults
    const bare = specifier.slice(4); // strip 'npm:'
    imports[name] = `${CDN}/${bare}`;
  }
  return imports;
}
