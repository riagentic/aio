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
// evaluated, never string-matched.
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

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
  },
  BrowserWindow,
  Menu: { setApplicationMenu() {} },
  ipcMain: { on() {}, handle() {} },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  shell: { openExternal() {} },
  dialog: {},
  nativeImage: { createFromDataURL: () => ({}) },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onHeadersReceived() {} } } },
};
`;

/** Run the generated main against a server that stays silent on its first
 *  `silent` connections and greets every later one. */
async function withSilentServer(
  silent: number,
  env: Record<string, string>,
  f: (h: {
    out: () => string;
    /** When each connection was accepted (ms). */
    accepted: number[];
    until: (pred: () => boolean, what: string, ms?: number) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await tempDir("el-handshake-");
  const sockPath = join(dir, "app.sock");
  const listener = Deno.listen({ transport: "unix", path: sockPath });
  const conns: Deno.Conn[] = [];
  const accepted: number[] = [];
  (async () => {
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
  const script = electronMainScriptUDS("http://127.0.0.1:1/", sockPath, {
    title: "myapp",
  });
  // A generated program that does not parse would exit before connecting;
  // say THAT, with the parser's message.
  try {
    new Function(script);
  } catch (e) {
    throw new Error(`the generated main.cjs does not parse — ${e}`);
  }
  await Deno.writeTextFile(join(dir, "main.cjs"), script);
  const proc = new Deno.Command(Deno.execPath(), {
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
    try {
      proc.kill("SIGKILL");
    } catch { /* already gone */ }
    await status;
    await pumps;
    for (const c of conns) {
      try {
        c.close();
      } catch { /* already closed */ }
    }
    listener.close();
    await dropTempDir(dir);
  }
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

Deno.test({
  name:
    "electron main: a server that does not answer is reported once, neutrally, and retried on the normal backoff",
  ignore: Deno.build.os === "windows", // a unix socket + Deno's node-compat
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
  ignore: Deno.build.os === "windows",
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
