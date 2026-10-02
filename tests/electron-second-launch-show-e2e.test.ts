// REAL Electron: a second launch brings the running window back, and a
// close-to-tray window on a desktop with no tray host is minimized, not lost.
//
// Measured before the fix (Electron 44, nested display, no session bus): a
// `ui.tray: { closeToTray: true }` window closed → hidden, `new Tray()` threw
// nothing, no icon anywhere — and launching the app again only logged
// "already running" and exited 1. The window was gone until a kill.
//
// Two rows, one shell:
//   • a tray host present (a `dbus-send` stub answering "boolean true") →
//     close hides; the second launch's request (`askRunningToShow`, the very
//     function the refused boot calls) is taken and the window is visible;
//   • no session bus at all → close MINIMIZES (the window stays mapped — the
//     nested display has no window manager to iconify it) and says why once.
//
// And a third, on the same shell: a renderer that DIES (SIGKILL — what the OOM
// killer does) used to leave a dead window for good while the server read
// "healthy"; the window now reloads itself.
//
// Same gate and harness shape as tests/ui-chrome-electron-e2e.test.ts: opt in
// with ELECTRON_E2E=1, needs node_modules/.bin/electron and a display (the
// nested Xephyr — no window lands on your desktop; the session bus is never
// the real one, so no tray icon lands in your panel either).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { askRunningToShow } from "../src/server/aio-run-helpers.ts";
import { descendantPids } from "../src/server/single-instance-lock.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";

function shouldSkip(): string | null {
  if (Deno.build.os !== "linux") return "linux (nested X display, sh stub)";
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

type CdpTarget = { type: string; webSocketDebuggerUrl: string };

async function cdp(port: number) {
  const deadline = Date.now() + 20_000;
  let page: CdpTarget | undefined;
  while (Date.now() < deadline && !page) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`))
        .json() as CdpTarget[];
      page = targets.find((t) => t.type === "page");
    } catch { /* aio-ok: not up yet */ }
  }
  if (!page) throw new Error("no CDP page target — Electron failed to start");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = rej;
  });
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data as string) as {
      id: number;
      result?: { result?: { value?: unknown } };
    };
    pending.get(d.id)?.(d.result?.result?.value);
    pending.delete(d.id);
  };
  return {
    eval: (expression: string) =>
      new Promise<unknown>((res) => {
        const n = ++id;
        pending.set(n, res);
        ws.send(JSON.stringify({
          id: n,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }));
      }),
    close: () => ws.close(),
  };
}

/** The X map state of the window titled `title` on `display`. */
function mapState(display: Record<string, string>, title: string): string {
  const out = new TextDecoder().decode(
    new Deno.Command("xwininfo", {
      args: ["-display", display.DISPLAY ?? "", "-name", title],
      env: display,
      stdout: "piped",
      stderr: "null",
    }).outputSync().stdout,
  );
  return /Map State: (\w+)/.exec(out)?.[1] ?? "none";
}

async function until(
  what: string,
  f: () => Promise<boolean> | boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function withWindow(
  trayHost: boolean,
  fn: (w: {
    session: Awaited<ReturnType<typeof cdp>>;
    showFile: string;
    title: string;
    display: Record<string, string>;
    log: () => string;
    pid: number;
    port: number;
  }) => Promise<void>,
  body?: string,
) {
  const dir = await tempDir("el-show-");
  const title = `aio-show-${crypto.randomUUID().slice(0, 8)}`;
  const page = join(dir, "index.html");
  // Mounted (`#root` has a child) — the window answers a show request only
  // then. `body`: a page that mounts later, when the test says so.
  await Deno.writeTextFile(
    page,
    `<!doctype html><title>${title}</title>${
      body ?? `<div id="root"><p>hi</p></div>`
    }`,
  );
  const showFile = join(dir, "app.show");
  let main = electronMainScriptUDS(`file://${page}`, join(dir, "no.sock"), {
    title,
    meta: {
      title,
      width: 320,
      height: 240,
      tray: { closeToTray: true },
      profileName: `aio-test-show-${title}`,
      showFile,
    },
  });
  const anchor = "BASE_DIR && fs.existsSync(path.join(BASE_DIR, 'app.js'))";
  assert(main.includes(anchor), "the USE_PROTOCOL anchor moved");
  main = main.replace(anchor, "false");
  const mainFile = join(dir, "main.cjs");
  await Deno.writeTextFile(mainFile, main);
  // The tray host is answered by a `dbus-send` stub on PATH — or there is no
  // bus at all. The real session bus is never used.
  const bin = join(dir, "bin");
  await Deno.mkdir(bin);
  if (trayHost) {
    await Deno.writeTextFile(
      join(bin, "dbus-send"),
      "#!/bin/sh\necho '   boolean true'\n",
    );
    await Deno.chmod(join(bin, "dbus-send"), 0o755);
  }
  const display = testDisplayEnv();
  const port = freePort();
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    ...display,
    PATH: `${bin}:${Deno.env.get("PATH")}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "no-bus")}`,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    XDG_CONFIG_HOME: join(dir, "config"),
  };
  delete env.WAYLAND_DISPLAY;
  const proc = new Deno.Command(ELECTRON_BIN, {
    args: [
      mainFile,
      `--remote-debugging-port=${port}`,
      "--no-sandbox",
      "--disable-gpu",
    ],
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let text = "";
  const dec = new TextDecoder();
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) text += dec.decode(c);
  };
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  let session: Awaited<ReturnType<typeof cdp>> | null = null;
  try {
    session = await cdp(port);
    await until(
      "the window to map",
      () => mapState(display, title) === "IsViewable",
    );
    // The tray-host probe is async; let it answer before the close.
    await new Promise((r) => setTimeout(r, 1000));
    await fn({
      session,
      showFile,
      title,
      display,
      log: () => text,
      pid: proc.pid,
      port,
    });
  } finally {
    session?.close();
    try {
      proc.kill("SIGTERM");
    } catch { /* aio-ok: already exited */ }
    await proc.status;
    await pumps;
    await dropTempDir(dir);
  }
}

Deno.test({
  name: "electron: a second launch shows a window hidden to the tray",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; its sockets outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: () =>
    withWindow(true, async ({ session, showFile, title, display, log }) => {
      await session.eval("window.__aioWindow.close()");
      await until(
        "the close to hide the window",
        () => mapState(display, title) === "IsUnMapped",
      );
      assertEquals(
        await session.eval("document.visibilityState"),
        "hidden",
      );
      assert(
        await askRunningToShow(showFile),
        `the running window never took the request:\n${log()}`,
      );
      await until(
        "the window to show again",
        () => mapState(display, title) === "IsViewable",
      );
      assertEquals(await session.eval("document.visibilityState"), "visible");
    }),
});

Deno.test({
  name:
    "electron: the page's own window.close() hides a close-to-tray window, it does not end the app",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; its sockets outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: () =>
    withWindow(true, async ({ session, showFile, title, display, log }) => {
      // Measured before the route existed (Electron 44, Linux and macOS):
      // window.close() destroyed the page, then the window, with no 'close'
      // event to turn into a hide — destroyed, closed, window-all-closed, and
      // the app was gone while its config said closeToTray.
      await session.eval("window.close()");
      await until(
        "window.close() to hide the window",
        () => mapState(display, title) === "IsUnMapped",
      );
      // Hidden, not gone: the page still answers, and comes back.
      assertEquals(await session.eval("document.body.innerText"), "hi");
      assert(
        await askRunningToShow(showFile),
        `the window did not survive window.close():\n${log()}`,
      );
      await until(
        "the window to show again",
        () => mapState(display, title) === "IsViewable",
      );
    }),
});

Deno.test({
  name: "electron: close-to-tray with no tray host minimizes and says so",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; its sockets outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: () =>
    withWindow(false, async ({ session, title, display, log }) => {
      await session.eval("window.__aioWindow.close()");
      await until("the no-tray-host line", () =>
        log().includes("no system tray host"));
      assertStringIncludes(log(), "minimized");
      // Minimized, not hidden: no window manager here to iconify it, so the
      // window stays mapped — a hide would have unmapped it.
      assertEquals(mapState(display, title), "IsViewable");
    }),
});

Deno.test({
  name: "electron: a renderer that dies is reloaded, not left as a dead window",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; its sockets outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: () =>
    withWindow(true, async ({ session, pid, port, log }) => {
      assertEquals(await session.eval("document.body.innerText"), "hi");
      await session.eval("document.body.innerText = 'dirty'");
      const renderers = async () => {
        const out: number[] = [];
        for (const p of await descendantPids(pid)) {
          try {
            const cmd = await Deno.readTextFile(`/proc/${p}/cmdline`);
            if (cmd.includes("--type=renderer")) out.push(p);
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
          }
        }
        return out;
      };
      const first = await renderers();
      assertEquals(first.length, 1, "exactly one renderer to kill");
      Deno.kill(first[0]!, "SIGKILL");
      await until("the renderer-gone line", () =>
        log().includes("renderer process gone"));
      // A reloaded page is the ORIGINAL document again, not the dirtied one.
      await until("the reloaded page", async () => {
        try {
          const s = await cdp(port);
          const t = await Promise.race([
            s.eval("document.body.innerText"),
            new Promise((r) =>
              setTimeout(() => r(null), 1000)
            ),
          ]);
          s.close();
          return t === "hi";
        } catch {
          return false; // aio-ok: the target is between documents
        }
      });
      assertStringIncludes(log(), "reloading the window");
      // A renderer that keeps dying is not reloaded in a loop: the 4th death
      // within a minute is said, and left.
      const gone = () => log().split("renderer process gone").length - 1;
      for (let n = 2; n <= 4; n++) {
        let victim: number | undefined;
        await until(`renderer ${n}`, async () => {
          victim = (await renderers())[0];
          return victim !== undefined;
        });
        Deno.kill(victim!, "SIGKILL");
        await until(`death ${n}`, () => gone() >= n);
      }
      await until("the crash-loop line", () =>
        log().includes("times in a minute — not reloading it again"));
      assertEquals(
        log().split("reloading the window after").length - 1,
        3,
        "reloaded 3 times, then left",
      );
    }),
});

Deno.test({
  name:
    "electron: a second launch's request is answered only once the page has MOUNTED — a window still loading does not take it",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; its sockets outlive the test body
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: () =>
    withWindow(false, async ({ session, showFile, log }) => {
      // The window is mapped, its page loaded — and not mounted yet.
      Deno.writeTextFileSync(showFile, String(Deno.pid));
      const taken = () => {
        try {
          Deno.statSync(showFile);
          return false;
        } catch {
          return true; // aio-ok: removed = taken
        }
      };
      // Bounded look, not a sleep-as-sync: a window that answers early does
      // so within its watch's first event.
      const until0 = Date.now() + 1500;
      while (Date.now() < until0 && !taken()) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(!taken(), `taken before the page mounted:\n${log()}`);
      await session.eval(
        "document.getElementById('root').appendChild(document.createElement('p'))",
      );
      await until("the request to be taken after the mount", taken);
    }, `<div id="root"></div>`),
});
