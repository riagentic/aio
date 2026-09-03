// Transport-faithful e2e harness — the tool the in-process harness (testUI/
// testCell) can't be: it boots a REAL aio server and drives it in REAL headless
// Chromium over the REAL WebSocket wire, so subscription filtering, delta
// broadcast, offline queue, reconnect/replay, and browser Promise<void>
// semantics are all exercised. Keeps each e2e test compact.
//
// Skips cleanly when no Chromium is present (BROWSER === null → set `ignore`).

import { testDisplayEnv } from "../src/testing/test-display.ts";
import { aioTestDir } from "../src/testing/test-strict.ts";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { stopChild } from "./stop-child.ts";

// Route the spawned server's coverage into the parent's coverage dir when the
// suite runs under `--coverage` (DENO_COVERAGE_DIR is set by `deno test
// --coverage`). This is what makes e2e tests actually COUNT toward src/
// coverage — they exercise the real server (server-ws, broadcast, protocol,
// subscription filtering) that the in-process harness never touches. Outside a
// coverage run the var is unset, so we use a throwaway.
const _childCovDir = childCoverageDir();

const ROOT = new URL("..", import.meta.url).pathname;

export function findBrowser(): string | null {
  if (Deno.env.get("AIO_E2E") === "0") return null;
  for (
    const c of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ]
  ) {
    try {
      Deno.statSync(c);
      return c;
    } catch { /* next */ }
  }
  return null;
}
export const BROWSER: string | null = findBrowser();

export function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null> | (T | null),
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout: ${what}`);
}

// deno-lint-ignore no-explicit-any
export type SurfaceNode = any;

/** Find an element's text on a semantic surface by its `t`/testid name. */
export function findText(nodes: SurfaceNode[], name: string): string | null {
  for (const n of nodes ?? []) {
    for (const el of n.elements ?? []) {
      if (el.name === name) return el.text;
    }
    const c = findText(n.children ?? [], name);
    if (c !== null) return c;
  }
  return null;
}

export interface E2eApp {
  /** cells.ts source (exports cells). */
  cells: string;
  /** App.tsx source (default export a component). */
  app: string;
  /** Full app.ts override. Default imports cells for side-effect registration
   *  and calls aio.run({ persist: false, ...run }). */
  appTs?: string;
  /** Extra config spliced into the default aio.run({ persist: false, <run> }). */
  run?: string;
  /** Extra deno.json import-map entries. */
  imports?: Record<string, string>;
}

export interface Server {
  base: string;
  port: number;
  proc: Deno.ChildProcess;
  /** Kill the server process (e.g. to test reconnect). */
  stop(): Promise<void>;
  /** Read the server's authoritative state via the trojan channel. */
  state(): Promise<Record<string, unknown>>;
  /** `fetch` that blames the SERVER when it fails — attaches the child's
   *  output and whether it had already exited. A bare `fetch` here reports
   *  `TypeError: error sending request`, which says nothing about why. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  dir: string;
}

export interface Tab {
  index: number;
  proc: Deno.ChildProcess;
  close(): Promise<void>;
  /** This tab's rendered semantic surface. */
  surface(): Promise<SurfaceNode[]>;
  /** Text of a `t`-named element on this tab (or null if absent). */
  text(name: string): Promise<string | null>;
  /** Faithfully trigger a user action on this tab (click/type/press/…). */
  trigger(
    path: string,
    action: string,
    extra?: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }>;
}

async function writeApp(spec: E2eApp): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-e2e-" });
  await Deno.mkdir(`${dir}/src`);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "E2E Probe",
      // UNIQUE per scaffolded app. `appId` is inferred from deno.json when
      // `aio.run()` does not pass one (`single-instance-lock.ts`: appId > title
      // > name), so every e2e app in the repo used to resolve to the same id —
      // `e2e-probe` — and therefore shared ONE single-instance lock. Two e2e
      // servers alive at the same moment meant the second exited(1) with
      // "Already running", and the suite failed intermittently in whichever
      // test happened to boot alongside another. `testServer()` already
      // scopes its own apps this way.
      appId: `e2e-${crypto.randomUUID().slice(0, 8)}`,
      nodeModulesDir: "auto",
      unstable: ["kv"],
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "aio",
        lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      },
      imports: {
        "aio": `${ROOT}mod.ts`,
        "aio/air": `${ROOT}src/air.ts`,
        "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
        ...(spec.imports ?? {}),
      },
    }),
  );
  await Deno.writeTextFile(`${dir}/src/cells.ts`, spec.cells);
  await Deno.writeTextFile(`${dir}/src/App.tsx`, spec.app);
  const appTs = spec.appTs ??
    `import "./cells.ts";\nimport { aio } from "aio";\nawait aio.run({ persist: false${
      spec.run ? ", " + spec.run : ""
    } });`;
  await Deno.writeTextFile(`${dir}/src/app.ts`, appTs);
  return dir;
}

/** Boot a real aio server for the given app on a free port. */
export async function boot(spec: E2eApp): Promise<Server> {
  const dir = await writeApp(spec);
  const port = freePort();
  const base = `http://localhost:${port}`;
  const proc = spawnServer(dir, port);
  // A dead server is not a slow server, and `waitFor` swallows whatever its
  // probe throws — so the readiness loop is explicit here. A crash now reports
  // itself in milliseconds with its own stack trace instead of burning the
  // full 120s and then saying only "timeout: server up".
  // In a holder, not a bare `let`: the only assignment is inside a callback,
  // which TS narrows away to `never` at the read below.
  const ex: { st: Deno.CommandStatus | null } = { st: null };
  proc.status.then((st) => ex.st = st).catch(() => {});
  const fail = async (why: string): Promise<never> => {
    try {
      proc.kill();
    } catch { /* already gone */ }
    // Let the drain loops catch the child's final pipe chunks (bounded), so
    // the message carries the whole stack trace, not a race-truncated prefix.
    await settleOutput(proc);
    throw new Error(
      `${why}\n--- server output (last ${CHILD_LOG_CAP}B) ---\n` +
        serverOutput(proc),
    );
  };
  const deadline = Date.now() + 120_000;
  let up = false;
  while (Date.now() < deadline) {
    if (ex.st) {
      await fail(
        `server exited before it was ready (code ${ex.st.code}` +
          `${ex.st.signal ? `, signal ${ex.st.signal}` : ""})`,
      );
    }
    try {
      // Per-attempt ceiling. Without it a server that ACCEPTS the connection
      // and then never answers (a wedged worker, a blocked boot) parks the
      // whole 120s inside one fetch, and the loop above never gets to notice
      // the child died.
      const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(5_000) });
      await r.body?.cancel();
      if (r.ok) {
        up = true;
        break;
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) {
    // The final 150ms sleep can hide a death — re-check before claiming the
    // server is merely slow.
    await fail(
      ex.st
        ? `server exited while waiting (code ${ex.st.code}` +
          `${ex.st.signal ? `, signal ${ex.st.signal}` : ""})`
        : "timeout: server up (still running, never answered on /)",
    );
  }

  return {
    base,
    port,
    proc,
    dir,
    async stop() {
      await stopChild(proc, { quiet: true });
    },
    async state() {
      return await (await guardedFetch("/__aio/trojan/state")).json();
    },
    /** `fetch` against the server that BLAMES THE SERVER when it fails.
     *
     *  A crash after readiness used to surface as a bare
     *  `TypeError: error sending request` — the child's stack trace was
     *  captured all along (`serverOutput`) and simply never attached, so the
     *  one thing that said WHY was the one thing the failure did not print. */
    fetch: guardedFetch,
  };

  async function guardedFetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    {
      try {
        return await fetch(
          path.startsWith("http") ? path : `${base}${path}`,
          { signal: AbortSignal.timeout(30_000), ...init },
        );
      } catch (e) {
        const st = ex.st;
        throw new Error(
          `request to ${path} failed: ${e instanceof Error ? e.message : e}` +
            (st
              ? ` — the server had EXITED (code ${st.code}${
                st.signal ? `, signal ${st.signal}` : ""
              })`
              : " — the server is still running") +
            `\n--- server output (last ${CHILD_LOG_CAP}B) ---\n` +
            serverOutput(proc),
          { cause: e },
        );
      }
    }
  }
}

/** The last N KB a spawned server wrote. Enough to carry a stack trace, small
 *  enough that a chatty app cannot grow the test process without bound. */
const CHILD_LOG_CAP = 8192;

/** Live output of a spawned server, drained continuously. Piping without
 *  draining would fill the OS pipe buffer and WEDGE the child — the exact
 *  hang this is meant to explain. */
const _childOutput = new WeakMap<Deno.ChildProcess, () => string>();
const _childDrains = new WeakMap<Deno.ChildProcess, Promise<unknown>>();

/** What the spawned server printed, or a note that nothing was captured. */
export function serverOutput(proc: Deno.ChildProcess): string {
  return _childOutput.get(proc)?.() ?? "(no output captured)";
}

/** Give the drain loops a bounded beat to finish reading a just-died child's
 *  last pipe chunks, so the failure message carries the whole stack trace and
 *  not a race-truncated prefix. */
async function settleOutput(proc: Deno.ChildProcess): Promise<void> {
  const drains = _childDrains.get(proc);
  if (!drains) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    drains,
    new Promise<void>((r) => t = setTimeout(r, 100)),
  ]);
  if (t !== undefined) clearTimeout(t);
}

export function spawnServer(dir: string, port: number): Deno.ChildProcess {
  const proc = new Deno.Command(Deno.execPath(), {
    // DISPLAY comes from the nested test display, not the developer's session:
    // this harness passes --client=server-only so nothing opens today, but
    // `aio.run()`'s DEFAULT client is electron, and one spawned app that
    // forgets the flag is a window in your face mid-keystroke.
    //
    // AIO_APPS_DIR for the same reason, one layer down. A spawned app resolves
    // its home as `~/.<appId>` when nothing pins it, and this harness scaffolds
    // a UNIQUE appId per run — so a suite run outside `deno task test` (which
    // is the documented way to run one file: `deno test -A tests/x.test.ts`)
    // left one `~/.e2e-<hash>` per e2e app in the developer's home. A hundred
    // of them accumulated before anyone looked. The sandbox belongs to the
    // harness that creates the app, not to the invocation that happens to be
    // used; `??` so the runner's own pin still wins.
    env: {
      DENO_COVERAGE_DIR: _childCovDir,
      AIO_APPS_DIR: Deno.env.get("AIO_APPS_DIR") ?? aioTestDir("e2e-apps-"),
      ...testDisplayEnv(),
    },
    args: [
      "run",
      "-A",
      "--unstable-kv",
      "src/app.ts",
      "--client=server-only",
      `--port=${port}`,
    ],
    cwd: dir,
    stdin: "null",
    // PIPED, not "null". Discarding the child's output made every boot failure
    // read `timeout: server up` and nothing else — a crash on a syntax error
    // and a machine merely under load produced the identical message, so the
    // first question a failure raises ("did it die, or is it slow?") could
    // only be answered by re-running the test by hand.
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let buf = "";
  // One decoder PER stream: a streaming TextDecoder is stateful, and a
  // multibyte char split across chunks on stdout, interleaved with a stderr
  // chunk, would decode as garbage through a shared one. The final
  // `decode()` flushes a trailing partial char.
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream) {
        buf = (buf + dec.decode(chunk, { stream: true })).slice(-CHILD_LOG_CAP);
      }
      buf = (buf + dec.decode()).slice(-CHILD_LOG_CAP);
    } catch { /* closed with the process */ }
  };
  // Fire and forget: both must be consumed for the child to keep running.
  const drains = Promise.allSettled([drain(proc.stdout), drain(proc.stderr)]);
  _childDrains.set(proc, drains);
  _childOutput.set(proc, () => buf.trim() || "(server printed nothing)");
  return proc;
}

/** Open a real headless-Chromium tab against the server and resolve when its
 *  app client has registered. */
export async function openTab(server: Server): Promise<Tab> {
  const profile = await tempDir("aio-e2e-prof-");
  const proc = new Deno.Command(BROWSER!, {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--password-store=basic`,
      `--use-mock-keychain`,
      `--user-data-dir=${profile}`,
      `${server.base}/`,
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();

  const before = await currentBrowserIndices(server);
  const index = await waitFor("browser client", async () => {
    const now = await currentBrowserIndices(server);
    const fresh = now.find((i) => !before.includes(i));
    return fresh ?? null;
  });

  const surface = async (): Promise<SurfaceNode[]> => {
    const res = await fetch(`${server.base}/__aio/trojan/surface/${index}`);
    if (!res.ok) {
      await res.body?.cancel();
      return [];
    }
    return await res.json();
  };
  return {
    index,
    proc,
    async close() {
      await stopChild(proc, { quiet: true });
      await dropTempDir(profile);
    },
    surface,
    async text(name: string) {
      return findText(await surface(), name);
    },
    async trigger(path, action, extra) {
      const res = await fetch(
        `${server.base}/__aio/trojan/trigger/${index}`,
        {
          method: "POST",
          headers: { "x-aio": "1", "content-type": "application/json" },
          body: JSON.stringify({ path, action, ...extra }),
        },
      );
      return await res.json();
    },
  };
}

async function currentBrowserIndices(server: Server): Promise<number[]> {
  try {
    const cs = await (await fetch(`${server.base}/__aio/trojan/clients`))
      .json() as { index: number; type: string }[];
    return cs.filter((c) => c.type === "browser").map((c) => c.index);
  } catch {
    return [];
  }
}

/** Boot a server + one tab, run the test body, and tear everything down. */
export async function withE2E(
  spec: E2eApp,
  fn: (
    ctx: { server: Server; tab: Tab; openTab: () => Promise<Tab> },
  ) => Promise<void>,
): Promise<void> {
  const server = await boot(spec);
  const tabs: Tab[] = [];
  const open = async () => {
    const t = await openTab(server);
    tabs.push(t);
    return t;
  };
  try {
    const tab = await open();
    await fn({ server, tab, openTab: open });
  } finally {
    for (const t of tabs) await t.close();
    await server.stop();
    await Deno.remove(server.dir, { recursive: true }).catch(() => {});
  }
}
