// Transport-faithful e2e harness — the tool the in-process harness (testUI/
// testCell) can't be: it boots a REAL aio server and drives it in REAL headless
// Chromium over the REAL WebSocket wire, so subscription filtering, delta
// broadcast, offline queue, reconnect/replay, and browser Promise<void>
// semantics are all exercised. Keeps each e2e test compact.
//
// Skips cleanly when no Chromium is present (BROWSER === null → set `ignore`).

// Route the spawned server's coverage into the parent's coverage dir when the
// suite runs under `--coverage` (DENO_COVERAGE_DIR is set by `deno test
// --coverage`). This is what makes e2e tests actually COUNT toward src/
// coverage — they exercise the real server (server-ws, broadcast, protocol,
// subscription filtering) that the in-process harness never touches. Outside a
// coverage run the var is unset, so we use a throwaway.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-e2e-cov-" });
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
  await waitFor("server up", async () => {
    const r = await fetch(`${base}/`);
    await r.body?.cancel();
    return r.ok ? true : null;
  }, 120_000);
  return {
    base,
    port,
    proc,
    dir,
    async stop() {
      try {
        proc.kill();
      } catch { /* exited */ }
      await proc.status;
    },
    async state() {
      return await (await fetch(`${base}/__aio/trojan/state`)).json();
    },
  };
}

export function spawnServer(dir: string, port: number): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir },
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
    stdout: "null",
    stderr: "null",
  }).spawn();
}

/** Open a real headless-Chromium tab against the server and resolve when its
 *  app client has registered. */
export async function openTab(server: Server): Promise<Tab> {
  const profile = await Deno.makeTempDir({ prefix: "aio-e2e-prof-" });
  const proc = new Deno.Command(BROWSER!, {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
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
      try {
        proc.kill();
      } catch { /* exited */ }
      await proc.status;
      await Deno.remove(profile, { recursive: true }).catch(() => {});
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
