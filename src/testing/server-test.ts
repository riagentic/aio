// server-test.ts — `testServer()` + `testBrowser()` (realitio).
//
// Apps hand-rolled two harnesses in every e2e file: a libraryMode boot with a
// free port + temp data dir, and a headless-chromium launcher that leaked
// browser processes when Deno died. Both are packaged here, `await using`-ready.

import { aio } from "../server/aio.ts";
import type { AioApp, CellsConfig } from "../server/aio-types.ts";

/** A booted test app — its URL, the app handle, and fetch/state/close helpers.
 *  `await using` disposes it (closes the app + removes the temp data dir). */
export interface TestServer<S = unknown> {
  /** Base URL, e.g. `http://127.0.0.1:9123`. */
  url: string;
  port: number;
  /** The `aio.run()` handle — dispatch, getState, sessions, etc. */
  app: AioApp<S>;
  /** `fetch` against the server — pass a path (`"/api/x"`) or a full URL. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The server-authoritative state. */
  state(): S;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Grab a free TCP port by binding to 0 and releasing it. Use it for any test
 *  server the harness doesn't boot for you — a hand-picked or pid-derived port
 *  eventually collides with another test file and flakes the suite. */
export function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** Boot an aio app for a test — libraryMode (never exits the process), a free
 *  port, a throwaway data dir, and `persist: false` by default. Everything is
 *  overridable via `config` (pass `persist: true`, a fixed `port`, `routes`,
 *  `users`, …). `await using srv = await testServer({ cells: [...] })`. */
export async function testServer<S = unknown>(
  config: CellsConfig,
): Promise<TestServer<S>> {
  const port = config.port ?? freePort();
  const madeDir = !config.baseDir;
  const baseDir = config.baseDir ??
    await Deno.makeTempDir({ prefix: "aio-test-srv-" });
  const app = await aio.run({
    client: "server-only",
    persist: false,
    appId: `test-${crypto.randomUUID().slice(0, 8)}`,
    ...config,
    // Forced — a test must never let aio.run() call Deno.exit(), and the port /
    // dir are ours to manage.
    libraryMode: true,
    port,
    baseDir,
  }) as AioApp<S>;
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    await app.close();
    if (madeDir) {
      // The logger is a process-wide singleton pointed at THIS app's baseDir.
      // Deleting the directory under it leaves every later write failing into a
      // hole — visible as a stream of "[logger] write failed for …/.aio/logs"
      // during unrelated tests, which is noise that trains people to ignore log
      // output. Flush what is pending, then detach before the directory goes.
      try {
        const { getLogger, setLogger } = await import(
          "../diagnostics/logger-api.ts"
        );
        await getLogger()?.flush(200);
        setLogger(null);
      } catch { /* no logger configured — nothing to detach */ }
      await Deno.remove(baseDir, { recursive: true }).catch(() => {});
    }
  };
  return {
    url,
    port,
    app,
    fetch: (path, init) =>
      fetch(path.startsWith("http") ? path : url + path, init),
    state: () => app.getState() as S,
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** A launched headless browser tab pointed at a URL. `await using` (or
 *  `close()`) kills the process and removes its temp profile. */
export interface TestBrowser {
  proc: Deno.ChildProcess;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

const CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Locate a headless-capable Chromium/Chrome binary, or null. */
export function findChromium(): string | null {
  const env = Deno.env.get("CHROMIUM_BIN") ?? Deno.env.get("CHROME_BIN");
  if (env) return env;
  for (const c of CHROMIUM_PATHS) {
    try {
      Deno.statSync(c);
      return c;
    } catch { /* next */ }
  }
  return null;
}

/** Launch a headless Chromium tab against `url` and OWN its lifecycle — the
 *  process is killed and its profile removed on `close()`, and an `unload`
 *  backstop kills it even if Deno dies mid-test (the orphaned-chrome leak).
 *  Throws a clear error when no browser is found (pass `{ browserPath }` or set
 *  `$CHROMIUM_BIN`). Drive the tab through the app's `am surface`/`ui.*` over
 *  the trojan channel — this helper only manages the browser process. */
export function testBrowser(
  url: string,
  opts: { browserPath?: string; extraArgs?: string[] } = {},
): Promise<TestBrowser> {
  const bin = opts.browserPath ?? findChromium();
  if (!bin) {
    throw new Error(
      "testBrowser: no headless Chromium/Chrome found — install one, set " +
        "$CHROMIUM_BIN, or pass { browserPath }.",
    );
  }
  return (async () => {
    const profile = await Deno.makeTempDir({ prefix: "aio-test-browser-" });
    const proc = new Deno.Command(bin, {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        ...(opts.extraArgs ?? []),
        url,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();

    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      try {
        proc.kill();
      } catch { /* already exited */ }
    };
    // Backstop: if the Deno process unloads without close(), don't leak chrome.
    const onUnload = () => kill();
    addEventListener("unload", onUnload);

    const close = async () => {
      removeEventListener("unload", onUnload);
      kill();
      await proc.status;
      await Deno.remove(profile, { recursive: true }).catch(() => {});
    };
    return { proc, close, [Symbol.asyncDispose]: close };
  })();
}
