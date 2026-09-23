// test:hosts — ONE app, every runtime it ships on, the SAME facts.
//
// Each runtime used to decide "what does this app keep" on its own, and the
// decisions drifted: `initStandalone` wrote the WHOLE state (`getDBState =
// (s) => s`) while `deno task dev` dropped every `persist: "none"` cell, so an
// APK fsync'd a session token the dev server never wrote. Every per-host test
// was green, because each asked its own host its own question. This file asks
// all of them ONE question set, from one fixture app, as a table:
//
//   host          how it runs                                  "stop"
//   ───────────── ──────────────────────────────────────────── ────────────────
//   server        `deno run -A src/app.ts` (aio.run / aio-boot)  SIGTERM to self
//   standalone    the SAME cells under `aio` → standalone-air,   app.close()
//   (native)      the Android durable file store (AioNativeStore)
//   standalone    …and the lazy `localStorage` store (a preview,  app.close()
//   (ls)          a desktop browser) — debounced, so close() must
//                 FLUSH
//   electron      the BUILT AppImage (`--compile --electron`),   SIGTERM to self
//                 run from a foreign cwd on the nested display
//
// Facts asserted on every row:
//   1. a `persist: "none"` cell never reaches disk — the whole data root is
//      byte-scanned, SQLite WAL / Chromium profile included — and is never
//      RESTORED: an "older build" (the same app with the cell persisted)
//      plants it first, and the next boot must come up without it.
//   2. the last write survives the shutdown drain: the app dispatches, then
//      stops itself in the same tick; the next boot must read the value.
// Packaged Electron only (asserted on the running ARTIFACT, never a function):
//   3. `/__aio/snapshot` is off (the page's own same-origin fetch, and the
//      app's HTTP socket from outside), the window's document carries the CSP
//      `<meta>`, and by DEFAULT — no transport flag, no --expose — the whole
//      process tree holds NO TCP listen socket. An explicit
//      `transport: "ws"` is still a legal opt-in (compat); this pins the
//      default only (`resolveTransport`, src/server/paths.ts).
//
// The fixture DRIVES ITSELF (env AIO_HOSTS_STEP), so a host with no TCP port
// is driven exactly like one with a port, and "dispatch then stop" has no
// test-to-process latency in it for a debounce to hide behind.
//
// Gates: server + standalone rows always run. The electron row builds a real
// ~100 MB artifact, so it rides the existing electron build gate
// (AIO_BUILD_E2E=1 AIO_BUILD_ELECTRON=1 — `deno task test:hosts`).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildFlags,
  childEnv,
  freePort,
  kill,
  makeApp,
} from "./e2e-app-harness.ts";
import { descendantPids } from "../src/server/single-instance-lock.ts";
import { udsRequest } from "../src/am/am-uds.ts";
import { keepTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";

const ELECTRON = Deno.env.get("AIO_BUILD_E2E") === "1" &&
  Deno.env.get("AIO_BUILD_ELECTRON") === "1";
const APP_ID = "hostsfx";
const dec = new TextDecoder();

// ── the fixture app ─────────────────────────────────────────────────────────
// Two cells: one that must never be kept, one that must always be. The
// "older build" is the same file with AIO_HOSTS_OLD_BUILD=1, where the secret
// cell is persisted — the only honest way to put its slice on disk.
const FIXTURE: Record<string, string> = {
  // The flag is read by the ENTRY (app.ts / standalone.ts) and handed over
  // on globalThis: a cell module is also bundled for the page, where `Deno`
  // does not exist (and the build's graph audit rightly says so).
  "src/cell.ts": `import { cell } from "aio";

const OLD_BUILD =
  (globalThis as { __hostsOldBuild?: boolean }).__hostsOldBuild === true;

export const hsecret = cell("hsecret", {
  state: { token: "" },
  persist: OLD_BUILD ? "all" : "none",
  methods: {
    set(s, v: string) {
      s.token = v;
    },
  },
});

export const hkept = cell("hkept", {
  state: { last: "" },
  methods: {
    write(s, v: string) {
      s.last = v;
    },
  },
});
`,
  // Host-agnostic: every row runs THIS, with its own stop().
  "src/drive.ts": `import { hkept, hsecret } from "./cell.ts";

type Slices = { hsecret: { token: string }; hkept: { last: string } };

export async function drive(
  app: { getState(): unknown },
  stop: () => void | Promise<void>,
  holdOnRead: boolean,
): Promise<void> {
  const env = (k: string) => Deno.env.get(k) ?? "";
  const step = env("AIO_HOSTS_STEP");
  const s = app.getState() as Slices;
  // The report is written BEFORE the writes, so nothing sits between the last
  // dispatch and stop() — that gap is exactly where a missing drain hides.
  const out = env("AIO_HOSTS_OUT");
  Deno.writeTextFileSync(
    out + ".tmp",
    JSON.stringify({
      step,
      pid: Deno.pid,
      boot: { secret: s.hsecret.token, kept: s.hkept.last },
    }),
  );
  Deno.renameSync(out + ".tmp", out);
  if (step === "plant") {
    // SEVERAL revisions, each saved: the older ones sit in pages SQLite has
    // already freed, which a delete of the current row never touches.
    for (let i = 0; i < 4; i++) {
      await hsecret.set("rev" + i + ":" + env("AIO_HOSTS_SECRET"));
      await new Promise((r) => setTimeout(r, 300));
    }
    await hsecret.set(env("AIO_HOSTS_SECRET"));
    await hkept.write(env("AIO_HOSTS_LAST"));
    // Plant is a PRECONDITION, not the drain check — give every store's own
    // debounce time to fire, so a lost drain fails at step 2, by name.
    await new Promise((r) => setTimeout(r, 500));
  } else if (step === "write") {
    await hsecret.set(env("AIO_HOSTS_SECRET"));
    for (let i = 0; i < 20; i++) await hkept.write("w" + i);
    await hkept.write(env("AIO_HOSTS_LAST"));
  } else if (holdOnRead) {
    return; // stay up: the test inspects the live process, then SIGTERMs it
  }
  await stop();
}
`,
  "src/app.ts": `import { aio } from "aio";

(globalThis as { __hostsOldBuild?: boolean }).__hostsOldBuild =
  Deno.env.get("AIO_HOSTS_OLD_BUILD") === "1";
const { hkept, hsecret } = await import("./cell.ts");
const { drive } = await import("./drive.ts");

// The dev CHECKPOINT is ON (flushed on stop) and read BACK through
// \`onCheckpointRestore\`, so it is a second store: the disk scan covers it
// and the restore checks cover what it hands back. The action LOG is a
// different contract — payloads, governed by \`redactActions\` /
// \`diagnostics: false\` (docs/persistence/auto-persist.md, "persist is about
// the STORE") — so it is off here and the scan stays total, nothing excluded.
const app = await aio.run({
  appId: "${APP_ID}",
  cells: [hsecret, hkept],
  // A LONG debounce: no write of this run rewrites the checkpoint during boot,
  // so "the older build's checkpoint is clean right after boot" is decided by
  // boot itself, never by a race with the first write (flushed on stop).
  diagnostics: { dev: { actionLog: false, checkpoint: { debounce: 60_000 } } },
  onCheckpointRestore: (cp) => cp.state,
  persistMode: (Deno.env.get("AIO_HOSTS_PERSIST_MODE") ?? "single") as
    | "single"
    | "multi",
  // A custom route: in a packaged app it is what builds the HTTP handler on
  // the local socket (aio-server.ts \`resolveZeroPort\`), so the snapshot
  // route's OWN guard is what stands between the page and the state — not the
  // absence of a handler.
  routes: { "/hosts-ping": () => new Response("pong") },
});
await drive(app, () => Deno.kill(Deno.pid, "SIGTERM"), true);
`,
  // The Android shape: the same cells, \`aio\` resolved to standalone-air (the
  // build's own alias, esbuild-shared.ts), and the store the APK injects.
  "src/standalone.ts": `import { aio } from "aio";

(globalThis as { __hostsOldBuild?: boolean }).__hostsOldBuild =
  Deno.env.get("AIO_HOSTS_OLD_BUILD") === "1";
const { hkept, hsecret } = await import("./cell.ts");
const { drive } = await import("./drive.ts");

const dir = Deno.env.get("AIO_HOSTS_STORE_DIR")!;
Deno.mkdirSync(dir, { recursive: true });
const file = (k: string) => dir + "/" + k.replace(/[^A-Za-z0-9._-]/g, "_") + ".json";
const read = (k: string) => {
  try {
    return Deno.readTextFileSync(file(k));
  } catch {
    return null;
  }
};
// MainActivity.kt's AioNativeStore, line for line: tmp → fsync → rename.
const write = (k: string, v: string) => {
  const tmp = file(k) + ".tmp";
  const f = Deno.openSync(tmp, { write: true, create: true, truncate: true });
  f.writeSync(new TextEncoder().encode(v));
  f.syncSync();
  f.close();
  Deno.renameSync(tmp, file(k));
  return true;
};
if (Deno.env.get("AIO_HOSTS_STORE") === "native") {
  Object.defineProperty(globalThis, "AioNativeStore", {
    value: { get: read, set: write, has: (k: string) => read(k) !== null, describe: () => dir },
    configurable: true,
  });
}
// Deno's own localStorage lives in DENO_DIR; this one lives where the scan
// looks. Either way the framework debounces a lazy store, so close() is what
// has to write the last change.
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: read, setItem: (k: string, v: string) => void write(k, v), removeItem() {} },
  configurable: true,
  writable: true,
});

const app = await aio.run({ appId: "${APP_ID}", cells: [hsecret, hkept] });
await drive(app, async () => {
  await app.close();
  Deno.exit(0);
}, false);
await app.close();
Deno.exit(0);
`,
  // The packaged window reports what IT sees: the document's CSP meta, and
  // what a same-origin fetch of the snapshot route answers — the exact door
  // the wallet report measured (server-static.ts, "Snapshot endpoint").
  "src/App.tsx": `import type { JSX } from "aio";
import { hkept } from "./cell.ts";

if (typeof navigator !== "undefined" && /Electron/.test(navigator.userAgent)) {
  setTimeout(async () => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const status = async (url: string) => {
      try {
        return (await fetch(url)).status;
      } catch (e) {
        return "threw: " + String(e);
      }
    };
    const snapshot = await status("/__aio/snapshot");
    const route = await status("/hosts-ping");
    console.warn("aio-hosts-doors " + JSON.stringify({
      csp: meta?.getAttribute("content") ?? null,
      snapshot,
      route,
      origin: location.origin,
    }));
  }, 0);
}

export default function App(): JSX.Element {
  return (
    <main>
      <h1>hosts</h1>
      <p>{hkept.last}</p>
    </main>
  );
}
`,
};

async function makeFixture(): Promise<string> {
  const dir = keepTempDir(await makeApp("counter", "hosts-fx-"));
  for (const [rel, src] of Object.entries(FIXTURE)) {
    await Deno.writeTextFile(join(dir, rel), src);
  }
  const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
  cfg.imports.aio = "./dep/aio/src/standalone-air.ts";
  await Deno.writeTextFile(
    join(dir, "deno.standalone.json"),
    JSON.stringify(cfg, null, 2),
  );
  return dir;
}

// ── instruments ─────────────────────────────────────────────────────────────

/** Every regular file under `root` whose bytes contain `needle`. */
function filesContaining(root: string, needle: string): string[] {
  const want = new TextEncoder().encode(needle);
  const hits: string[] = [];
  const walk = (d: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(d)];
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory) walk(p);
      else if (e.isFile) {
        let b: Uint8Array;
        try {
          b = Deno.readFileSync(p);
        } catch {
          continue;
        }
        if (indexOf(b, want) >= 0) hits.push(p);
      }
    }
  };
  walk(root);
  return hits;
}

function indexOf(hay: Uint8Array, n: Uint8Array): number {
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (hay[i + j] !== n[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Socket inodes a process holds open. */
function socketInodes(pid: number): Set<string> {
  const out = new Set<string>();
  try {
    for (const e of Deno.readDirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(
          Deno.readLinkSync(`/proc/${pid}/fd/${e.name}`),
        );
        if (m) out.add(m[1]!);
      } catch { /* fd closed while walking */ }
    }
  } catch { /* process gone */ }
  return out;
}

/** The process and everything under it. */
async function tree(pid: number): Promise<number[]> {
  return [pid, ...await descendantPids(pid)];
}

/** TCP LISTEN sockets held by any process in `pids` → "addr:port" list. */
function tcpListeners(pids: number[]): string[] {
  const inodes = new Set(pids.flatMap((p) => [...socketInodes(p)]));
  const found: string[] = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = Deno.readTextFileSync(table);
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      // local_address st … inode at [9]; st 0A = LISTEN
      if (f.length > 9 && f[3] === "0A" && inodes.has(f[9]!)) {
        found.push(`${f[1]} (inode ${f[9]})`);
      }
    }
  }
  return found;
}

/** Unix LISTEN socket paths held by any process in `pids`. */
function unixListeners(pids: number[]): string[] {
  const inodes = new Set(pids.flatMap((p) => [...socketInodes(p)]));
  const out: string[] = [];
  for (const line of Deno.readTextFileSync("/proc/net/unix").split("\n")) {
    // Num RefCount Protocol Flags Type St Inode Path — Flags 00010000 = ACCEPTCON
    const f = line.trim().split(/\s+/);
    if (f.length >= 8 && f[3] === "00010000" && inodes.has(f[6]!)) {
      out.push(f[7]!);
    }
  }
  return out;
}

async function until<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  ms: number,
  what: () => string,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what()}`);
}

// ── hosts ───────────────────────────────────────────────────────────────────

type Step = "plant" | "boot" | "write" | "read";
type Report = {
  step: Step;
  pid: number;
  boot: { secret: string; kept: string };
  /** The run's own output (attached by \`runStep\`, not the fixture). */
  log?: string;
};
type Run = {
  proc: Deno.ChildProcess;
  log: () => string;
  /** Both output pumps, drained — awaited on teardown so nothing leaks. */
  done: Promise<unknown>;
};

type Host = {
  name: string;
  ignore: boolean;
  /** Build whatever the host runs, once. */
  prepare(fx: string, root: string): Promise<void>;
  launch(fx: string, root: string, env: Record<string, string>): Run;
  /** Checks against the LIVE process during the read step. */
  whileUp?(run: Run, root: string): Promise<void>;
  /** Checks on disk after the write step (the host's own extra stores). */
  afterWrite?(data: string, last: string): void;
  /** The app stays up after boot (\`holdOnRead\`), so the disk can be read
   *  while it runs — before any write of its own could have hidden a leftover
   *  by reusing its pages, and before a clean stop checkpoints the -wal. */
  holdsOnBoot?: boolean;
};

function start(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Run {
  const proc = new Deno.Command(cmd, {
    args,
    cwd,
    env: childEnv(env),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let log = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) log += dec.decode(c);
  };
  const done = Promise.all([
    pump(proc.stdout).catch(() => {}),
    pump(proc.stderr).catch(() => {}),
  ]);
  return { proc, log: () => log, done };
}

const standalone = (store: "native" | "localStorage"): Host => ({
  name: `standalone (${store})`,
  ignore: false,
  prepare: async () => {},
  launch: (fx, root, env) =>
    start(
      "deno",
      [
        "run",
        "-A",
        "--config",
        "deno.standalone.json",
        "src/standalone.ts",
      ],
      fx,
      {
        ...env,
        AIO_HOSTS_STORE: store,
        AIO_HOSTS_STORE_DIR: join(root, "data", "store"),
      },
    ),
});

let appImage = "";

/** The server host, in each persist layout: \`single\` rewrites one document,
 *  \`multi\` keeps a ROW per cell — and deletes a row only when it knows the
 *  store holds it, so a stale \`persist: "none"\` row is its own risk. */
const server = (mode: "single" | "multi"): Host => ({
  name: mode === "single" ? "server" : "server (persistMode multi)",
  holdsOnBoot: true,
  ignore: false,
  prepare: async () => {},
  // The dev checkpoint is really written (else the scan above it would be
  // vacuous for it): the last value is in it, the secret is not.
  afterWrite: (data, last) => {
    const hits = filesContaining(data, last);
    assert(
      hits.some((p) => p.endsWith("checkpoint.json")),
      `the dev checkpoint never recorded the last write — its scan proves ` +
        `nothing: ${JSON.stringify(hits)}`,
    );
  },
  launch: (fx, _root, env) =>
    start(
      "deno",
      [
        "run",
        "-A",
        "src/app.ts",
        `--port=${freePort()}`,
        "--client=browser",
      ],
      fx,
      { ...env, AIO_HOSTS_PERSIST_MODE: mode },
    ),
  // Instrument control: the same socket reader must SEE a listener where
  // one exists, or its "none" on the electron row proves nothing.
  whileUp: async (run) => {
    const tcp = tcpListeners(await tree(run.proc.pid));
    assert(
      tcp.length > 0,
      `instrument check: the server host serves TCP, yet no LISTEN socket ` +
        `was found for its process tree — the electron row's "none" would ` +
        `be meaningless:\n${run.log()}`,
    );
  },
});

const HOSTS: Host[] = [
  server("single"),
  server("multi"),
  standalone("native"),
  standalone("localStorage"),
  {
    name: "electron (packaged AppImage)",
    holdsOnBoot: true,
    ignore: !ELECTRON,
    prepare: async (fx) => {
      const r = await buildFlags(fx, "--compile", "--electron");
      assertEquals(r.code, 0, `electron build failed:\n${r.out}\n${r.err}`);
      const name = [...Deno.readDirSync(join(fx, "dist"))]
        .map((e) => e.name)
        .find((n) => n.toLowerCase().endsWith(".appimage"));
      assert(name, "the electron build placed no AppImage in dist/");
      appImage = join(fx, "dist", name);
      await Deno.chmod(appImage, 0o755);
    },
    launch: (_fx, root, env) =>
      // From a FOREIGN cwd, with HOME/XDG pointed inside the scanned root so
      // the Chromium profile is scanned too; window on the nested display.
      start(appImage, [], join(root, "cwd"), {
        ...testDisplayEnv(),
        ...env,
        HOME: join(root, "data", "home"),
        XDG_CONFIG_HOME: join(root, "data", "home", ".config"),
        XDG_CACHE_HOME: join(root, "data", "home", ".cache"),
        XDG_DATA_HOME: join(root, "data", "home", ".local", "share"),
        TMPDIR: join(root, "tmp"),
        APPIMAGE_EXTRACT_AND_RUN: "1",
        WAYLAND_DISPLAY: "", // X11 only: the nested display, never the session
      }),
    whileUp: async (run) => {
      // Wait for the window's own report first: it means the whole tree —
      // runtime, Electron, renderer — is up, so the socket census is complete.
      const doors = await until(
        () => /aio-hosts-doors (\{.*?\})(?: \(|$)/m.exec(run.log())?.[1],
        90_000,
        () => `the packaged window's door report:\n${run.log().slice(-6000)}`,
      ).then((j) =>
        JSON.parse(j) as {
          csp: string | null;
          snapshot: unknown;
          route: unknown;
        }
      );
      const pids = await tree(run.proc.pid);
      // 1. The default door: NO TCP listen socket anywhere in the tree.
      assertEquals(
        tcpListeners(pids),
        [],
        `the packaged app (no transport flag, no --expose) holds a TCP ` +
          `listen socket — its default must be the local socket only`,
      );
      // 2. From outside, over the app's own local socket: the \`ctl\` frame
      //    is the control plane \`am\` uses, HTTP-shaped and routed through
      //    the server's own handler (uds.ts) — the same door, other side. A
      //    \`ctlr\` reply (any status) proves the instrument reached the app;
      //    it must not be the state.
      // The NDJSON state socket (`<key>.sock`), not the page's `.http.sock`.
      const sock = unixListeners(pids).find((p) =>
        p.endsWith(".sock") && !p.endsWith(".http.sock")
      );
      assert(
        sock,
        `no local socket among the tree's unix listeners: ` +
          JSON.stringify(unixListeners(pids)),
      );
      const snap = await udsRequest(
        sock,
        "/__aio/snapshot",
        { method: "GET" },
        10_000,
      );
      if (!("status" in snap)) {
        throw new Error(`no ctl reply over ${sock}: ${snap.error}`);
      }
      assert(
        snap.status !== 200 && !snap.body.includes("hkept"),
        `the packaged app's local socket serves /__aio/snapshot ` +
          `(${snap.status}): ${snap.body.slice(0, 300)}`,
      );
      // 3. The window's own view: a same-origin fetch of the route, and the
      //    CSP <meta> — the default policy ("basic") as a document can carry
      //    it, header-only directives stripped (packaged-shell-hardening).
      // The route plane is live (the app's own route answers), so the 404
      // below is the snapshot guard's doing and not a missing handler.
      assertEquals(
        doors.route,
        200,
        `the packaged page could not reach its own custom route: ` +
          JSON.stringify(doors),
      );
      assert(
        doors.snapshot !== 200,
        `/__aio/snapshot answered 200 to the packaged page — the full raw ` +
          `state is readable by any script in the window: ` +
          JSON.stringify(doors),
      );
      assert(
        doors.csp && /object-src/.test(doors.csp) &&
          /base-uri/.test(doors.csp),
        `the packaged window's document has no CSP <meta>: ` +
          JSON.stringify(doors),
      );
    },
  },
];

// ── the one scenario, every host ────────────────────────────────────────────

async function runStep(
  host: Host,
  fx: string,
  root: string,
  step: Step,
  marks: { secret: string; last: string },
  extra: Record<string, string> = {},
  live?: () => void | Promise<void>,
): Promise<Report> {
  const out = join(root, `report-${step}.json`);
  const run = host.launch(fx, root, {
    AIO_APPS_DIR: join(root, "data", "apps"),
    AIO_HOSTS_STEP: step,
    AIO_HOSTS_OUT: out,
    AIO_HOSTS_SECRET: marks.secret,
    AIO_HOSTS_LAST: marks.last,
    ...extra,
  });
  try {
    const report = await until(
      () => {
        try {
          return JSON.parse(Deno.readTextFileSync(out)) as Report;
        } catch {
          return undefined;
        }
      },
      120_000,
      () => `${host.name} ${step} report\n${run.log().slice(-6000)}`,
    );
    if (step === "boot") {
      await live?.();
      Deno.kill(report.pid, "SIGTERM");
    }
    if (step === "read" && host.whileUp) {
      await host.whileUp(run, root);
      // The APP process (the pid it reported), not whatever wraps it: an
      // AppImage runtime dies of a SIGTERM (143) without passing it on.
      Deno.kill(report.pid, "SIGTERM");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([
      run.proc.status,
      new Promise<null>((r) => timer = setTimeout(() => r(null), 60_000)),
    ]).finally(() => clearTimeout(timer));
    assert(
      status,
      `${host.name}: ${step} never exited after stopping\n${run.log()}`,
    );
    assertEquals(
      status.code,
      0,
      `${host.name}: ${step} exited ${status.code}\n${run.log().slice(-6000)}`,
    );
    await run.done;
    return { ...report, log: run.log() };
  } finally {
    await kill(run.proc);
    await run.done;
  }
}

for (const host of HOSTS) {
  Deno.test({
    name: `hosts: ${host.name} — persist:"none" never kept, last write drained`,
    ignore: host.ignore,
    fn: async () => {
      const fx = await makeFixture();
      const root = await tempDir("hosts-run-");
      for (const d of ["data/apps", "data/home", "tmp", "cwd"]) {
        await Deno.mkdir(join(root, d), { recursive: true });
      }
      const id = crypto.randomUUID().slice(0, 8);
      const OLD = `OLD-BLOB-${id}`;
      const NEW = `NEW-SECRET-${id}`;
      const LAST = `LAST-WRITE-${id}`;
      const data = join(root, "data");
      await host.prepare(fx, root);

      // 0. an OLDER build — the same app with the secret cell persisted —
      //    leaves its slice on disk. Asserted, or everything after is vacuous.
      //    ~48 KB, the marker in every KB: the slice spans a dozen SQLite
      //    overflow pages, so the few pages this build's own writes reuse
      //    cannot hide a delete that only unlinked the rest.
      const planted = `${OLD}:${"s".repeat(1000)}|`.repeat(48);
      // The kept cell's plant value is unique too, so "plant ran to its END"
      // is checked on disk: an app that stops itself early exits 0 all the
      // same (a packaged window refused by the display — Electron dies, the
      // app shuts down cleanly mid-plant), and without this the loss only
      // surfaces two steps later as "a persisted cell did not come back".
      const KEPT0 = `KEPT0-${id}`;
      const p = await runStep(
        host,
        fx,
        root,
        "plant",
        { secret: planted, last: KEPT0 },
        { AIO_HOSTS_OLD_BUILD: "1" },
      );
      assert(
        filesContaining(data, KEPT0).length > 0,
        `${host.name}: the older build stopped before its last write — the ` +
          `plant never finished, so nothing after it is a real check:\n` +
          (p.log ?? "").slice(-6000),
      );
      assert(
        filesContaining(data, OLD).length > 0,
        `${host.name}: the older build's persisted slice is not on disk ` +
          `(or a clean stop wiped it) — the restore check below would ` +
          `prove nothing`,
      );

      // 0b. a plain BOOT of this build already took the older build's slice
      //     off the disk — as bytes, the SQLite file and its -wal included,
      //     read while the app is still running (aio-boot.ts
      //     \`scrubStaleSlices\`: secure_delete for that delete, then a
      //     VACUUM for the older revisions in free pages, then a WAL
      //     checkpoint). No write of its own has happened yet to hide a
      //     leftover by reusing its pages.
      if (host.holdsOnBoot) {
        await runStep(
          host,
          fx,
          root,
          "boot",
          { secret: "", last: "" },
          {},
          () =>
            assertEquals(
              filesContaining(data, OLD),
              [],
              `${host.name}: right after boot, the older build's persist:"none" ` +
                `slice is still on disk`,
            ),
        );
      }

      // 1. this build: the planted slice is NOT restored, the kept one is.
      const w = await runStep(host, fx, root, "write", {
        secret: NEW,
        last: LAST,
      });
      assertEquals(
        w.boot.kept,
        KEPT0,
        `${host.name}: a persisted cell did not come back at all`,
      );
      assertEquals(
        w.boot.secret,
        "",
        `${host.name}: a persist:"none" cell was RESTORED from an older blob`,
      );
      //    …and what it held this run never reached disk.
      assertEquals(
        filesContaining(data, NEW),
        [],
        `${host.name}: a persist:"none" cell's value is on disk`,
      );
      //    …and what the older build left is gone once this one has
      //    booted — as BYTES, SQLite file and -wal included: a delete that
      //    only unlinks leaves the secret in a free page (aio-boot.ts
      //    \`scrubStaleSlices\`).
      assertEquals(
        filesContaining(data, OLD),
        [],
        `${host.name}: the older build's persist:"none" slice is still on ` +
          `disk after this build wrote its state`,
      );

      host.afterWrite?.(data, LAST);

      // 2. the write made right before stop() survived the shutdown drain.
      const r = await runStep(host, fx, root, "read", {
        secret: "",
        last: "",
      });
      assertEquals(
        r.boot.kept,
        LAST,
        `${host.name}: the last write before shutdown was lost`,
      );
      assertEquals(r.boot.secret, "", `${host.name}: secret came back`);
    },
  });
}
