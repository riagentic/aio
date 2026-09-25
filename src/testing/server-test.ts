// server-test.ts — `testServer()` + `testBrowser()`.
//
// Apps hand-rolled two harnesses in every e2e file: a libraryMode boot with a
// free port + temp data dir, and a headless-chromium launcher that leaked
// browser processes when Deno died. Both are packaged here, `await using`-ready.

import { aio } from "../server/aio.ts";
import { _armTestStrict } from "./test-strict.ts";
import {
  _isolateWorkerCellsInProcess,
  _refuseWorkerCells,
  _shedLeakedScopes,
} from "./boot-refusals.ts";
import { dropTempDir, tempDir } from "./temp-dir.ts";
import { chromiumBin, findChromium, launchChromium } from "./chromium.ts";
// `-- --video=…` is the harness's flag in any test process that boots an app.
import "./harness-flags.ts";

export { findChromium };
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

/** How `worker: true` cells run under a test server.
 *
 *  - `"in-isolate"` (the default) — the cell's methods run on the test's own
 *    isolate. The SERIALIZATION boundary is still reproduced (arguments and
 *    return values are structured-cloned, `tests/prod-parity-worker-boundary.test.ts`),
 *    but isolation is not: the worker cell shares this isolate's module graph,
 *    so module-level state is shared where production keeps it separate.
 *  - `"real"` — spawn one real Deno worker per `worker: true` cell, from
 *    `workerEntry`. Its own heap, its own module graph, no shared module
 *    state — what a compiled app does. Costs a worker spawn per cell, so it is
 *    opt-in and paid for only by the tests that ask.
 *
 *  See docs/testing/prod-parity.md. */
export type TestWorkerMode = "in-isolate" | "real";

/** `testServer()` config — an `aio.run()` config plus the harness's own knobs. */
export type TestServerConfig = CellsConfig & {
  /** Host `worker: true` cells on real Deno workers. Requires `workerEntry`. */
  workers?: TestWorkerMode;
  /** With `workers: "real"`: the module a worker boots from — a REAL app entry
   *  that defines the same cells and calls `aio.run()` when it is a cell host:
   *
   *  ```ts
   *  // heavy-app.ts — imported by the test AND re-imported by the worker
   *  export const heavy = cell("heavy", { worker: true, ... });
   *  if (isCellWorker()) await aio.run({ cells: [heavy], libraryMode: true });
   *  ```
   *
   *  Pass `import.meta.resolve("./heavy-app.ts")`. It cannot default to
   *  `Deno.mainModule`: under a test that is the test file, and a worker on it
   *  would re-run the whole test in another thread. */
  workerEntry?: string | URL;
};

/** Resolve + check `workers`/`workerEntry`, returning the `_workerEntry` to
 *  pass through (or undefined for the default in-isolate mode).
 *
 *  Every branch here throws rather than degrading: a test that ASKED for real
 *  workers and silently got in-isolate ones is exactly the green-test/broken-
 *  prod trade this option exists to remove. */
function resolveWorkerMode(config: TestServerConfig): string | undefined {
  const { workers, workerEntry } = config;
  if (workers !== undefined && workers !== "in-isolate" && workers !== "real") {
    throw new Error(
      `testServer: workers must be "in-isolate" or "real" — got ` +
        `${JSON.stringify(workers)}.`,
    );
  }
  if (workers !== "real") {
    if (workerEntry !== undefined) {
      throw new Error(
        'testServer: workerEntry was given without workers: "real", so it ' +
          'would govern nothing. Add workers: "real", or drop workerEntry.',
      );
    }
    return undefined;
  }
  if (workerEntry === undefined) {
    throw new Error(
      'testServer: workers: "real" needs workerEntry — the module each cell ' +
        "worker boots from.\n" +
        "  It cannot be inferred: under a test the main module is the TEST " +
        "file, and a worker on it re-runs the test in another thread.\n" +
        '  Pass workerEntry: import.meta.resolve("./my-app.ts") — a module ' +
        "that defines the same cells and calls aio.run() when isCellWorker().\n" +
        "  (docs/testing/prod-parity.md)",
    );
  }
  const url = workerEntry instanceof URL ? workerEntry.href : workerEntry;
  if (!url.startsWith("file:")) {
    throw new Error(
      `testServer: workerEntry must be a file: URL (a worker cannot be ` +
        `spawned from "${url}"). Use import.meta.resolve("./my-app.ts").`,
    );
  }
  try {
    Deno.statSync(new URL(url));
  } catch (e) {
    throw new Error(
      `testServer: workerEntry "${url}" does not exist. Without this check ` +
        `the failure is a 30s "did not become ready" timeout at boot.`,
      { cause: e },
    );
  }
  const workerCells = (config.cells ?? [])
    .map((e) => ("__aio" in e ? e : e.cell))
    .filter((f) => f.__aio.worker === true)
    .map((f) => f.__aio.id);
  if (workerCells.length === 0) {
    throw new Error(
      'testServer: workers: "real" but no cell in `cells` has worker: true — ' +
        "the option would do nothing. Flag the cell, or drop the option.",
    );
  }
  return url;
}

/** Grab a free TCP port by binding to 0 and releasing it. Use it for any test
 *  server the harness doesn't boot for you — a hand-picked or pid-derived port
 *  eventually collides with another test file and flakes the suite. */
export function freePort(): number {
  const slice = portSlice(Deno.env.get(PORT_SLICE_ENV));
  if (slice) return fromSlice(slice);
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** Set by the parallel suite runner (scripts/test-shards.ts): this process's
 *  own port range, `"<first>-<last>"`, below the OS ephemeral range.
 *
 *  `port: 0` then close hands back a number that is free NOW — and with 16
 *  test processes each doing the same, another process's `port: 0` can be
 *  handed that number before the first one binds it (measured: "port 39827
 *  already in use" in the parallel suite). A slice nobody else draws from —
 *  not the other shards, not the OS's own ephemeral picks — cannot collide. */
const PORT_SLICE_ENV = "AIO_TEST_PORT_SLICE";

/** `"20000-20799"` → [20000, 20799], or null. Pure. */
function portSlice(v: string | undefined): [number, number] | null {
  const m = v ? /^(\d+)-(\d+)$/.exec(v) : null;
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a >= 1024 && b <= 65535 && a <= b ? [a, b] : null;
}

let _sliceNext = -1;
/** Every port this process has already handed out. */
const _issued = new Set<number>();

/** Test-only: forget what has been issued, so a test can drive the allocator
 *  through slice exhaustion without a 12,000-port loop. */
// aio-ok: a test seam — nothing in the product may forget an issued port.
export function _resetPortSlice(): void {
  _issued.clear();
  _sliceNext = -1;
}

/** The next port of `slice` that is free right now (bind-checked — another
 *  program may own one), round-robin so a just-closed port is not reused at
 *  once.
 *
 *  A port this process ALREADY HANDED OUT is skipped while any unissued one
 *  remains. "Free right now" is not the same question as "free for the caller
 *  to keep": a test file that takes a port at module load, then starts and
 *  stops its server per test, leaves that port genuinely free in between — so
 *  the cursor, having wrapped, handed the same port to a second file, and the
 *  first file's next `listen` failed with "port N already in use". That reads
 *  as a product bug and is a harness one, it needs a full shard to reproduce,
 *  and it is exactly as likely as the run being long enough to wrap: a shard
 *  of ~2,100 ports and ~270 test files is right at the boundary.
 *
 *  Exhausting the slice DEGRADES to the old behaviour rather than throwing —
 *  a reused port is a rare flake, and a suite that cannot start is not. */
/** Where THIS process starts walking the slice.
 *
 *  Not `first`. A slice is per-RUNNER, and a runner's process is not the only
 *  one drawing from it: the env var is inherited, so every child a test
 *  spawns shares the slice — and `tests/cookbook-recipes.test.ts` spawns a
 *  `deno test --parallel` whose four workers are four sibling processes, each
 *  with its own empty `_issued` set and its own cursor. Starting all of them
 *  at `first` makes them hand out THE SAME ports in THE SAME ORDER, so the
 *  collision is not a rare race: it is the design. Measured as `port 24256
 *  already in use` failing recipe 14 while recipe 15 held the port.
 *
 *  The pid is what distinguishes two live processes, so it is what spreads
 *  them. Siblings then walk different regions, and the bind check plus the
 *  round-robin handle the rest. This cannot make a cross-process bind race
 *  impossible — the OS can hand the same port to two `listen` calls between
 *  the check and the real bind — but it stops the case where they are walking
 *  in lockstep. */
function sliceStart(first: number, n: number): number {
  return first + (Deno.pid % n);
}

function fromSlice([first, last]: [number, number]): number {
  const n = last - first + 1;
  if (_sliceNext < first || _sliceNext > last) {
    _sliceNext = sliceStart(first, n);
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const port = _sliceNext;
      _sliceNext = port >= last ? first : port + 1;
      if (pass === 0 && _issued.has(port)) continue;
      try {
        Deno.listen({ port, hostname: "127.0.0.1" }).close();
        _issued.add(port);
        return port;
      } catch {
        // aio-ok: taken by something else — the next port in the slice
      }
    }
  }
  throw new Error(
    `freePort: every port in ${PORT_SLICE_ENV}=${first}-${last} is in use`,
  );
}

/** Is this the server's "that port is taken" refusal?
 *
 *  It has to be read off the MESSAGE: `createServer` catches
 *  `Deno.errors.AddrInUse` and rethrows a teachable plain `Error`, so the type
 *  is gone by the time a caller sees it. That makes the wording a second
 *  decider, which is why `tests/test-server-port-race.test.ts` matches this
 *  against an error a real doubled bind actually threw rather than against a
 *  copy of the sentence.
 *
 *  Pure. @internal harness wiring — not public API. */
export function _isPortTakenError(e: unknown): boolean {
  return /^port \d+ already in use/.test(
    e instanceof Error ? e.message : String(e),
  );
}

/** How many ports to try before giving up. Small on purpose: at three
 *  consecutive losses the slice is genuinely full and a fourth is noise. */
const PORT_RETRIES = 3;

/** Boot on a port nobody else grabbed first.
 *
 *  `freePort()` binds, closes, and hands back the number — so between that
 *  close and the server's real `listen` there is a window, and every sibling
 *  process drawing from the same inherited slice can win it. `sliceStart`
 *  spread the siblings so they stop walking in lockstep, and its own comment
 *  says what it could not do: "the OS can hand the same port to two `listen`
 *  calls between the check and the real bind". That residual race is what
 *  failed cookbook recipe 14 with `port 24325 already in use` in the v1.0.9
 *  release check — the second time the same recipe has been the one to lose.
 *
 *  A race that cannot be designed away is retried instead: the loser asks for
 *  another port. Only when the HARNESS chose the port — a caller who passed
 *  `port:` asked a question about that port, and quietly answering it on a
 *  different one would turn their fixed-port test green without testing
 *  anything. They get the refusal, first time, unchanged.
 *
 *  @internal harness wiring — not public API. */
export async function _bootOnAFreePort<S>(
  chosen: number | undefined,
  boot: (port: number) => Promise<AioApp<S>>,
): Promise<{ app: AioApp<S>; port: number }> {
  if (chosen !== undefined) return { app: await boot(chosen), port: chosen };
  let last: unknown;
  for (let i = 0; i < PORT_RETRIES; i++) {
    const port = freePort();
    try {
      return { app: await boot(port), port };
    } catch (e) {
      // Anything that is not "someone beat me to that port" is the test's
      // real failure and must surface NOW, undelayed and unretried.
      if (!_isPortTakenError(e)) throw e;
      last = e;
    }
  }
  throw new Error(
    `testServer: lost the port race ${PORT_RETRIES} times in a row. That is ` +
      `no longer a race — the slice (${
        Deno.env.get(PORT_SLICE_ENV) ?? "OS ephemeral"
      }) is full, or something outside the suite is taking ports as fast as ` +
      `they are offered. Last refusal: ${
        last instanceof Error ? last.message : String(last)
      }`,
    { cause: last },
  );
}

/** Boot an aio app for a test — libraryMode (never exits the process), a free
 *  port, a throwaway data dir, and `persist: false` by default. Everything is
 *  overridable via `config` (pass `persist: true`, a fixed `port`, `routes`,
 *  `users`, …). `await using srv = await testServer({ cells: [...] })`.
 *
 *  `worker: true` cells run in-isolate by default (a test owns the entry
 *  module, so there is nothing to host them from). Pass
 *  `{ workers: "real", workerEntry }` to spawn the real thing — separate heap,
 *  separate module graph — for the tests that need isolation reproduced.
 *  See docs/testing/prod-parity.md. */
export async function testServer<S = unknown>(
  config: TestServerConfig,
): Promise<TestServer<S>> {
  _armTestStrict(); // tests are the strictest environment, never the most permissive
  _shedLeakedScopes(); // the caller's body is no worker's code (see there)
  // Before anything is allocated — a misconfigured harness must not leave a
  // temp directory behind on its way to throwing.
  const workerEntryUrl = resolveWorkerMode(config);
  // `aio.run()` validates the worker cells it gets — after it has dropped the
  // client-scoped ones, so `worker: true` + `scope: "client"` is caught here.
  _refuseWorkerCells(
    (config.cells ?? []).map((e) => ("__aio" in e ? e : e.cell)),
  );
  // Harness-only keys: they must not reach aio.run(), which rejects an unknown
  // config key by design.
  const { workers: _w, workerEntry: _we, ...runConfig } = config;
  const madeDir = !config.baseDir;
  const baseDir = config.baseDir ?? await tempDir("aio-test-srv-");
  // A boot that THROWS never reaches close(), so the directory it made would
  // outlive the run — the leak class `scripts/check-orphans.ts` counts.
  let app: AioApp<S>;
  let port: number;
  try {
    ({ app, port } = await _bootOnAFreePort<S>(
      config.port,
      (port) =>
        aio.run({
          client: "server-only",
          persist: false,
          appId: `test-${crypto.randomUUID().slice(0, 8)}`,
          ...runConfig,
          ...(workerEntryUrl ? { _workerEntry: workerEntryUrl } : {}),
          // Forced — a test must never let aio.run() call Deno.exit(), and the
          // port / dir are ours to manage.
          libraryMode: true,
          port,
          baseDir,
        }) as Promise<AioApp<S>>,
    ));
  } catch (e) {
    if (madeDir) await dropTempDir(baseDir);
    throw e;
  }
  // In-isolate worker cells refuse what their real thread refuses (a peer
  // read, any method call) — see boot-refusals.ts. Real workers need nothing.
  const unisolate = workerEntryUrl
    ? () => {}
    : _isolateWorkerCellsInProcess(config.cells ?? []);
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    try {
      await app.close();
    } finally {
      unisolate();
    }
    if (madeDir) {
      // The logger is a process-wide singleton pointed at THIS app's baseDir.
      // Deleting the directory under it leaves every later write failing into a
      // hole — visible as a stream of "[logger] write failed for …/.aio/logs"
      // during unrelated tests, which is noise that trains people to ignore log
      // output. Flush what is pending, then detach before the directory goes.
      const { getLogger, setLogger } = await import(
        "../diagnostics/logger-api.ts"
      );
      try {
        await getLogger()?.flush(200);
      } catch (e) {
        // A sink whose flush REJECTS is a real fault and gets said out loud.
        // The old shape swallowed it AND skipped the detach below with it,
        // which re-opened the exact hole this block exists to close.
        console.error(
          `[testServer] log flush failed during teardown: ${e} — the tail of ` +
            `this app's log may be missing`,
        );
      } finally {
        // ALWAYS detach, flush or no flush: the directory is about to go.
        setLogger(null);
      }
      await dropTempDir(baseDir);
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
  // Resolved SYNCHRONOUSLY: a missing browser throws at the call, not later.
  const bin = chromiumBin("[testBrowser]", opts.browserPath);
  return launchChromium(bin, [...(opts.extraArgs ?? []), url]).then((
    { proc, close },
  ) => ({ proc, close, [Symbol.asyncDispose]: close }));
}
