/**
 * @module
 * `serverImport("./claude.server.ts", import.meta.url)` — a dynamic import a
 * TEST can stand in for.
 *
 * A field report (cc §8.6, §9.3) named a cell there is no safe rung for. It
 * owns an OS process: `testCell` never reaches the spawn, and `bootCells`
 * spawns the REAL child — so "random actions against a real runtime" means a
 * real `claude` subprocess per action. Cassettes wrap a function you can
 * reach; they cannot wrap `await import("./claude.server.ts")` inside a method.
 *
 * Nothing can intercept a raw `await import(…)` in Deno — there is no loader
 * hook a test process can install after the fact. So the seam has to be a
 * function the app calls on purpose:
 *
 * ```ts
 * // in the cell
 * const { run } = await serverImport<typeof import("./claude.server.ts")>(
 *   "./claude.server.ts", import.meta.url,
 * )
 * ```
 * ```ts
 * // in the test
 * await bootCells([session], {
 *   stub: { "./claude.server.ts": { run: () => "canned" } },
 * })
 * ```
 *
 * That is a real ask of an app, and it is the whole price: unstubbed,
 * `serverImport` is one `await import` with the specifier resolved against the
 * caller — identical behaviour, no indirection at runtime, and the module stays
 * out of the browser bundle exactly as before (the audit reads the specifier,
 * not the spelling).
 *
 * Keyed by the SPECIFIER AS WRITTEN, not the resolved URL: a test stubs the
 * string it can see in the cell, never a `file:///…` it would have to compute.
 */

const _stubs = new Map<string, unknown>();

/** Install stubs for this process. Replaces, never merges — one boot's stubs
 *  silently applying to the next test is a green test over a module nobody
 *  meant to fake. */
export function setServerImportStubs(
  stubs: Record<string, unknown> | undefined,
): void {
  _stubs.clear();
  for (const [k, v] of Object.entries(stubs ?? {})) _stubs.set(k, v);
}

/** Clear them — teardown, and between tests. */
export function resetServerImportStubs(): void {
  _stubs.clear();
}

/** Which specifiers are currently stubbed. @internal */
// aio-ok: test seam — tests/server-import-stub.test.ts asserts the registry empties
export function _stubbedSpecifiers(): string[] {
  return [..._stubs.keys()];
}

/** Import a server-only module, or the stub a test installed for it.
 *
 *  `base` is `import.meta.url` at the call site. It is REQUIRED rather than
 *  inferred: a relative specifier resolved against the wrong module is a
 *  "module not found" three files from the cause, and there is no way to
 *  recover the caller's URL from inside a helper. */
export function serverImport<T = unknown>(
  specifier: string,
  base: string,
): Promise<T> {
  const stub = _stubs.get(specifier);
  if (stub !== undefined) return Promise.resolve(stub as T);
  // Unstubbed: exactly the `await import(…)` it replaces. The specifier is
  // resolved against the CALLER, which is what makes `./x.server.ts` mean the
  // same thing here as it does written inline.
  return import(new URL(specifier, base).href) as Promise<T>;
}
