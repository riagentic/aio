// outside-app.ts — run a module load OUTSIDE every app's scope.
//
// Deno sets the ambient async context — the one a callback that Rust starts
// (the next `Deno.test`, a `Deno.serve` handler nobody wrapped, a signal)
// runs in — to the context in which an npm module is FIRST evaluated, and
// leaves it there. Measured on Deno 2.9: `als.run("X", () =>
// import("npm:base64-js"))` and every later `Deno.test` and unwrapped handler
// in the process reads `"X"`. Each `aio.run()` evaluated `npm:esbuild` (the
// boot lint's probe) inside its app scope, so after any boot the whole
// process's ambient context was THAT app's — for good, past its `close()`:
// "outside any app" code (a later test, another server) was charged to it.
//
// Loads the framework itself makes go through here. The snapshot is the
// context this module was evaluated in: aio's own static import graph, at
// module top level — no app's.
import { AsyncLocalStorage } from "node:async_hooks";

const _root = AsyncLocalStorage.snapshot();

/** `import(spec)`, evaluated outside any app (and any other async-context
 *  store) so the module's first evaluation cannot pin one as the process's
 *  ambient context. @internal */
export function importOutsideApp<T = Record<string, unknown>>(
  spec: string,
): Promise<T> {
  return _root(() => import(spec) as Promise<T>);
}
