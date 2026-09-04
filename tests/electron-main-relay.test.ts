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
      else if (m.cmd === 'wc') {
        // A committed navigation is what moves the document's url.
        if (m.event === 'did-navigate' && m.args && m.args[1]) _curUrl = m.args[1];
        for (const f of (wcH[m.event] || [])) f(...(m.args || []));
      }
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
let _curUrl = '';
const webContents = {
  on: (e, fn) => { (wcH[e] = wcH[e] || []).push(fn); },
  // What the shell reads to tell a RELOAD (same url) from a route change.
  getURL: () => _curUrl,
  isLoading: () => false,
  send: (channel, arg) => ev({ ev: 'send', channel, arg }),
  setWindowOpenHandler: () => {},
  session: { clearCache: () => Promise.resolve(), clearStorageData: () => Promise.resolve() },
  print: () => {}, reloadIgnoringCache: () => {}, toggleDevTools: () => {},
};
class BrowserWindow {
  constructor(o) { this.opts = o; this.webContents = webContents; }
  on() {} center() {} setIcon() {} setMenuBarVisibility() {}
  loadURL(u) { _curUrl = u; ev({ ev: 'loadURL', url: u }); }
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
  const script = electronMainScriptUDS("http://127.0.0.1:1/", sockPath, {
    title: opts.title ?? "harness",
    httpSocketPath: opts.httpSocketPath,
    baseDir: opts.baseDir,
  });
  // FAIL LOUD, NEVER HANG. The generated program is a template literal
  // assembled from a dozen fragments, and one stray backslash or backtick in
  // any of them is a SyntaxError in main.cjs — which made the child exit
  // before it ever dialled the control socket, and `ctrl.accept()` below wait
  // for it forever. A whole suite that hangs on a typo reports nothing at all.
  // `new Function` parses the CJS text (require is just an identifier to it)
  // and throws the parser's own message, with the line, instead.
  try {
    new Function(script);
  } catch (e) {
    throw new Error(`the generated main.cjs does not parse — ${e}`);
  }
  await Deno.writeTextFile(join(dir, "main.cjs"), script);

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

  // …and a child that dies at runtime before dialling in (a throw at module
  // scope, a missing stub method) must fail with ITS stderr, not hang here.
  const conn = await Promise.race([
    ctrl.accept(),
    proc.status.then((st) => {
      throw new Error(
        `main.cjs exited (code ${st.code}) before connecting to the harness:\n` +
          stderr.join("") + stdout.join(""),
      );
    }),
  ]);
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
    /** A navigation that REPLACES the document (a reload, a load of a new URL).
     *  Positional legacy signature: (event, url, isInPlace, isMainFrame). */
    startNavigation: () =>
      cmd({
        cmd: "wc",
        event: "did-start-navigation",
        args: [{}, "", false, true],
      }),
    /** A SAME-DOCUMENT navigation — history.pushState / replaceState / a hash
     *  change. `isInPlace` is true and no new document loads, so no second
     *  `__aio:ready` is ever coming. This is what the ROUTER does after the
     *  shell relays a vetoed click back to it. `details` also drives the
     *  MODERN Electron signature, where the flag arrives as
     *  `event.isSameDocument` rather than positionally. */
    samePageNavigation: (details = false, url = "aio://app/activity") =>
      cmd({
        cmd: "wc",
        event: "did-start-navigation",
        args: details
          ? [{ url, isSameDocument: true, isMainFrame: true }]
          : [{}, url, true, true],
      }),
    /** The document's navigation COMMITTED — a real load reached a new
     *  document. A vetoed navigation never gets here (measured). */
    didNavigate: (url = "aio://app/") =>
      cmd({ cmd: "wc", event: "did-navigate", args: [{}, url] }),
    /** A click on a link, EXACTLY as Electron 44 emits it (measured, see the
     *  header): `did-start-navigation` first — cross-document, main frame —
     *  and THEN `will-navigate`, where the shell decides. Returns whether the
     *  shell vetoed it. For an in-app link nothing else follows: no
     *  did-fail-load, no did-navigate, no new document. `legacy` drives the
     *  positional did-start-navigation signature instead of the details
     *  object. */
    async clickLink(url: string, legacy = false) {
      await cmd({
        cmd: "wc",
        event: "did-start-navigation",
        args: legacy
          ? [{}, url, false, true]
          : [{ url, isSameDocument: false, isMainFrame: true }],
      });
      const id = await cmd({ cmd: "wc", event: "will-navigate", url });
      const r = events.find((e) => e.ev === "navigate" && e.id === id)!;
      return r.prevented as boolean;
    },
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

    // Ctrl+R: a new main-frame document starts loading … and COMMITS. (The
    // re-seed happens at the commit, which a vetoed navigation never reaches.)
    await main.startNavigation();
    await main.didNavigate("aio://app/");
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
      // navigation re-hands the fresh document what it missed — the newest
      // snapshot, and the connection's `proto` hello and `cfg` frame (sent
      // once at accept, to a document that is gone) — so one of each may
      // appear again, at most once per navigation. Everything else going
      // backwards, repeating, or arriving twice is a reordering bug.
      const RESEEDED = new Set(["state", "proto", "cfg"]);
      const seen = new Set<number>();
      const replays = new Map<string, number>();
      let last = -1;
      for (const cur of delivered) {
        const isReplay = RESEEDED.has(cur.t) && seen.has(cur.d.seq);
        if (isReplay) {
          replays.set(cur.t, (replays.get(cur.t) ?? 0) + 1);
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
      for (const [kind, n] of replays) {
        assert(
          n <= navigations,
          `I2 ${n} ${kind} replays for ${navigations} navigations${ctx()}`,
        );
      }

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

// ── cc §5.1 / §5.2 / §5.3 — ONE in-app route change killed the downlink ──
//
// The sequence below is what REAL Electron 44 emits for a click on an in-app
// link, measured (scratch probe, 2026-09-04) rather than assumed:
//
//     did-start-navigation  { isSameDocument: false, isMainFrame: true }
//     will-navigate         → the shell vetoes and relays the url in-app
//     did-stop-loading      — and nothing else. No did-fail-load. Ever.
//
// did-start-navigation fires FIRST and as a cross-document navigation; the
// shell closed the relay on it and then vetoed the navigation, so the old
// document stayed with its relay closed for the rest of its life. A first fix
// guarded on isSameDocument and passed — because this stub fired the events
// in the order the fix expected. The reporter measured 17 frames pushed and 0
// received on the real shell, with both tests green: "the test double and
// Electron disagree on the one event the fix depends on, and the suite reports
// the disagreement as success." This is that harness, corrected to the wire.
// The REAL shell is driven in tests/electron-route-change-e2e.test.ts.
//
// URLs below are on the harness page's origin (http://127.0.0.1:1 — the
// zero-port aio://app/ shell is a separate opt-in, see the aio:// tests): a
// url on another origin is EXTERNAL to the shell and never reaches the
// in-app path this section is about.
for (const legacy of [false, true]) {
  Deno.test(
    `electron main: an in-app link click keeps the downlink (${
      legacy ? "legacy positional" : "modern details"
    } signature)`,
    async () => {
      await withHarness(async (srv, main) => {
        await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
        await main.rendererReady();
        await main.finishLoad();
        await main.didNavigate("http://127.0.0.1:1/");
        await main.waitFor(() => main.msgs().length >= 1);
        const before = main.msgs().length;

        // The click, in Electron's order: the gate closes, THEN the veto.
        assertEquals(
          await main.clickLink("http://127.0.0.1:1/settings", legacy),
          true,
          "an in-app link must be vetoed and relayed, not loaded",
        );
        // …then the router pushState()s, which is a same-document navigation.
        await main.samePageNavigation(!legacy, "http://127.0.0.1:1/settings");

        // The server keeps talking. Every one of these has to arrive — with no
        // did-fail-load and no new document, nothing else will ever reopen
        // the relay if the veto did not.
        await srv.writeLine('{"v":2,"t":"state","d":{"n":2}}');
        await srv.writeLine('{"v":2,"t":"ui-surface","d":{"id":"q1"}}');
        await main.waitFor(() => main.msgs().length >= before + 2, 3000).catch(
          () => {},
        );
        const after = main.msgs().slice(before).map(kindOf);
        assert(
          after.includes("state") && after.includes("ui-surface"),
          `the downlink died on an in-app link click — after it the renderer ` +
            `received ${JSON.stringify(after)}. The document was never ` +
            `replaced, so nothing will ever send __aio:ready again.`,
        );
      });
    },
  );
}

// A reload is the ONE same-app navigation that must go through: it is how the
// dev live-reload works and the only way a page gets a new document. Measured:
// location.reload() reaches will-navigate carrying the CURRENT url. The shell
// used to exempt the root PATH instead, so a reload on /settings was vetoed —
// dev reload silently did nothing off the home page, and stalled the relay.
Deno.test("electron main: a reload of the CURRENT url is allowed on any route", async () => {
  await withHarness(async (_srv, main) => {
    await main.rendererReady();
    await main.finishLoad();
    await main.didNavigate("http://127.0.0.1:1/settings"); // the document on screen
    assertEquals(
      await main.clickLink("http://127.0.0.1:1/settings"),
      false,
      "a navigation to the url already on screen is a reload and must not be vetoed",
    );
  });
});

// …and navigating HOME is a route change like any other. The root-path
// exemption reloaded the whole window — a white flash, a re-mounted tree, a
// new connection — on every app's most frequent navigation; a field report
// renamed its home page to /chat to escape it (cc §5.3, ask 4).
Deno.test("electron main: navigating to / from another route is in-app, not a reload", async () => {
  await withHarness(async (srv, main) => {
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await main.rendererReady();
    await main.finishLoad();
    await main.didNavigate("http://127.0.0.1:1/settings");
    await main.waitFor(() => main.msgs().length >= 1);
    const before = main.msgs().length;
    assertEquals(
      await main.clickLink("http://127.0.0.1:1/"),
      true,
      "home is a route, not a reload",
    );
    await srv.writeLine('{"v":2,"t":"state","d":{"n":2}}');
    await main.waitFor(() => main.msgs().length > before, 3000).catch(() => {});
    assert(
      main.msgs().slice(before).map(kindOf).includes("state"),
      "…and the downlink survives it",
    );
  });
});

// The FIRST load has no document to compare against; the old root rule stands
// there so an http://127.0.0.1:1/ boot is never vetoed before it begins.
Deno.test("electron main: with no document yet, the root is still allowed through", async () => {
  await withHarness(async (_srv, main) => {
    assertEquals(await main.clickLink("http://127.0.0.1:1/"), false);
  });
});

// A stalled relay must be SAID where it can be seen: the window gets the
// dropped-socket signal (its banner shows instead of a frozen page claiming to
// be connected) and the server hears a client degradation for /__aio/health
// and `am status`. Then the heal is reported the same way. (cc §5.3, asks 2+3.)
Deno.test({
  name:
    "electron main: a stalled relay reaches the window and the server, and reports its heal",
  sanitizeOps: false, // aio-ok: the stall detector has a real 5s window; waiting it out IS the test
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    await withHarness(async (srv, main) => {
      await main.rendererReady();
      await main.finishLoad();
      await main.didNavigate("http://127.0.0.1:1/");
      await main.startNavigation(); // the gate closes …
      await new Promise((r) => setTimeout(r, 5300));
      const inboundBefore = srv.inbound.length;
      await srv.writeLine('{"v":2,"t":"state","d":{"n":9}}'); // … and a frame queues behind it
      await main.waitFor(
        () =>
          srv.inbound.slice(inboundBefore).some((l) => l.includes('"cdiag"')) &&
          main.channels().includes("__aio:close"),
        3000,
      );
      const down = srv.inbound.slice(inboundBefore).find((l) =>
        l.includes('"cdiag"')
      )!;
      assert(
        down.includes('"kind":"down"') && down.includes("electron:relay"),
        down,
      );
      // The heal: the document was in fact still there (a vetoed navigation).
      await main.clickLink("http://127.0.0.1:1/x");
      await main.waitFor(
        () => srv.inbound.some((l) => l.includes('"kind":"up"')),
        3000,
      );
    });
  },
});

// The other half of the same rule: a navigation that DOES replace the document
// must still clear readiness, or a brand-new document is handed frames its
// renderer never registered listeners for.
Deno.test("electron main: a real document navigation still gates on the new renderer", async () => {
  await withHarness(async (srv, main) => {
    await main.rendererReady();
    await main.finishLoad();
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await main.waitFor(() => main.msgs().length >= 1);
    const before = main.msgs().length;

    await main.startNavigation(); // a real load — the document is going away
    await main.didNavigate("aio://app/next");
    await srv.writeLine('{"v":2,"t":"ui-surface","d":{"id":"q2"}}');
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(
      main.msgs().length,
      before,
      "frames must WAIT for the new document to signal ready",
    );

    await main.rendererReady(); // the new document arrives
    await main.waitFor(() => main.msgs().length > before);
    assert(
      main.msgs().slice(before).map(kindOf).includes("ui-surface"),
      "and then everything queued is delivered",
    );
  });
});

// The guarantee `tests/aio26-electron-replay.test.ts` asserts on the SOURCE —
// "a main-frame navigation re-seeds the queue with the last snapshot" — proved
// on the real relay instead. A string test measures how the code is written; a
// new document either receives that snapshot or it does not.
//
// Why it matters: a new document starts with NO base state, so a queued DELTA
// is meaningless to it. Handing one over would apply a patch to `{}` — Immer's
// out-of-range array `add` splices rather than throwing, so the result is not
// an error, it is a silently wrong list.
Deno.test("electron main: a new document is re-seeded with the last snapshot, never a delta", async () => {
  await withHarness(async (srv, main) => {
    await main.rendererReady();
    await main.finishLoad();
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await main.waitFor(() => main.msgs().length >= 1);

    // A delta arrives, then the document goes away before a newer one loads.
    await srv.writeLine('{"v":2,"t":"patches","d":[{"op":"replace"}]}');
    await main.waitFor(() => main.msgs().length >= 2);
    const before = main.msgs().length;

    await main.startNavigation(); // a REAL document navigation …
    await main.didNavigate("aio://app/next"); // … that COMMITTED
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(
      main.msgs().length,
      before,
      "nothing may reach a document that is going away",
    );

    await main.rendererReady(); // the new document announces itself
    await main.waitFor(() => main.msgs().length > before);
    const delivered = main.msgs().slice(before).map(kindOf);
    assertEquals(
      delivered,
      ["state"],
      `a fresh document must be handed the SNAPSHOT and nothing else: the ` +
        `delta queued before the navigation assumes a base this document ` +
        `does not have, and replaying it applies a patch to {} — Immer's ` +
        `out-of-range array \`add\` SPLICES rather than throwing, so the ` +
        `result is not an error, it is a silently wrong list. ` +
        `Got ${JSON.stringify(delivered)}`,
    );
  });
});

// ── The reload of a PACKAGED window: proto and cfg are connection-scoped, the
//    document is not ────────────────────────────────────────────────────────
//
// The server writes `proto` and `cfg` ONCE, at accept (src/server/uds.ts): the
// socket belongs to the main process and outlives every document, so a reload
// — Ctrl+R (tmplKeyboardShortcuts), Ctrl+Shift+Del, the app's own
// location.reload() — never reaches the server as a new connection. The relay
// re-seeded the fresh document with the last SNAPSHOT and nothing else, so
// the reloaded page had state and no config. On the packaged aio:// shell
// `cfg` is the ONLY way the page learns `syncCells` (localFirst adoption —
// sync-cells.ts reads `__aioConfig.syncCells`), `callTimeouts` and
// `renderBudget`: udsProdHTML embeds none of them, by design ("the cfg frame
// fills them at connect"). After one Ctrl+R every localFirst cell silently
// went back to round-tripping through the server and every awaited call ran
// on the default ceiling — dev (whose shell embeds the same keys) never saw
// it. A new document must be handed the hello and the config it missed, and
// in accept order: proto, cfg, then the snapshot.
Deno.test("electron main: a reloaded document is re-seeded with the connection's proto and cfg, in accept order", async () => {
  await withHarness(async (srv, main) => {
    await srv.writeLine('{"v":2,"t":"proto","d":{"v":2,"min":2}}');
    await srv.writeLine('{"v":2,"t":"cfg","d":{"callTimeouts":{"a":1}}}');
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await main.startNavigation(); // loadURL's own navigation …
    await main.didNavigate("aio://app/"); // … commits
    await main.rendererReady();
    await main.finishLoad();
    await main.waitFor(() => main.msgs().length >= 3);
    assertEquals(
      main.msgs().map(kindOf),
      ["proto", "cfg", "state"],
      "the first document gets the accept-time frames exactly once",
    );
    const before = main.msgs().length;

    // Ctrl+R: a NEW document on the SAME connection. The server hears nothing.
    await main.startNavigation();
    await main.didNavigate("aio://app/");
    await main.rendererReady();
    await main.waitFor(() => main.msgs().length > before);
    await new Promise((r) => setTimeout(r, 150));
    assertEquals(
      main.msgs().slice(before).map(kindOf),
      ["proto", "cfg", "state"],
      "a reloaded document must receive the connection's hello and config " +
        "again, before its snapshot — the server sent them once, at accept, " +
        "to a document that no longer exists",
    );
  });
});

// …and a cfg that is still QUEUED when the document changes is delivered once,
// not twice: the re-seed fills a gap, it never duplicates a frame in flight.
Deno.test("electron main: the proto/cfg re-seed never duplicates a frame still in the queue", async () => {
  await withHarness(async (srv, main) => {
    await srv.writeLine('{"v":2,"t":"proto","d":{"v":2,"min":2}}');
    await srv.writeLine('{"v":2,"t":"cfg","d":{"callTimeouts":{"a":1}}}');
    await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
    await new Promise((r) => setTimeout(r, 150));
    // The frames are queued (no document has signalled ready) when the
    // initial navigation commits.
    await main.startNavigation();
    await main.didNavigate("aio://app/");
    await main.rendererReady();
    await main.waitFor(() => main.msgs().length >= 3);
    await new Promise((r) => setTimeout(r, 150));
    assertEquals(main.msgs().map(kindOf), ["proto", "cfg", "state"]);
  });
});

// ── The instrument must report what is TRUE: a slow load is not a stall ──
//
// The gate closes on loadURL's own navigation, before any document has ever
// signalled ready. A busy app's frames arrive while a large bundle parses;
// after 5 s the detector declared a stall — "down" to /__aio/health, the
// dropped-socket signal to a page that had no listener yet — and "up" when
// the page simply arrived. A client that is provably loading was reported
// down. Now: no victim, no stall. One info line says the load is slow.
Deno.test({
  name:
    "electron main: a slow FIRST load with frames arriving is not a stall — no __aio:close, no cdiag down",
  sanitizeOps: false, // aio-ok: the detector's window is a real 5s; the test has to outlast it
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    await withHarness(async (srv, main) => {
      await main.startNavigation(); // loadURL — no document has ever been ready
      for (let i = 1; i <= 6; i++) {
        await srv.writeLine(`{"v":2,"t":"state","d":{"n":${i}}}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert(
        !main.channels().includes("__aio:close"),
        "a loading document must not be sent the dropped-socket signal",
      );
      assert(
        !srv.inbound.some((l) => l.includes('"cdiag"')),
        `the server must not hear "down" for a client that is loading: ${
          srv.inbound.filter((l) => l.includes("cdiag")).join("\n")
        }`,
      );
      const said = main.stderr.join("") + main.stdout.join("");
      assert(!said.includes("has not signalled ready"), said);
      assert(
        said.includes("still loading after"),
        `the slow load is observed, once, as a load: ${said}`,
      );
      // …and when the document arrives it gets the newest snapshot, as ever.
      await main.rendererReady();
      await main.waitFor(() => main.msgs().length >= 1);
      assertEquals(main.msgs().map(kindOf), ["state"]);
      assert(main.msgs()[0]!.includes('"n":6'));
      assert(
        !srv.inbound.some((l) => l.includes('"cdiag"')),
        "no heal either — nothing was ever down",
      );
    });
  },
});

// The same truth after a RELOAD: once the navigation commits, the old
// document is gone and the new one will announce itself — waiting for it is a
// load. (The stall is the gap before a commit: gate closed on a listening
// document, no commit, no veto — the existing stall test above.)
Deno.test({
  name:
    "electron main: a slow reload (navigation committed) is not a stall either",
  sanitizeOps: false, // aio-ok: see above
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    await withHarness(async (srv, main) => {
      await srv.writeLine('{"v":2,"t":"state","d":{"n":1}}');
      await main.rendererReady();
      await main.finishLoad();
      await main.didNavigate("http://127.0.0.1:1/");
      await main.waitFor(() => main.msgs().length >= 1);
      await main.startNavigation(); // Ctrl+R: the gate closes on a live document …
      await main.didNavigate("http://127.0.0.1:1/"); // … and the new document COMMITS
      await new Promise((r) => setTimeout(r, 5300));
      await srv.writeLine('{"v":2,"t":"state","d":{"n":2}}');
      await new Promise((r) => setTimeout(r, 200));
      assert(
        !srv.inbound.some((l) => l.includes('"cdiag"')) &&
          !main.channels().slice(1).includes("__aio:close"),
        "a committed reload that is slow to signal ready is a load, not a stall",
      );
    });
  },
});
