// blocking-worker.ts — generic off-thread task runner for schedule.blocking().
// Receives a SELF-CONTAINED function's source + a structured-cloneable arg,
// reconstructs and runs it here (off the main isolate), and posts the result.
// One task at a time — a blocking FFI/CPU call occupies the whole worker, which
// is the point: it can't freeze the main event loop / rendering.

type Req = { n: number; src: string; arg: unknown };
type Res =
  | { n: number; ok: true; data: unknown }
  | { n: number; ok: false; error: string; stack?: string };

self.onmessage = async ({ data }: MessageEvent<Req>) => {
  const { n, src, arg } = data;
  try {
    // The function stringifies to a valid expression (arrow or `function …`);
    // wrap in parens so it parses as an expression, not a declaration.
    const fn = (0, eval)("(" + src + ")") as (a: unknown) => unknown;
    const out = await fn(arg);
    const res: Res = { n, ok: true, data: out };
    self.postMessage(res);
  } catch (e) {
    const res: Res = {
      n,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    };
    self.postMessage(res);
  }
};
