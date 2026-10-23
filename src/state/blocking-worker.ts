// blocking-worker.ts — generic off-thread task runner for schedule.blocking().
// Receives a SELF-CONTAINED function's source + a structured-cloneable arg,
// reconstructs and runs it here (off the main isolate), and posts the result.
// One task at a time — a blocking FFI/CPU call occupies the whole worker, which
// is the point: it can't freeze the main event loop / rendering.

import { AsyncLocalStorage } from "node:async_hooks";

type Req = {
  n: number;
  /** The task's id, named when a stray it left behind lands later. */
  id?: string;
  src: string;
  name?: string;
  url?: string;
  arg: unknown;
  /** 1 while this thread is inside the task's synchronous call — read by the
   *  pool on cancel (see `syncCall`). */
  busy?: SharedArrayBuffer;
};
type Res =
  | { n: number; ok: true; data: unknown }
  | { n: number; ok: false; error: string; stack?: string };
/** An uncaught error on this worker's loop, with the task it belongs to
 *  (`n` 0: no task — it ran outside every task while none was running). */
type Stray = {
  stray: true;
  n: number;
  id?: string;
  error: string;
  stack?: string;
};

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

/** The function back from its source. An arrow or `function …` is an
 *  expression once parenthesised. A METHOD SHORTHAND (`const jobs = { hash(a)
 *  {…} }`, then `blocking("h", jobs.hash, x)`) is just as self-contained, but
 *  its source (`hash(a) {…}`, `async hash(a) {…}`) is a method definition —
 *  bare, it failed with "Unexpected token '{'". It is rebuilt inside an object
 *  literal, as it was written. */
function rebuild(src: string): (a: unknown) => unknown {
  try {
    return (0, eval)("(" + src + ")");
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    let obj: Record<string, unknown>;
    try {
      obj = (0, eval)("({" + src + "})");
    } catch {
      throw e; // not a method either — the expression's own error
    }
    const [fn] = Object.values(obj);
    if (typeof fn !== "function") throw e;
    return fn as (a: unknown) => unknown;
  }
}

// ── Whose is a stray error ────────────────────────────────────────────────
// A task that settled can leave work behind (a timer that throws, a promise
// it never awaited). Under load the next task is already running here when
// that error lands, and the worker's uncaught error used to be taken as THAT
// task's crash. Each task now runs in its own async context, so a stray says
// whose it is: a rejection carries the context it was made in, and a timer's
// throw is tagged by the wrapped timer it ran in (an error EVENT runs outside
// every context, measured on Deno 2.9).
const owner = new AsyncLocalStorage<{ n: number; id?: string }>();
const OWNER = Symbol("aio.blockingTask");
let running: { n: number; id?: string } | null = null;

function tagged<A extends unknown[], R>(
  fn: (...a: A) => R,
): (...a: A) => R {
  return function (this: unknown, ...a: A): R {
    try {
      return fn.apply(this, a);
    } catch (e) {
      if (e !== null && typeof e === "object" && !Object.hasOwn(e, OWNER)) {
        try {
          Object.defineProperty(e, OWNER, { value: owner.getStore() });
        } catch {
          // aio-ok: a frozen thrown object stays untagged — its stray is
          // taken as the running task's, the pre-1.0.21 rule.
        }
      }
      throw e;
    }
  };
}
const g = globalThis as unknown as Record<string, unknown>;
for (const k of ["setTimeout", "setInterval", "queueMicrotask"]) {
  const orig = g[k] as (cb: unknown, ...rest: unknown[]) => unknown;
  g[k] = (cb: unknown, ...rest: unknown[]) =>
    orig(
      typeof cb === "function" ? tagged(cb as () => unknown) : cb,
      ...rest,
    );
}

function stray(
  e: Event,
  error: unknown,
  ctx: { n: number; id?: string } | undefined,
  text: string,
): void {
  e.preventDefault(); // reported below; never re-raised in the parent
  const who = ctx ?? running; // untagged: the running task's, as before
  const res: Stray = {
    stray: true,
    n: who?.n ?? 0,
    id: who?.id,
    error: text,
    stack: error instanceof Error ? error.stack : undefined,
  };
  self.postMessage(res);
}
self.addEventListener("error", (e: ErrorEvent) => {
  const ctx = e.error !== null && typeof e.error === "object"
    ? (e.error as Record<symbol, { n: number; id?: string }>)[OWNER]
    : undefined;
  stray(e, e.error, ctx, e.message);
});
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const r = e.reason;
  stray(
    e,
    r,
    owner.getStore(),
    `Uncaught (in promise) ${
      r instanceof Error ? `${r.name}: ${r.message}` : String(r)
    }`,
  );
});

self.onmessage = ({ data }: MessageEvent<Req>) => {
  const ctx = { n: data.n, id: data.id };
  running = ctx;
  owner.run(ctx, () => runTask(data)).finally(() => {
    if (running === ctx) running = null;
  });
};

/** Call the task, flagging the SYNCHRONOUS part of the call. Deno's
 *  `Worker.terminate()` stops the event loop but does not interrupt running
 *  synchronous code (measured on Deno 2.9.7: a cancelled CPU loop kept its
 *  core until it returned), so the pool reads this flag to say so on cancel. */
function syncCall<T>(busy: Int32Array | null, call: () => T): T {
  if (busy) Atomics.store(busy, 0, 1);
  try {
    return call();
  } finally {
    if (busy) Atomics.store(busy, 0, 0);
  }
}

async function runTask(data: Req): Promise<void> {
  const { n, src, name, url, arg } = data;
  const busy = data.busy ? new Int32Array(data.busy) : null;
  try {
    // The module form (`pool.run(id, new URL(…), arg)`): a real module, with
    // its own imports — nothing is rebuilt from text.
    if (url !== undefined) {
      const job = (await import(url).catch((e) => {
        // Measured in a `deno compile` binary: a module nothing imports
        // statically is not in it, and the bare "Module not found" names a
        // path inside /tmp/deno-compile-… that reads as a broken install.
        if (!/module not found/i.test(String(e?.message))) throw e;
        throw new Error(
          `${e.message}\n\nblocking() imports this module in a Worker. In a ` +
            `compiled build it must be part of the binary: import it once ` +
            `from the app (\`import "./job.ts"\`), or pass it to the compile ` +
            `with --include.`,
        );
      })).default;
      if (typeof job !== "function") {
        throw new Error(
          `blocking(): ${url} has no default export that is a function — ` +
            `the worker calls \`export default (arg) => …\``,
        );
      }
      const res: Res = {
        n,
        ok: true,
        data: await syncCall(busy, () => job(arg)),
      };
      self.postMessage(res);
      return;
    }
    const fn = rebuild(src);
    // The name it had where it was written: a minified source carries the
    // minifier's (`function e(){…}`), and a function may read its own `.name`.
    if (name) Object.defineProperty(fn, "name", { value: name });
    const out = await syncCall(busy, () => fn(arg));
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
}
