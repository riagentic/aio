// Barrel re-export — all HTML generation utilities.
// Split into focused modules; this file preserves the original public API.

export { MIME, TEXT_EXTENSIONS } from "./server-html-constants.ts";
export { buildBrowserImportMap } from "./server-html-importmap.ts";
export { generateHTML } from "./server-html-gen.ts";
export { generateDiagnosticHTML } from "./server-html-diagnostic.ts";
export { classifyBrowserError } from "./server-html-classify.ts";
