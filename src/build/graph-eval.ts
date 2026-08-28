// graph-eval.ts — EVALUATE the browser bundle the way a browser does: link the
// whole graph and run every module's top level, once, at load.
//
// Dev serves the client one module at a time and never evaluates a statically
// imported module nothing calls; prod links the whole graph and evaluates it
// at load. An app passed 1283 tests, a real-browser boot gate and a manual
// pass, and the first evaluation of half its client graph happened on a
// user's machine: `ReferenceError: Buffer is not defined`, blank page. This
// is that evaluation, moved to where the author is.
//
// What runs: the bundle's module scope — every static import, every top-level
// statement — inside a Deno Worker whose Node globals (`Buffer`, `process`,
// `global`, …) and `Deno` namespace are DELETED first, so a reference that a
// browser cannot resolve throws here exactly as it would there. A permissive
// stub `window`/`document`/`navigator`/`location`/`localStorage` is installed
// so a module-scope `document.readyState` read is not a false refusal.
//
// What does NOT run: the app is not mounted (`mount()` is exported and never
// called; the Android entry's `boot()` waits for a DOMContentLoaded that never
// fires), no WebSocket is opened, no component renders. A render-time error
// is `testUI`'s job (aio/testing, under happy-dom); a load-time error is this
// one's. Same worker, same deletions, same stub in dev and in `deno task
// build` — one evaluator.

/** Everything a Worker is given that a browser tab is not. Deleted before
 *  the bundle is imported. */
const NOT_IN_A_BROWSER = [
  "Deno",
  "process",
  "Buffer",
  "global",
  "setImmediate",
  "clearImmediate",
];

const WORKER_SRC = `
const drop = ${JSON.stringify(NOT_IN_A_BROWSER)};
for (const k of drop) { try { delete globalThis[k]; } catch {} }
// A permissive DOM stand-in: any property is an object you can read from and
// call. Enough for module-scope feature reads; nothing is rendered.
const stub = (name) => new Proxy(function () {}, {
  get(_, p) {
    if (p === Symbol.toPrimitive) return () => "";
    if (p === "readyState") return "loading";
    if (p === "toString") return () => "[stub " + name + "]";
    if (p === "then") return undefined;
    return stub(name + "." + String(p));
  },
  apply() { return stub(name + "()"); },
  construct() { return stub("new " + name); },
  set() { return true; },
  has() { return true; },
});
for (const k of ["window", "document", "navigator", "location", "localStorage", "sessionStorage", "history"]) {
  if (!(k in globalThis)) globalThis[k] = stub(k);
}
self.onmessage = async (e) => {
  const { code, format, userAgent } = e.data;
  // The shell the bundle will really run in: a dependency that branches on
  // the user agent (an Electron renderer taking a Node path that needs
  // Buffer) must take THAT branch here too, or dev passes what the packaged
  // window throws on.
  if (userAgent) {
    const base = globalThis.navigator;
    globalThis.navigator = new Proxy(base, {
      get(t, p) {
        return p === "userAgent" ? userAgent : t[p];
      },
    });
  }
  try {
    if (format === "iife") {
      (0, eval)(code);
    } else {
      await import("data:text/javascript;base64," + btoa(unescape(encodeURIComponent(code))));
    }
    self.postMessage({ ok: true });
  } catch (err) {
    self.postMessage({
      ok: false,
      name: err && err.name || "Error",
      message: err && err.message || String(err),
    });
  }
};
`;

export type EvalResult =
  | { ok: true; ms: number }
  | {
    ok: false;
    ms: number;
    /** `ReferenceError` / `TypeError` / … / `timeout` */
    name: string;
    message: string;
    /** For `X is not defined`: the identifier. */
    undefinedName?: string;
  };

/** Evaluate a bundle's module scope in an isolated worker. Never throws:
 *  a bundle that cannot load is a RESULT, not a crash of the caller. */
/** The user agents the two shells present. Module scope in a dependency
 *  may branch on them; the evaluation runs under the one the artifact ships. */
export const EVAL_USER_AGENT = {
  browser:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  electron:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) aio Chrome/130.0 Electron/41.0 Safari/537.36",
} as const;

export async function evaluateBundle(
  code: string,
  format: "esm" | "iife",
  timeoutMs = 10_000,
  opts: { userAgent?: string } = {},
): Promise<EvalResult> {
  const t0 = performance.now();
  const url = URL.createObjectURL(
    new Blob([WORKER_SRC], { type: "application/javascript" }),
  );
  const worker = new Worker(url, { type: "module", name: "aio-graph-eval" });
  try {
    const verdict = await new Promise<EvalResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          ms: performance.now() - t0,
          name: "timeout",
          message:
            `the bundle's module scope did not finish within ${timeoutMs}ms ` +
            "(a top-level await that never settles, or a busy loop at load)",
        });
      }, timeoutMs);
      worker.onmessage = (e) => {
        clearTimeout(timer);
        const d = e.data as { ok: boolean; name?: string; message?: string };
        if (d.ok) resolve({ ok: true, ms: performance.now() - t0 });
        else {
          const message = d.message ?? "";
          resolve({
            ok: false,
            ms: performance.now() - t0,
            name: d.name ?? "Error",
            message,
            undefinedName: message.match(/^(\S+) is not defined/)?.[1],
          });
        }
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        e.preventDefault();
        resolve({
          ok: false,
          ms: performance.now() - t0,
          name: "Error",
          message: e.message,
          undefinedName: e.message.match(/(\S+) is not defined/)?.[1],
        });
      };
      worker.postMessage({ code, format, userAgent: opts.userAgent });
    });
    return verdict;
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}
