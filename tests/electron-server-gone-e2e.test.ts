// REAL Electron: a window does not outlive its server, whatever its page says.
//
// Measured before the fix (Electron 44.4.1, Linux and macOS, both shells,
// tray on and off): a page with a cancelling `beforeunload` handler —
//
//   addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "x"; })
//
// — kept its window through every exit the SERVER causes. The parent watch
// called `app.quit()` once: before-quit, close, will-prevent-unload, and the
// window stayed. A SIGTERM (what the server's own shutdown sends) took the
// same path through Chromium's handler. The server gone, the window and its
// helpers alive for good — 8 of 9 processes — and nothing retried.
//
// Three rows — every exit the APP decides, none of them the page's to refuse:
//   • the server process dies (SIGKILL — the watch on AIO_PARENT_PID),
//   • the server stops and signals the window (SIGTERM),
//   • the window's own main process throws (the crash guard's quit).
// Each: every process of the window is gone, inside the bound the watch gives
// (2 s poll + 3 s backstop).
//
// Same gate as tests/electron-second-launch-show-e2e.test.ts: opt in with
// ELECTRON_E2E=1, needs node_modules/.bin/electron and a display (the nested
// one — no window lands on your desktop).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { realElectronBin } from "../src/electron/electron-spawn.ts";
import { LEAVE_BACKSTOP_MS } from "../src/electron/electron-shared.ts";
import { descendantPids } from "../src/server/single-instance-lock.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";

function shouldSkip(): string | null {
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

const alive = (pid: number): boolean => {
  try {
    Deno.kill(pid, "SIGCONT"); // harmless to a running process
    // A zombie still takes a signal; it is not a running process.
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !==
      "Z";
  } catch {
    return false; // aio-ok: gone is the answer
  }
};

/** Evaluate `expression` in the page as a user gesture would (a
 *  `beforeunload` veto counts only on a page the user has touched). */
async function evalInPage(port: number, expression: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let url: string | undefined;
  while (Date.now() < deadline && !url) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`))
        .json() as { type: string; webSocketDebuggerUrl: string }[];
      url = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch { /* aio-ok: not up yet */ }
  }
  if (!url) throw new Error("no CDP page target — Electron failed to start");
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = rej;
  });
  const done = new Promise<void>((res) => ws.onmessage = () => res());
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, userGesture: true, returnByValue: true },
  }));
  await done;
  ws.close();
}

/** Start a window whose page cancels `beforeunload`, end its server with
 *  `end`, and answer which of the window's processes are STILL ALIVE once
 *  the bound has passed (none, when the window followed its server). */
async function survivorsAfter(
  end: (
    w: { window: number; server: Deno.ChildProcess },
  ) => void | Promise<unknown>,
): Promise<number[]> {
  const dir = await tempDir("el-gone-");
  const title = `aio-gone-${crypto.randomUUID().slice(0, 8)}`;
  const page = join(dir, "index.html");
  await Deno.writeTextFile(
    page,
    `<!doctype html><title>${title}</title><p>hi</p>`,
  );
  let main = electronMainScriptUDS(`file://${page}`, join(dir, "no.sock"), {
    title,
    meta: { title, width: 320, height: 240, profileName: `aio-test-${title}` },
  });
  const anchor = "BASE_DIR && fs.existsSync(path.join(BASE_DIR, 'app.js'))";
  assert(main.includes(anchor), "the USE_PROTOCOL anchor moved");
  main = main.replace(anchor, "false");
  // The test's own handle on "the main process throws": an uncaught
  // exception on SIGUSR2 (taken after ready, like the shell's own signals).
  main += `\napp.on('ready', () => process.on('SIGUSR2', () => ` +
    `setImmediate(() => { throw new Error('thrown by the test'); })));\n`;
  const mainFile = join(dir, "main.cjs");
  await Deno.writeTextFile(mainFile, main);
  // The stand-in for the aio server: the pid the window must not outlive.
  const server = new Deno.Command("sleep", { args: ["600"] }).spawn();
  const port = freePort();
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    ...testDisplayEnv(),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "no-bus")}`,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    XDG_CONFIG_HOME: join(dir, "config"),
    AIO_PARENT_PID: String(server.pid),
  };
  delete env.WAYLAND_DISPLAY;
  // The binary itself, not npm's shim: the pid signalled is the window's.
  const proc = new Deno.Command(await realElectronBin(ELECTRON_BIN), {
    args: [
      mainFile,
      `--remote-debugging-port=${port}`,
      "--no-sandbox",
      "--disable-gpu",
    ],
    env,
    stdout: "null",
    stderr: "null",
  }).spawn();
  let family: number[] = [];
  try {
    await evalInPage(
      port,
      `addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = "x"; }); 1`,
    );
    family = [proc.pid, ...await descendantPids(proc.pid)];
    assert(family.length > 1, "the window has no helper processes yet");
    const t0 = Date.now();
    await end({ window: proc.pid, server });
    // The bound: one poll of the watch, the backstop, and room for a loaded
    // machine. Before the fix this never came true.
    const bound = 2000 + LEAVE_BACKSTOP_MS + 10_000;
    while (family.some(alive) && Date.now() - t0 < bound) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return family.filter(alive);
  } finally {
    for (const pid of [proc.pid, ...family]) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch { /* aio-ok: already gone — the passing case */ }
    }
    try {
      server.kill("SIGKILL");
    } catch { /* aio-ok: the row killed it */ }
    await server.status;
    await proc.status;
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "electron: a page that cancels beforeunload does not keep the window when the server is KILLED",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; its sockets outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const left = await survivorsAfter(({ server }) => {
      server.kill("SIGKILL");
      return server.status; // reaped: a zombie still answers a signal 0
    });
    assertEquals(left, [], "processes of the window outlived its server");
  },
});

Deno.test({
  name:
    "electron: a page that cancels beforeunload does not keep the window when the server STOPS it (SIGTERM)",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; its sockets outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const left = await survivorsAfter(({ window }) =>
      Deno.kill(window, "SIGTERM")
    );
    assertEquals(left, [], "processes of the window outlived its stop");
  },
});

Deno.test({
  name:
    "electron: a page that cancels beforeunload does not keep a window whose MAIN PROCESS crashed",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; its sockets outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    // Measured before: the crash guard's plain quit was cancelled by the
    // page, and the window stayed up on a main process that had thrown.
    const left = await survivorsAfter(({ window }) =>
      Deno.kill(window, "SIGUSR2")
    );
    assertEquals(left, [], "a crashed window was kept by its page");
  },
});
