// The Electron main process is a GENERATED CJS program (electron-uds.ts). Every
// prior test of it asserted on the SOURCE STRING, which proves nothing about
// what it does with a real socket. This harness RUNS the generated main.cjs
// (Deno's CJS/node-compat, with a stub `electron` module) against a scripted
// UDS server, and observes exactly what reaches the renderer over IPC.
//
// What that buys: the relay's frame handling — pre-ready frames, reload
// windows, split chunks, a partial frame left by a dead connection — becomes
// observable instead of assumed.

import { assert, assertEquals } from "@std/assert";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { join } from "@std/path";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// ── The stub `electron` module ────────────────────────────────────────────
// Records what main.cjs does to the window/IPC, and lets the test drive the
// events Electron would fire (did-finish-load, did-start-navigation, and the
// renderer's own `__aio:ready`).
const ELECTRON_STUB = `
const net = require('net');
const ctrl = net.connect(process.env.AIO_CTRL);
ctrl.setEncoding('utf8');
let cbuf = '';
const wcH = {}, ipcH = {}, appH = {};
let protoHandler = null;
function ev(o) { try { ctrl.write(JSON.stringify(o) + '\\n'); } catch {} }
ctrl.on('data', (d) => {
  cbuf += d;
  const lines = cbuf.split('\\n');
  cbuf = lines.pop();
  for (const l of lines) {
    if (!l) continue;
    const m = JSON.parse(l);
    try {
      if (m.cmd === 'wc' && m.event === 'will-navigate') {
        // Chromium hands will-navigate a cancellable event; report the verdict.
        let prevented = false;
        const evt = { preventDefault: () => { prevented = true; } };
        for (const f of (wcH['will-navigate'] || [])) f(evt, m.url);
        ev({ ev: 'navigate', id: m.id, url: m.url, prevented });
      }
      else if (m.cmd === 'wc') for (const f of (wcH[m.event] || [])) f(...(m.args || []));
      else if (m.cmd === 'ipc') for (const f of (ipcH[m.channel] || [])) f({}, m.arg);
      else if (m.cmd === 'app') for (const f of (appH[m.event] || [])) f();
      else if (m.cmd === 'proto') {
        // Drive the captured protocol.handle('aio') callback like Chromium
        // would, and report what came back: status, headers, whether the body
        // was a STREAM (resolved on headers) and its bytes.
        (async () => {
          try {
            const req = new Request(m.url, { method: m.method || 'GET', body: m.body || undefined });
            const t0 = Date.now();
            const res = await protoHandler(req);
            const resolvedAt = Date.now();
            const isStream = res.body instanceof ReadableStream;
            const bytes = new Uint8Array(await res.arrayBuffer());
            const endedAt = Date.now();
            let b64 = '';
            for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            ev({ ev: 'proto', id: m.id, status: res.status, headers: Object.fromEntries(res.headers), isStream, t0, resolvedAt, endedAt, body: btoa(b64) });
            ev({ ev: 'done', id: m.id });
          } catch (e) { ev({ ev: 'done', id: m.id, error: String(e && e.stack || e) }); }
        })();
        continue;
      }
      ev({ ev: 'done', id: m.id });
    } catch (e) { ev({ ev: 'done', id: m.id, error: String(e) }); }
  }
});
const webContents = {
  on: (e, fn) => { (wcH[e] = wcH[e] || []).push(fn); },
  send: (channel, arg) => ev({ ev: 'send', channel, arg }),
  setWindowOpenHandler: () => {},
  session: { clearCache: () => Promise.resolve(), clearStorageData: () => Promise.resolve() },
  print: () => {}, reloadIgnoringCache: () => {}, toggleDevTools: () => {},
};
class BrowserWindow {
  constructor(o) { this.opts = o; this.webContents = webContents; }
  on() {} center() {} setIcon() {} setMenuBarVisibility() {}
  loadURL(u) { ev({ ev: 'loadURL', url: u }); }
  isDestroyed() { return false; }
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
}
module.exports = {
  app: {
    on: (e, fn) => { (appH[e] = appH[e] || []).push(fn); if (e === 'ready') setTimeout(fn, 0); },
    getPath: () => process.env.AIO_STUB_DIR,
    commandLine: { appendSwitch: () => {} },
    quit: () => {},
    name: 'stub',
  },
  BrowserWindow,
  Menu: { setApplicationMenu: () => {} },
  ipcMain: { on: (c, fn) => { (ipcH[c] = ipcH[c] || []).push(fn); } },
  protocol: {
    registerSchemesAsPrivileged: (l) => ev({ ev: 'privileges', privileges: l[0].privileges }),
    handle: (_scheme, fn) => { protoHandler = fn; },
  },
  shell: { openExternal: (u) => ev({ ev: 'openExternal', url: u }) },
  nativeImage: { createFromDataURL: () => ({}) },
};
`;

type Ev = {
  ev: string;
  channel?: string;
  arg?: string;
  id?: number;
  error?: string;
  status?: number;
  headers?: Record<string, string>;
  isStream?: boolean;
  url?: string;
  prevented?: boolean;
  t0?: number;
  resolvedAt?: number;
  endedAt?: number;
  body?: string;
  privileges?: Record<string, boolean>;
};

const encoder = new TextEncoder();

/** A scripted UDS server: writes exactly the bytes the test dictates and
 *  records exactly the lines the client wrote back. */
function rawServer(path: string) {
  const listener = Deno.listen({ transport: "unix", path });
  const conns: Deno.Conn[] = [];
  const inbound: string[] = [];
  let live: Deno.Conn | null = null;
  let connCount = 0;
  (async () => {
    for await (const conn of listener) {
      conns.push(conn);
      live = conn;
      connCount++;
      (async () => {
        let buf = "";
        const dec = new TextDecoder();
        const reader = conn.readable.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n");
            buf = parts.pop()!;
            for (const p of parts) if (p) inbound.push(p);
          }
        } catch { /* closed */ }
      })();
    }
  })().catch(() => {});
  return {
    inbound,
    conns: () => connCount,
    async write(raw: string) {
      await live!.write(encoder.encode(raw));
    },
    async writeLine(line: string) {
      await this.write(line + "\n");
    },
    dropConn() {
      try {
        live?.close();
      } catch { /* already closed */ }
      live = null;
    },
    close() {
      for (const c of conns) {
        try {
          c.close();
        } catch { /* already closed */ }
      }
      try {
        listener.close();
      } catch { /* already closed */ }
    },
  };
}

/** Boots the REAL generated main.cjs under a stub Electron. */
async function startMain(
  sockPath: string,
  opts: { title?: string; httpSocketPath?: string; baseDir?: string } = {},
) {
  const dir = await Deno.makeTempDir({ prefix: "aio-emain-" });
  await Deno.mkdir(join(dir, "node_modules", "electron"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "node_modules", "electron", "package.json"),
    JSON.stringify({ name: "electron", version: "0.0.0", main: "index.js" }),
  );
  await Deno.writeTextFile(
    join(dir, "node_modules", "electron", "index.js"),
    ELECTRON_STUB,
  );
  // `nodeModulesDir: manual` keeps Deno from resolving the REAL npm:electron
  // (a ~100MB download) instead of the stub.
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ nodeModulesDir: "manual" }),
  );
  await Deno.writeTextFile(
    join(dir, "main.cjs"),
    electronMainScriptUDS("http://127.0.0.1:1/", sockPath, {
      title: opts.title ?? "harness",
      httpSocketPath: opts.httpSocketPath,
      baseDir: opts.baseDir,
    }),
  );

  const ctrlPath = join(dir, "ctrl.sock");
  const ctrl = Deno.listen({ transport: "unix", path: ctrlPath });
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--quiet", join(dir, "main.cjs")],
    cwd: dir,
    env: { AIO_CTRL: ctrlPath, AIO_STUB_DIR: dir },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const stdout: string[] = [];
  const stderr: string[] = [];
  const drain = (s: ReadableStream<Uint8Array>, into: string[]) =>
    (async () => {
      const dec = new TextDecoder();
      for await (const c of s) into.push(dec.decode(c, { stream: true }));
    })().catch(() => {});
  drain(proc.stdout, stdout);
  drain(proc.stderr, stderr);

  const conn = await ctrl.accept();
  const events: Ev[] = [];
  const writer = conn.writable.getWriter();
  (async () => {
    let buf = "";
    const dec = new TextDecoder();
    const reader = conn.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const p of parts) if (p) events.push(JSON.parse(p) as Ev);
      }
    } catch { /* closed */ }
  })();

  let seq = 0;
  async function cmd(o: Record<string, unknown>): Promise<number> {
    const id = ++seq;
    await writer.write(encoder.encode(JSON.stringify({ ...o, id }) + "\n"));
    await waitFor(() => events.some((e) => e.ev === "done" && e.id === id));
    const done = events.find((e) => e.ev === "done" && e.id === id)!;
    if (done.error) throw new Error(`main.cjs command failed: ${done.error}`);
    return id;
  }
  async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) {
        throw new Error(
          `waitFor timed out\nevents: ${JSON.stringify(events)}\n` +
            `stdout: ${stdout.join("")}\nstderr: ${stderr.join("")}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** Frames relayed to the renderer, in order. */
  const msgs = () =>
    events.filter((e) => e.ev === "send" && e.channel === "__aio:msg")
      .map((e) => e.arg as string);
  const channels = () =>
    events.filter((e) => e.ev === "send").map((e) => e.channel as string);

  return {
    events,
    msgs,
    channels,
    stdout,
    stderr,
    cmd,
    waitFor,
    /** The renderer's own "my listeners are registered" signal. */
    rendererReady: () => cmd({ cmd: "ipc", channel: "__aio:ready" }),
    finishLoad: () => cmd({ cmd: "wc", event: "did-finish-load" }),
    /** What the shell decides about a navigation the page requested. */
    async navigate(url: string) {
      const id = await cmd({ cmd: "wc", event: "will-navigate", url });
      const r = events.find((e) => e.ev === "navigate" && e.id === id)!;
      return r.prevented as boolean;
    },
    /** Chromium reports the main-frame navigation as failed (code -3 = aborted). */
    failLoad: (code = -3, url = "aio://app/") =>
      cmd({
        cmd: "wc",
        event: "did-fail-load",
        args: [{}, code, code === -3 ? "ERR_ABORTED" : "ERR_FAILED", url, true],
      }),
    startNavigation: () =>
      cmd({
        cmd: "wc",
        event: "did-start-navigation",
        args: [{}, "", false, true],
      }),
    send: (json: string) =>
      cmd({ cmd: "ipc", channel: "__aio:send", arg: json }),
    /** One request through the captured protocol.handle('aio') callback. */
    async proto(url: string, method = "GET", body?: string) {
      const id = await cmd({ cmd: "proto", url, method, body });
      const r = events.find((e) => e.ev === "proto" && e.id === id)!;
      return {
        status: r.status!,
        headers: r.headers!,
        isStream: r.isStream!,
        t0: r.t0!,
        resolvedAt: r.resolvedAt!,
        endedAt: r.endedAt!,
        bytes: Uint8Array.from(atob(r.body!), (c) => c.charCodeAt(0)),
      };
    },
    async close() {
      try {
        await writer.close();
      } catch { /* gone */ }
      try {
        conn.close();
      } catch { /* gone */ }
      try {
        ctrl.close();
      } catch { /* gone */ }
      try {
        proc.kill("SIGKILL");
      } catch { /* gone */ }
      await proc.status;
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

function kindOf(line: string): string | null {
  try {
    const f = JSON.parse(line) as { v?: number; t?: string };
    return f && f.v === 2 && typeof f.t === "string" ? f.t : null;
  } catch {
    return null;
  }
}

async function withHarness(
  fn: (
    srv: ReturnType<typeof rawServer>,
    main: Awaited<ReturnType<typeof startMain>>,
    dir: string,
  ) => Promise<void>,
  opts: { httpSocket?: boolean; baseDir?: (dir: string) => Promise<string> } =
    {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "aio-esock-" });
  const sockPath = join(dir, "s.sock");
  const srv = rawServer(sockPath);
  const main = await startMain(sockPath, {
    httpSocketPath: opts.httpSocket ? join(dir, "http.sock") : undefined,
    baseDir: opts.baseDir ? await opts.baseDir(dir) : undefined,
  });
  try {
    await main.waitFor(() => srv.conns() > 0);
    await fn(srv, main, dir);
  } finally {
    await main.close();
    srv.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// ── 1. Nothing may be dropped before the renderer announces itself ─────────
//
// Renderer readiness was decided TWICE: `did-finish-load` (pageReady) gated
// every relayed frame, while the renderer's own `__aio:ready` gated the replay
// — and the replay only ever carried the last full-state frame. Every OTHER
// frame that landed in the gap was dropped forever: `cfg` (the ONE mechanism
// that delivers compose-time config to a build-time-templated shell — it is
// sent exactly once, at accept), `proto` (the version gate), `tt-state` (the
// frame the Ctrl+. panel binds on). On a real launch the socket connects long
// before the page finishes loading, so this was the normal path, not a corner.
Deno.test("electron main: no frame is lost before the renderer is ready", async () => {
  await withHarness(async (srv, main) => {
    // Exactly what the server writes on accept (src/server/uds.ts).
    await srv.writeLine('{"v":2,"t":"proto","d":{"v":2,"min":2}}');
    await srv.writeLine('{"v":2,"t":"cfg","d":{"callTimeouts":{"a":1}}}');
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await srv.writeLine('{"v":2,"t":"tt-state","d":{"entries":[]}}');
    await new Promise((r) => setTimeout(r, 150));

    // The renderer registers its listeners and says so — this happens while the
    // document is still loading, i.e. BEFORE did-finish-load.
    await main.rendererReady();
    await main.finishLoad();
    await new Promise((r) => setTimeout(r, 150));

    const kinds = main.msgs().map(kindOf);
    assertEquals(
      kinds,
      ["proto", "cfg", "state", "tt-state"],
      "every accept-time frame must reach the renderer, in order",
    );
  });
});

// ── 1b. The FIRST navigation is loadURL's own ─────────────────────────────
//
// `connectUDS()` runs before `win.loadURL()`, and both take effect
// asynchronously — so the socket's accept-time frames routinely queue up
// BEFORE the initial main-frame navigation event arrives. Connection-scoped
// frames (proto/cfg) belong to the socket, not to the document that happened
// to be loading, and must survive it.
Deno.test("electron main: the initial navigation keeps already-queued connection frames", async () => {
  await withHarness(async (srv, main) => {
    await srv.writeLine('{"v":2,"t":"proto","d":{"v":2,"min":2}}');
    await srv.writeLine('{"v":2,"t":"cfg","d":{"callTimeouts":{"a":1}}}');
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await new Promise((r) => setTimeout(r, 150));

    // win.loadURL(...) → did-start-navigation for the main frame.
    await main.startNavigation();
    await main.rendererReady();
    await new Promise((r) => setTimeout(r, 150));

    const kinds = main.msgs().map(kindOf);
    assert(
      kinds.includes("proto") && kinds.includes("cfg") &&
        kinds.includes("state"),
      `the initial navigation must not discard socket-scoped frames — got ${
        JSON.stringify(kinds)
      }`,
    );
  });
});

// ── 2. The reload window ──────────────────────────────────────────────────
//
// Same root cause, worse consequence: a `patches` frame that arrives while the
// new document is loading was dropped AND not cached (only full state was), so
// the renderer's base state silently fell behind the server's — and the server
// had already recorded the delta as delivered.
Deno.test("electron main: frames during a reload are not silently dropped", async () => {
  await withHarness(async (srv, main) => {
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await main.rendererReady();
    await main.finishLoad();
    await main.waitFor(() => main.msgs().length >= 1);

    // Ctrl+R: a new main-frame document starts loading.
    await main.startNavigation();
    await srv.writeLine(
      '{"v":2,"t":"patches","d":[{"op":"add","path":["/xs/0"],"value":"a"}]}',
    );
    await srv.writeLine('{"v":2,"t":"cfg","d":{"callTimeouts":{"b":2}}}');
    await new Promise((r) => setTimeout(r, 100));

    const before = main.msgs().length;
    await main.rendererReady();
    await main.finishLoad();
    await new Promise((r) => setTimeout(r, 150));

    const after = main.msgs().slice(before).map(kindOf);
    assert(
      after.includes("cfg"),
      `a connection-scoped frame sent during the reload window must survive it — got ${
        JSON.stringify(after)
      }`,
    );
    // The reloaded document has no base state, so a stale patch must never be
    // handed to it — a full snapshot is what it needs.
    assert(
      !after.includes("patches") ||
        after.indexOf("state") < after.indexOf("patches"),
      `a patch may not precede a snapshot for a fresh document — got ${
        JSON.stringify(after)
      }`,
    );
    assert(after.includes("state"), "the fresh document must get a snapshot");
  });
});

// ── The dev reload on the zero-port page ────────────────────────────────────
//
// Measured with CDP on a real window: an edit sent `reload`, the renderer
// called location.reload(), Chromium answered net::ERR_ABORTED before the
// request ever reached protocol.handle, and the old page stayed on screen with
// `am surface` timing out forever. Two causes, both pinned here: the
// will-navigate guard compared URL.origin — "null" for a custom scheme — so
// the app's own root looked foreign; and a navigation that never committed
// left rendererReady false on a document that had already signalled it.
Deno.test("electron aio://: a reload of the app's own root is NOT vetoed; foreign URLs are", async () => {
  await withHarness(async (_srv, main) => {
    assert(
      main.events.some((e) => e.ev === "loadURL" && e.url === "aio://app/"),
      "zero-port shell: the page is aio://app/",
    );
    await main.rendererReady();
    assertEquals(
      await main.navigate("aio://app/"),
      false,
      "root reload passes",
    );
    assertEquals(
      await main.navigate("aio://app/settings"),
      true,
      "in-app route → relayed, not navigated",
    );
    assertEquals(
      await main.navigate("aio://evil/"),
      true,
      "another host on the scheme is not this app",
    );
    assertEquals(
      await main.navigate("https://example.com/"),
      true,
      "external → system browser",
    );
    assert(
      main.events.some((e) =>
        e.ev === "openExternal" && e.url === "https://example.com/"
      ),
      "external http(s) goes to the system browser",
    );
    assert(
      main.channels().includes("__aio:navigate"),
      "an in-app path is relayed to the page as a route",
    );
  }, { httpSocket: true });
});

Deno.test("electron main: an aborted navigation gives the old document its relay back", async () => {
  await withHarness(async (srv, main) => {
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await main.rendererReady();
    await main.finishLoad();
    await main.waitFor(() => main.msgs().length >= 1);

    await main.startNavigation(); // location.reload() began …
    await main.failLoad(-3); // … and Chromium aborted it: same document, no new __aio:ready
    const before = main.msgs().length;
    await srv.writeLine('{"v":2,"t":"ui-surface","d":{"id":"q1"}}');
    await main.waitFor(() => main.msgs().length > before, 1500).catch(() => {});
    const after = main.msgs().slice(before).map(kindOf);
    assert(
      after.includes("ui-surface"),
      `a frame after an aborted navigation must still reach the living document — got ${
        JSON.stringify(after)
      }`,
    );
    assert(
      main.stderr.join("").includes("failed (-3 ERR_ABORTED)") ||
        main.stdout.join("").includes("failed (-3 ERR_ABORTED)"),
      "the aborted navigation is said out loud",
    );
  });
});

// ── 3. A partial frame from a dead connection must not corrupt the next one ─
//
// `buf` lives OUTSIDE connectUDS, so the half-line left behind when a server
// dies mid-write was glued onto the first frame of the NEXT connection. That
// first frame is the `proto` hello: the version gate was silently destroyed by
// every crash-mid-frame reconnect.
Deno.test("electron main: a partial frame does not corrupt the next connection", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-esock-" });
  const sockPath = join(dir, "s.sock");
  let srv = rawServer(sockPath);
  const main = await startMain(sockPath);
  try {
    await main.waitFor(() => srv.conns() > 0);
    await main.rendererReady();
    await main.finishLoad();
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await main.waitFor(() => main.msgs().length >= 1);

    // Server dies mid-frame: half a line on the wire, then the socket dies.
    await srv.write('{"v":2,"t":"state","d":{"n":2');
    srv.dropConn();
    srv.close();
    await Deno.remove(sockPath).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    // It comes back and speaks from the top.
    srv = rawServer(sockPath);
    await main.waitFor(() => srv.conns() > 0, 15000);
    await srv.writeLine('{"v":2,"t":"proto","d":{"v":2,"min":2}}');
    await srv.writeLine('{"v":2,"t":"state","d":{"n":3}}');
    await new Promise((r) => setTimeout(r, 200));

    const kinds = main.msgs().map(kindOf);
    assertEquals(
      kinds.filter((k) => k === "proto").length,
      1,
      `the reconnect's proto hello must survive the dead connection's half-line — got ${
        JSON.stringify(main.msgs())
      }`,
    );
    assert(
      main.msgs().every((m) => kindOf(m) !== null),
      `no corrupt line may be relayed — got ${JSON.stringify(main.msgs())}`,
    );
  } finally {
    await main.close();
    srv.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── 4. Split chunks (negative control) ────────────────────────────────────
Deno.test("electron main: frames split across chunk boundaries reassemble", async () => {
  await withHarness(async (srv, main) => {
    await main.rendererReady();
    await main.finishLoad();
    const big = "x".repeat(200_000);
    const line = JSON.stringify({ v: 2, t: "state", d: { big } });
    await srv.write(line.slice(0, 7));
    await new Promise((r) => setTimeout(r, 20));
    await srv.write(line.slice(7, 120_000));
    await new Promise((r) => setTimeout(r, 20));
    await srv.write(line.slice(120_000) + "\n");
    await main.waitFor(() => main.msgs().length >= 1);
    assertEquals(main.msgs()[0], line);
  });
});

// ── 5. A renderer that comes up against a dead backend must be told ───────
//
// `__aio:ready` with no socket answered with silence, so the client's IPC
// watchdog was the only thing that ever noticed — ten seconds of a window that
// looks connected and is not.
Deno.test("electron main: renderer-ready with no backend reports the outage", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-esock-" });
  const sockPath = join(dir, "s.sock"); // nothing listening
  const main = await startMain(sockPath);
  try {
    await new Promise((r) => setTimeout(r, 300));
    await main.rendererReady();
    await main.finishLoad();
    await main.waitFor(
      () => main.channels().includes("__aio:close"),
      3000,
    );
  } finally {
    await main.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── 6. Randomized state-machine fuzz over the relay ───────────────────────
//
// Drives the real main process with random interleavings of the events that
// each own a piece of its state — server writes (whole and chunk-split),
// renderer readiness, main-frame and sub-frame navigations, connection drops
// (clean and mid-frame), and renderer→server sends — and checks invariants
// that need no model of the queue:
//
//   I1  every line handed to the renderer decodes, and carries a seq WE wrote
//       (nothing corrupt, nothing invented);
//   I2  seqs never go backwards, and the only frame that may repeat is a
//       snapshot (a fresh document is deliberately re-seeded with one);
//   I3  no connection-scoped frame written on a connection that survived is
//       lost — those cannot be reconstructed by any later frame;
//   I4  after quiescence the renderer's newest snapshot IS the server's newest;
//   I5  every renderer→server action reaches the server.
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test("electron main: relay fuzz — nothing lost, reordered or corrupted", async () => {
  const rounds = fuzzEnvInt("AIO_FUZZ_ERELAY_ROUNDS", 2);
  const steps = fuzzEnvInt("AIO_FUZZ_ERELAY_STEPS", 45);
  const seedEnv = fuzzEnvInt("AIO_FUZZ_ERELAY_SEED", 0);

  for (let round = 0; round < rounds; round++) {
    const seed = seedEnv || 0xC0FFEE + round * 7919;
    const rnd = mulberry32(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

    const dir = await Deno.makeTempDir({ prefix: "aio-efuzz-" });
    const sockPath = join(dir, "s.sock");
    let srv = rawServer(sockPath);
    const main = await startMain(sockPath);
    const trail: string[] = [];

    // Frames fully written on a connection that later stayed alive long enough
    // to hand them over. `epochRepeat` marks where a re-seeded snapshot may
    // legitimately repeat a seq.
    type W = { seq: number; kind: string; lossAllowed: boolean };
    const written: W[] = [];
    const sent: string[] = [];
    // Inbound is per-server-instance; a reconnect makes a new one, so the
    // record has to outlive them.
    const inboundAll: string[] = [];
    let seq = 0;
    let ready = false;
    let drops = 0;

    const KINDS = ["state", "patches", "cfg", "proto", "ack", "tt-state"];

    try {
      await main.waitFor(() => srv.conns() > 0);

      for (let i = 0; i < steps; i++) {
        const r = rnd();
        if (r < 0.42) {
          const kind = pick(KINDS);
          const s = ++seq;
          const line = JSON.stringify({ v: 2, t: kind, d: { seq: s } });
          trail.push(`write ${kind}#${s}`);
          if (rnd() < 0.3) {
            // Split across chunk boundaries, including inside the payload.
            const cut = 1 + Math.floor(rnd() * (line.length - 2));
            await srv.write(line.slice(0, cut));
            await new Promise((r2) => setTimeout(r2, 5));
            await srv.write(line.slice(cut) + "\n");
          } else {
            await srv.writeLine(line);
          }
          written.push({ seq: s, kind, lossAllowed: false });
        } else if (r < 0.55) {
          trail.push("ready");
          await main.rendererReady();
          ready = true;
        } else if (r < 0.65) {
          trail.push("navigate(main)");
          await main.startNavigation();
          ready = false;
        } else if (r < 0.72) {
          // A <webview> guest navigating must NOT touch the main frame's
          // readiness — doing so froze the relay forever.
          trail.push("navigate(sub)");
          await main.cmd({
            cmd: "wc",
            event: "did-start-navigation",
            args: [{ isMainFrame: false }, "", false, false],
          });
        } else if (r < 0.80 && drops < 3) {
          drops++;
          const mid = rnd() < 0.5;
          trail.push(mid ? "drop(mid-frame)" : "drop");
          if (mid) {
            const s = ++seq;
            // A half-written frame: legitimately lost with its connection.
            await srv.write(
              JSON.stringify({ v: 2, t: "state", d: { seq: s } }).slice(0, 12),
            );
            written.push({ seq: s, kind: "state", lossAllowed: true });
          }
          inboundAll.push(...srv.inbound);
          srv.dropConn();
          srv.close();
          await Deno.remove(sockPath).catch(() => {});
          await new Promise((r2) => setTimeout(r2, 30));
          srv = rawServer(sockPath);
          await main.waitFor(() => srv.conns() > 0, 20000);
        } else if (r < 0.90) {
          const line = JSON.stringify({
            v: 2,
            t: "action",
            d: { type: "t", cid: `c${i}` },
          });
          trail.push(`ipcSend#${i}`);
          sent.push(line);
          await main.send(line);
        } else {
          await new Promise((r2) => setTimeout(r2, 15));
        }
      }

      // Quiesce with the renderer ready.
      if (!ready) await main.rendererReady();
      await new Promise((r2) => setTimeout(r2, 250));

      const ctx = () =>
        `\nseed=${seed} trail=${trail.join(" → ")}\ndelivered=${
          JSON.stringify(main.msgs())
        }`;

      // I1 — decodable, and ours.
      const bySeq = new Map(written.map((w) => [w.seq, w]));
      const delivered = main.msgs().map((line) => {
        const f = JSON.parse(line) as {
          v: number;
          t: string;
          d: { seq: number };
        };
        assertEquals(f.v, 2, `I1 undecodable/foreign frame ${line}${ctx()}`);
        assert(bySeq.has(f.d.seq), `I1 unknown seq ${f.d.seq}${ctx()}`);
        assertEquals(
          bySeq.get(f.d.seq)!.kind,
          f.t,
          `I1 frame kind changed in flight${ctx()}`,
        );
        return f;
      });

      // I2 — strictly increasing, with ONE sanctioned exception: a main-frame
      // navigation re-hands the newest snapshot to the fresh document, so a
      // `state` frame already delivered may appear again. Everything else
      // going backwards, repeating, or arriving twice is a reordering bug.
      const seen = new Set<number>();
      let replays = 0;
      let last = -1;
      for (const cur of delivered) {
        const isReplay = cur.t === "state" && seen.has(cur.d.seq);
        if (isReplay) {
          replays++;
          continue; // a re-seed does not advance the stream
        }
        assert(
          cur.d.seq > last,
          `I2 out-of-order/duplicate: #${last} then #${cur.d.seq} (${cur.t})${ctx()}`,
        );
        last = cur.d.seq;
        seen.add(cur.d.seq);
      }
      const navigations = trail.filter((t) => t === "navigate(main)").length;
      assert(
        replays <= navigations,
        `I2 ${replays} snapshot replays for ${navigations} navigations${ctx()}`,
      );

      // I3 — connection-scoped frames are irreplaceable; none may vanish.
      const got = new Set(delivered.map((f) => f.d.seq));
      for (const w of written) {
        if (w.lossAllowed) continue;
        if (w.kind === "state" || w.kind === "patches") continue;
        assert(got.has(w.seq), `I3 lost ${w.kind}#${w.seq}${ctx()}`);
      }

      // I4 — the renderer's newest snapshot is the server's newest.
      const lastWrittenState = [...written].reverse().find((w) =>
        w.kind === "state" && !w.lossAllowed
      );
      const lastGotState = [...delivered].reverse().find((f) =>
        f.t === "state"
      );
      if (lastWrittenState) {
        assert(lastGotState, `I4 no snapshot ever delivered${ctx()}`);
        assertEquals(
          lastGotState!.d.seq,
          lastWrittenState.seq,
          `I4 renderer's snapshot is stale${ctx()}`,
        );
      }

      // I5 — renderer→server actions all land.
      const landed = () => new Set([...inboundAll, ...srv.inbound]);
      await main.waitFor(
        () => {
          const got = landed();
          return sent.every((l) => got.has(l));
        },
        3000,
      ).catch(() => {
        const got = landed();
        const missing = sent.filter((l) => !got.has(l));
        throw new Error(
          `I5 ${missing.length} action(s) never reached the server${ctx()}`,
        );
      });
    } finally {
      await main.close();
      srv.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }
});

// ── The aio:// scheme: the app's routes, through the shell, STREAMED ───────
//
// field report §1: a wallet shows artwork with `<img src="/nft-image/<sha>">` served
// by a custom route — up to 100 MB each. On the zero-port page that URL is
// `aio://app/nft-image/<sha>`, and the protocol handler proxies it to the
// app's HTTP handler over the socket. Three things must hold: status and
// headers pass through untouched (nosniff, content-type), the bytes are
// binary-identical, and the body is a STREAM — the handler resolves on
// headers, before the app has finished writing, so nothing is buffered.

/** The app's HTTP handler on a unix socket: streams `chunks` with a pause
 *  between them, records when the last one was written, echoes POST bodies. */
function streamingHttpServer(
  path: string,
  chunks: Uint8Array[],
  gapMs: number,
) {
  const marks = { lastWriteAt: 0, firstWriteAt: 0 };
  const server = Deno.serve(
    { path, onListen: () => {} },
    async (req) => {
      const u = new URL(req.url);
      if (req.method === "POST") {
        return new Response("echo:" + await req.text(), { status: 201 });
      }
      if (u.pathname === "/gone") return new Response(null, { status: 204 });
      if (!u.pathname.startsWith("/nft-image/")) {
        return new Response("Not Found", { status: 404 });
      }
      const body = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
            const now = Date.now();
            if (i === 0) marks.firstWriteAt = now;
            marks.lastWriteAt = now;
            ctrl.enqueue(chunks[i]!);
          }
          ctrl.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    },
  );
  return { marks, close: () => server.shutdown() };
}

function randomChunks(n: number, size: number): Uint8Array[] {
  return Array.from({ length: n }, () => {
    const c = new Uint8Array(size);
    crypto.getRandomValues(c);
    c[0] = 0; // NUL and 0xFF on purpose — a text path would mangle both
    c[1] = 0xff;
    return c;
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

Deno.test("electron aio://: a route response streams through the socket, headers and bytes intact", async () => {
  await withHarness(async (_srv, main, dir) => {
    const chunks = randomChunks(4, 64 * 1024);
    const GAP = 200;
    const http = streamingHttpServer(join(dir, "http.sock"), chunks, GAP);
    try {
      const priv = main.events.find((e) => e.ev === "privileges")?.privileges;
      assert(priv, "the scheme was registered as privileged");
      assertEquals(
        priv!.stream,
        true,
        "stream: true — Chromium may read the body as it arrives",
      );
      assertEquals(
        priv!.standard,
        true,
        "standard — relative URLs and caching work",
      );

      const r = await main.proto("aio://app/nft-image/abc");
      assertEquals(r.status, 200);
      assertEquals(r.headers["content-type"], "image/png");
      assertEquals(
        r.headers["x-content-type-options"],
        "nosniff",
        "nosniff passes through",
      );
      assertEquals(
        r.headers["cache-control"],
        "private, max-age=31536000, immutable",
        "cache headers pass through — Chromium caches by scheme+URL",
      );
      assertEquals(r.bytes, concat(chunks), "binary body is byte-identical");
      assert(r.isStream, "the Response body is a ReadableStream");
      // Streamed, not buffered: the handler resolved on headers, before the
      // app wrote its last chunk (which came 3×GAP after the first).
      assert(
        r.resolvedAt < http.marks.lastWriteAt,
        `handler resolved at +${
          r.resolvedAt - r.t0
        }ms but the last chunk was ` +
          `written at +${
            http.marks.lastWriteAt - r.t0
          }ms — the body was buffered`,
      );
      assert(
        r.endedAt >= http.marks.lastWriteAt,
        "the body was read to the end",
      );

      // A request body goes the other way through the same pipe.
      const p = await main.proto("aio://app/nft-image/x", "POST", "hello");
      assertEquals(p.status, 201);
      assertEquals(new TextDecoder().decode(p.bytes), "echo:hello");

      // A body-less status must not become a stream Response() rejects.
      const g = await main.proto("aio://app/gone");
      assertEquals(g.status, 204);
      assertEquals(g.bytes.length, 0);
    } finally {
      await http.close();
    }
  }, { httpSocket: true });
});

// ── Prod: page from dist/, routes through the socket ─────────────────────
//
// A packaged app's window reads the bundle off disk and needs no server for
// it. Its custom routes are not on disk: when the app runs its handler on a
// socket, every path dist/ does not hold falls through to it. Without a
// socket that path is a 404, exactly as before.
Deno.test("electron aio://: FROM_DISK serves dist/ and falls through to the socket for routes", async () => {
  const mkDist = async (dir: string) => {
    const dist = join(dir, "dist");
    await Deno.mkdir(dist);
    await Deno.writeTextFile(join(dist, "app.js"), "// bundle");
    return dist;
  };
  await withHarness(async (_srv, main, dir) => {
    const chunks = randomChunks(2, 1024);
    const http = streamingHttpServer(join(dir, "http.sock"), chunks, 10);
    try {
      const page = await main.proto("aio://app/");
      assertEquals(page.status, 200);
      assert(
        new TextDecoder().decode(page.bytes).includes("<html"),
        "the page comes from the templated shell",
      );
      const js = await main.proto("aio://app/app.js");
      assertEquals(js.status, 200);
      assertEquals(
        new TextDecoder().decode(js.bytes),
        "// bundle",
        "app.js comes off disk",
      );
      assertEquals(js.headers["content-type"], "application/javascript");
      const img = await main.proto("aio://app/nft-image/abc");
      assertEquals(img.status, 200, "a route path falls through to the socket");
      assertEquals(img.headers["x-content-type-options"], "nosniff");
      assertEquals(img.bytes, concat(chunks));
      assert(img.isStream, "…streamed");
      const miss = await main.proto("aio://app/nope");
      assertEquals(miss.status, 404, "the socket's own 404 passes through");
    } finally {
      await http.close();
    }
  }, { httpSocket: true, baseDir: mkDist });

  // No socket: dist/ only, and a route path is a plain 404 (no proxy target).
  await withHarness(async (_srv, main) => {
    const js = await main.proto("aio://app/app.js");
    assertEquals(js.status, 200);
    const miss = await main.proto("aio://app/nft-image/abc");
    assertEquals(miss.status, 404);
  }, { baseDir: mkDist });
});
