// blocking-worker.ts — generic off-thread task runner for schedule.blocking().
// Receives a SELF-CONTAINED function's source + a structured-cloneable arg,
// reconstructs and runs it here (off the main isolate), and posts the result.
// One task at a time — a blocking FFI/CPU call occupies the whole worker, which
// is the point: it can't freeze the main event loop / rendering.

type Req = { n: number; src: string; name?: string; arg: unknown };
type Res =
  | { n: number; ok: true; data: unknown }
  | { n: number; ok: false; error: string; stack?: string };

// A compiled build's minifier (`build.minify`, build/minify-server.ts) keeps
// every function and class name by calling ONE global, `__aioName(fn, "name")`
// — so a minified function's source carries those calls, and this isolate is
// where such a source is rebuilt. Defined here, by hand: a worker entry
// imports nothing, and aio itself may be the un-minified half (a remote
// import) of a minified app. Unused in dev, where nothing is minified.
(globalThis as Record<string, unknown>).__aioName ??= (
  target: object,
  value: string,
) => Object.defineProperty(target, "name", { value, configurable: true });

/** A `ReferenceError` out of a rebuilt function almost always means it was
 *  not self-contained: only its SOURCE crossed, so a variable, import or
 *  helper of the module it was written in does not exist here. The bare
 *  `x is not defined` reads as a typo in code that runs fine everywhere
 *  else — and in a minified build `x` is a name nobody wrote. */
function selfContainedHint(e: unknown): string | null {
  if (!(e instanceof ReferenceError) || !/ is not defined$/.test(e.message)) {
    return null;
  }
  return `${e.message}\n\n` +
    `blocking() runs its function in a Worker, rebuilt from the function's ` +
    `own source — so the function must be SELF-CONTAINED. It can use its ` +
    `argument, globals (Deno, crypto, fetch, …) and whatever it declares or ` +
    `\`await import(…)\`s inside its own body; a constant, import or helper ` +
    `of the module around it does not exist in the worker. Move it inside ` +
    `the function, or pass it as the argument. (In a compiled build the ` +
    `name above is the minified one.)`;
}

self.onmessage = async ({ data }: MessageEvent<Req>) => {
  const { n, src, name, arg } = data;
  try {
    // The function stringifies to a valid expression (arrow or `function …`);
    // wrap in parens so it parses as an expression, not a declaration.
    const fn = (0, eval)("(" + src + ")") as (a: unknown) => unknown;
    // The name it had where it was written: a minified source carries the
    // minifier's (`function e(){…}`), and a function may read its own `.name`.
    if (name) Object.defineProperty(fn, "name", { value: name });
    const out = await fn(arg);
    const res: Res = { n, ok: true, data: out };
    self.postMessage(res);
  } catch (e) {
    const res: Res = {
      n,
      ok: false,
      error: selfContainedHint(e) ??
        (e instanceof Error ? e.message : String(e)),
      stack: e instanceof Error ? e.stack : undefined,
    };
    self.postMessage(res);
  }
};
