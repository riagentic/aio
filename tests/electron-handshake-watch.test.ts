// A window whose server does not answer must say so — not sit blank forever.
//
// The server speaks first on the app's socket: `proto` arrives the moment a
// connection is accepted. A connection that is accepted and told NOTHING is
// either a server too busy to greet it yet (a large state to restore) or,
// under the production local-peer lockdown, a process the server does not
// serve — the app's own window when it was launched through a wrapper that
// did not exec Electron. The Electron main process used to wait on that
// silent connection indefinitely: a blank window, and no line on either side
// saying why.
//
// The generated main script watches the handshake: 5 s of silence is reported
// ONCE (a warning that names both causes — it cannot know which), shown in
// the window's title, and the connection is dropped so the reconnect loop
// tries again, on its normal backoff. When the server answers, the title is
// taken back — unless the page set its own meanwhile.
//
// Instrument: the generated main.cjs is RUN (Deno's node-compat, a stub
// `electron` module) against a real unix socket whose server stays silent —
// evaluated, never string-matched. The last two cases run the same script in
// the REAL Electron (ELECTRON_E2E=1, the nested test display): the title is
// then the real window's, and a page that sets `document.title` moves it the
// way Chromium does — what a stub that agrees with its author cannot show.
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { listenLocal, type LocalConn } from "../src/server/local-listen.ts";
import { realElectronBin } from "../src/electron/electron-spawn.ts";
import { descendantPids } from "../src/server/single-instance-lock.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { accountEnv } from "./e2e-app-harness.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";

/** Why the real-Electron cases do not run here, or null. Same gate as
 *  tests/electron-server-gone-e2e.test.ts. */
function realSkip(): string | null {
  if (Deno.build.os !== "linux") return "linux (nested X display)";
  try {
    Deno.statSync(ELECTRON_BIN);
  } catch {
    return "Electron not installed — run: deno task install:electron";
  }
  if (!Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY")) {
    return "no display (set DISPLAY or WAYLAND_DISPLAY)";
  }
  if (!Deno.env.get("ELECTRON_E2E")) {
    return "E2E disabled — set ELECTRON_E2E=1 to run";
  }
  return null;
}

/** Appended to the generated main for the real Electron: the REAL window
 *  reports every title it comes to have, and — as the stub does — a page
 *  sets its own while the notice is up when the case asks for it. */
const REAL_TITLE_PROBE = `
app.on('browser-window-created', (_e, w) => {
  let last = null;
  setInterval(() => {
    if (w.isDestroyed()) return;
    const t = w.getTitle();
    if (t === last) return;
    last = t; console.log('TITLE ' + t);
    if (process.env.AIO_STUB_PAGE_TITLE && t.includes('no answer')) {
      w.webContents.executeJavaScript("document.title = 'set by the page'")
        .then(() => console.log('PAGE-TITLE'), (e) => console.log('PAGE-TITLE-FAILED ' + e));
    }
  }, 25);
});
`;

/** The least `electron` the generated main process boots against. The window
 *  reports every title it is given on stdout. */
const ELECTRON_STUB = `
let title = 'myapp';
// The LEVEL each line was said at, in the line.
for (const level of ['info', 'warn', 'error']) {
  console[level] = (...a) => process.stderr.write(level.toUpperCase() + ' ' + a.join(' ') + '\\n');
}
const webContents = {
  on() {}, getURL: () => '', isLoading: () => false, send() {},
  setWindowOpenHandler() {},
  session: { clearCache: () => Promise.resolve(), clearStorageData: () => Promise.resolve() },
};
class BrowserWindow {
  constructor() { this.webContents = webContents; }
  on() {} center() {} setIcon() {} setMenuBarVisibility() {} loadURL() {}
  isDestroyed() { return false; } isVisible() { return true; } isMinimized() { return false; }
  getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
  getTitle() { return title; }
  setTitle(t) {
    title = t; console.log('TITLE ' + t);
    // The page, setting its own title while the notice is up.
    if (process.env.AIO_STUB_PAGE_TITLE && t.includes('no answer')) {
      setTimeout(() => { title = 'set by the page'; console.log('PAGE-TITLE'); }, 50);
    }
  }
}
module.exports = {
  app: {
    on: (e, fn) => { if (e === 'ready') setTimeout(fn, 0); },
    getPath: () => process.env.AIO_STUB_DIR, commandLine: { appendSwitch() {} },
    quit() {}, name: 'stub',
    whenReady: () => new Promise((r) => setTimeout(r, 0)),
  },
  BrowserWindow,
  // macOS: the generated main builds its menu after whenReady (tmplAppMenu;
  // the menu itself is pinned by electron-window-close-and-menu.test.ts).
  Menu: { setApplicationMenu() {}, buildFromTemplate: (t) => t },
  ipcMain: { on() {}, handle() {} },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  shell: { openExternal() {} },
  dialog: {},
  nativeImage: { createFromDataURL: () => ({}) },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {}, webRequest: { onHeadersReceived() {} } } },
};
`;

/** Run the generated main against a server that stays silent on its first
 *  `silent` connections and greets every later one — under Deno with the stub
 *  `electron`, or (`real`) in the real Electron on the test display. */
async function withSilentServer(
  silent: number,
  env: Record<string, string>,
  f: (h: {
    out: () => string;
    /** When each connection was accepted (ms). */
    accepted: number[];
    until: (pred: () => boolean, what: string, ms?: number) => Promise<void>;
  }) => Promise<void>,
  real = false,
): Promise<void> {
  const dir = await tempDir("el-handshake-");
  // The app's local transport: a unix socket, a named pipe on Windows.
  const sockPath = localEndpoint(join(dir, "app.sock"));
  const listener = listenLocal(sockPath);
  const conns: LocalConn[] = [];
  const accepted: number[] = [];
  const accepting = (async () => {
    for await (const c of listener) {
      conns.push(c);
      accepted.push(performance.now());
      // Drain what the window writes, so its socket never backs up.
      c.readable.pipeTo(new WritableStream()).catch(() => {});
      if (conns.length > silent) {
        const w = c.writable.getWriter();
        await w.write(
          new TextEncoder().encode(
            '{"v":2,"t":"proto","d":{"v":3,"min":3,"ver":"0.0.0"}}\n',
          ),
        ).catch(() => {});
        w.releaseLock();
      }
    }
  })().catch(() => {});

  await Deno.mkdir(join(dir, "node_modules", "electron"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "node_modules", "electron", "package.json"),
    JSON.stringify({ name: "electron", version: "0.0.0", main: "index.js" }),
  );
  await Deno.writeTextFile(
    join(dir, "node_modules", "electron", "index.js"),
    ELECTRON_STUB,
  );
  // `manual`: resolve the stub, never the real npm:electron.
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ nodeModulesDir: "manual" }),
  );
  // The real window loads a real page: its <title> is the window's title.
  const page = join(dir, "index.html");
  if (real) {
    await Deno.writeTextFile(page, "<!doctype html><title>myapp</title><p>hi");
  }
  let script = electronMainScriptUDS(
    real ? `file://${page}` : "http://127.0.0.1:1/",
    sockPath,
    {
      title: "myapp",
      ...(real
        ? {
          meta: {
            title: "myapp",
            width: 320,
            height: 240,
            profileName: `aio-test-hs-${crypto.randomUUID().slice(0, 8)}`,
          },
        }
        : {}),
    },
  );
  if (real) {
    // The page is the file above, not an app served over aio://.
    const anchor = "BASE_DIR && fs.existsSync(path.join(BASE_DIR, 'app.js'))";
    assert(script.includes(anchor), "the USE_PROTOCOL anchor moved");
    script = script.replace(anchor, "false") + REAL_TITLE_PROBE;
  }
  // A generated program that does not parse would exit before connecting;
  // say THAT, with the parser's message.
  try {
    new Function(script);
  } catch (e) {
    throw new Error(`the generated main.cjs does not parse — ${e}`);
  }
  await Deno.writeTextFile(join(dir, "main.cjs"), script);
  const realEnv = (): Record<string, string> => {
    const e: Record<string, string> = {
      ...Deno.env.toObject(),
      ...testDisplayEnv(),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "no-bus")}`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ...accountEnv(join(dir, "config")),
      ...env,
    };
    delete e.WAYLAND_DISPLAY; // the nested X display, never the real session
    return e;
  };
  const proc = real
    // The binary itself, not npm's shim: the pid killed is the window's.
    ? new Deno.Command(await realElectronBin(ELECTRON_BIN), {
      args: [join(dir, "main.cjs"), "--no-sandbox", "--disable-gpu"],
      env: realEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn()
    : new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--quiet", join(dir, "main.cjs")],
      cwd: dir,
      env: { AIO_STUB_DIR: dir, ...env },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  let out = "";
  const dec = new TextDecoder();
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const x of s) out += dec.decode(x);
  };
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  let exited = false;
  const status = proc.status.then((s) => {
    exited = true;
    return s;
  });
  const until = async (pred: () => boolean, what: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (exited || Date.now() > end) {
        throw new Error(`${what} — the main process said:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    await f({ out: () => out, accepted, until });
  } finally {
    // The real window's helpers go with it, by pid.
    const family = real ? await descendantPids(proc.pid) : [];
    try {
      proc.kill("SIGKILL");
    } catch { /* already gone */ }
    for (const pid of family) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch { /* aio-ok: went with its parent */ }
    }
    await status;
    await pumps;
    for (const c of conns) {
      try {
        c.close();
      } catch { /* already closed */ }
    }
    listener.close();
    await accepting;
    await localIdle();
    await dropTempDir(dir);
  }
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

Deno.test({
  name:
    "electron main: a server that does not answer is reported once, neutrally, and retried on the normal backoff",
  async fn() {
    // Three connections are accepted and told nothing; the fourth is greeted.
    await withSilentServer(3, {}, async ({ out, accepted, until }) => {
      await until(() => accepted.length >= 1, "the window never connected");
      // 5 s of silence later: said, shown, and retried.
      await until(
        () => out().includes("no answer from the server"),
        "a window nobody answered said nothing",
      );
      await until(
        () =>
          out().includes(
            "TITLE myapp — no answer from its server yet (reconnecting)",
          ),
        "the notice never reached the window's title",
      );
      await until(
        () => accepted.length >= 4,
        "the silent connections were not dropped and retried",
        60_000,
      );
      // The retry is greeted: the window is itself again.
      await until(
        () => /TITLE myapp\n/.test(out()),
        "the title was not restored once the server answered",
      );
      await until(
        () => out().includes("backend connection restored"),
        "the answer was not reported",
      );
      const said = out();
      // ONE warning for the whole outage — a busy server is the same line
      // three times over otherwise — and a warning, not an error: nothing
      // has failed yet.
      assertEquals(count(said, /no answer from the server/g), 1, said);
      assertMatch(said, /^WARN .*\[aio:electron\] connected to .* no answer/m);
      assertEquals(count(said, /^ERROR /gm), 0, said);
      // True in dev and prod alike: the lockdown is named as a POSSIBLE
      // cause in the log, and nowhere claimed as the cause.
      assertStringIncludes(said, "it is either busy");
      assertStringIncludes(said, "local-peer lockdown");
      assert(!/refused by its server/.test(said), said);
      // One outage, one report: lost once, restored once — not per attempt.
      assertEquals(count(said, /backend connection lost/g), 1, said);
      assertEquals(count(said, /backend connection restored/g), 1, said);
      // The normal backoff: each silent attempt waits LONGER before the
      // next (1 s, 2 s, 4 s, each ±20 %). A counter reset by the mere
      // connect retried every time after the first step.
      const gaps = accepted.slice(1).map((t, i) => t - accepted[i]!);
      assert(
        gaps[2]! - gaps[0]! > 1200,
        `the retry did not back off: ${
          gaps.map(Math.round)
        } ms between attempts`,
      );
    });
  },
});

Deno.test({
  name:
    "electron main: a title the page set while the notice was up is not overwritten when the server answers",
  async fn() {
    await withSilentServer(
      1,
      { AIO_STUB_PAGE_TITLE: "1" },
      async ({ out, until }) => {
        await until(() => out().includes("PAGE-TITLE"), "no notice was shown");
        await until(
          () => out().includes("backend connection restored"),
          "the server's answer was never seen",
        );
        // Give a wrong restore every chance to land.
        await new Promise((r) => setTimeout(r, 300));
        assertEquals(
          count(out(), /^TITLE /gm),
          1,
          `the page's title was overwritten:\n${out()}`,
        );
      },
    );
  },
});

// ── The same script in the REAL Electron ────────────────────────────────────
// Opt in with ELECTRON_E2E=1 (`deno task test:electron`); the window opens on
// the nested test display.

Deno.test({
  name:
    "electron (real): a server that does not answer is said in the real window's title, retried, and the title is taken back",
  ignore: realSkip() !== null,
  // aio-ok: a real Electron binary; its pipes outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  async fn() {
    await withSilentServer(1, {}, async ({ out, accepted, until }) => {
      await until(() => accepted.length >= 1, "the window never connected");
      await until(
        () => /^TITLE myapp$/m.test(out()),
        "the page's title never became the window's",
      );
      await until(
        () =>
          out().includes(
            "TITLE myapp — no answer from its server yet (reconnecting)",
          ),
        "the notice never reached the real window's title",
      );
      assertStringIncludes(out(), "no answer from the server in 5s");
      // The watch waited its window: not a notice on the first slow frame.
      await until(() => accepted.length >= 2, "the connection was not retried");
      assert(
        accepted[1]! - accepted[0]! >= 5000,
        `dropped after ${Math.round(accepted[1]! - accepted[0]!)} ms`,
      );
      await until(
        () => out().includes("backend connection restored"),
        "the answer was not reported",
      );
      await until(
        () =>
          /TITLE myapp — no answer[^\n]*\n(?:.*\n)*?TITLE myapp\n/.test(out()),
        "the real window's title was not restored once the server answered",
      );
      assertEquals(count(out(), /no answer from the server/g), 1, out());
    }, true);
  },
});

Deno.test({
  name:
    "electron (real): a document.title the page set while the notice was up stays when the server answers",
  ignore: realSkip() !== null,
  // aio-ok: a real Electron binary; its pipes outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  async fn() {
    await withSilentServer(
      1,
      { AIO_STUB_PAGE_TITLE: "1" },
      async ({ out, until }) => {
        await until(
          () => out().includes("PAGE-TITLE\n"),
          "no notice was shown",
        );
        await until(
          () => out().includes("TITLE set by the page"),
          "the page's title never reached the real window",
        );
        await until(
          () => out().includes("backend connection restored"),
          "the server's answer was never seen",
        );
        // Give a wrong restore every chance to land (the probe reads the
        // title every 25 ms).
        await new Promise((r) => setTimeout(r, 300));
        assertMatch(
          out(),
          /TITLE set by the page\n(?![^]*TITLE )/,
          `the page's title was overwritten:\n${out()}`,
        );
      },
      true,
    );
  },
});
