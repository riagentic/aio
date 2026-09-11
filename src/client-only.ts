/**
 * @module
 * `import "aio/client-only"` — this file must never be reached by a cell.
 *
 * The mirror of {@linkcode module:server-only} (trading-app report §9.1), and the halves are
 * not symmetric, because the two failures are not:
 *
 * - A server module in the browser LEAKS. Keys and queries end up in a file
 *   anyone can open, so it is refused at build and it throws at runtime.
 * - A browser module on the server BREAKS. It touches `window` at module scope
 *   and the render throws — loudly, immediately, with a stack. Nothing leaks,
 *   and nothing needs a second guard.
 *
 * So this one does not throw. aio renders server-side on purpose (SSR is a
 * feature, not an accident), and a module that legitimately runs in both places
 * during SSR must keep working. What it does is DECLARE, so the tools can say
 * so before the render does:
 *
 * ```ts
 * import "aio/client-only"
 *
 * export const chart = new ResizeObserver(…)   // needs a real layout
 * ```
 *
 * `aiol` refuses a cell that reaches it — a cell method runs on the server, so
 * a client-only import there is a statement that contradicts itself.
 */

/** Exported so the import is never tree-shaken away — see `SERVER_ONLY`.
 *  @internal */
export const CLIENT_ONLY = true;
