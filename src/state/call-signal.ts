// call-signal.ts — the RUNNING method call's `s.$signal`, continuation-local.
//
// `blocking()` is called from inside a method body and outlives the call that
// started it unless it can see that call's signal: at shutdown the method was
// aborted, its caller released — and its task kept a worker thread (and, in
// libraryMode or under `testServer()`, the whole process) alive. The body runs
// inside `runWithCallSignal`, so code it calls — after any `await` — can ask.
//
// Isomorphic: an AsyncLocalStorage exists only on a server-side runtime, and
// this module is in the browser bundle, so it is looked up at run time
// (`process.getBuiltinModule`), never imported. Without one, both functions
// are pass-throughs.

type Store = {
  run<T>(signal: AbortSignal, fn: () => T): T;
  getStore(): AbortSignal | undefined;
};

let _als: Store | null | undefined;
function als(): Store | null {
  if (_als !== undefined) return _als;
  const get = (globalThis as {
    process?: { getBuiltinModule?: (id: string) => unknown };
  }).process?.getBuiltinModule;
  const mod = typeof get === "function"
    ? get("node:async_hooks") as
      | { AsyncLocalStorage?: new () => Store }
      | undefined
    : undefined;
  return _als = mod?.AsyncLocalStorage ? new mod.AsyncLocalStorage() : null;
}

/** Run a method body with its call's signal ambient. */
export function runWithCallSignal<T>(signal: AbortSignal, fn: () => T): T {
  const a = als();
  return a ? a.run(signal, fn) : fn();
}

/** The signal of the method call this code runs inside, if any. */
export function callSignal(): AbortSignal | undefined {
  return als()?.getStore();
}
