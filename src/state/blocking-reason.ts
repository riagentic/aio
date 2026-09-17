// blocking-reason.ts — the ONE sentence `blocking()` refuses a runtime with.
//
// Its own module, with no imports and no top-level statements, because two
// callers need it: blocking.ts (on a runtime without Deno) and the browser
// entry's `blocking` facade (src/browser-air.ts), which must not import
// blocking.ts — that module's facade assignments (`blocking.cancel = …`) are
// statements esbuild cannot drop, so importing it would put the whole worker
// pool on every page. Pure.

/** Why `blocking(id, …)` cannot run outside Deno, as a platform fact with a
 *  fix rather than `Worker is not defined` three frames down. */
export const blockingServerOnly = (id: string): string =>
  `[aio] blocking('${id}') is server-only — it runs a Deno worker ` +
  `pool, which does not exist in a browser/WebView (standalone) runtime. ` +
  `Call it from a server-side method and let the client read the result ` +
  `from state.`;
