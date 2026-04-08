// deno-lint-ignore-file
/**
 * @module
 * React renderer — `aio/react`.
 *
 * Browser-side rendering with React hooks. For server/universal APIs, import from `aio`.
 *
 * @example
 * ```ts
 * import { aio, cell } from "aio";                // state (universal)
 * import { useCell, useLocal } from "aio/react";   // rendering (browser)
 * ```
 */

// ── Full React runtime (hooks, routing, protocol) ────────────────────
export * from "./browser.ts";
