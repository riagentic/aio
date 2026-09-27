// REAL Electron, real link click: a same-app link whose PATH starts with "//"
// (`http://host//evil.example/x`) is an in-app route — never a trip to
// evil.example. The relay used to rebuild the route from the path alone, and
// `//evil.example/x` read as a scheme-relative URL is another site.
//
// (Helpers below are the same harness as electron-route-change-e2e.test.ts.)
//
// report 9 §5.3, ask 1, verbatim: "Test the relay against real Electron, not only
// the stub. One end-to-end case — launch a window, click an in-app link, assert
// a broadcast arrives — would have caught both §5.1 and its non-working fix.
// The stub suite is valuable; it is not evidence about Electron."
//
// It was not. The first fix guarded `did-start-navigation` on isSameDocument
// and the stub agreed; real Electron emits that event BEFORE will-navigate, as
// a cross-document navigation, and never follows a veto with did-fail-load.
// Measured, then fixed at the veto. This is the test that makes the stub
// answerable to the shell it stands in for.
//
// Same gate and harness shape as tests/electron-ipc.test.ts: opt in with
// ELECTRON_E2E=1, needs node_modules/.bin/electron and a display (a nested
// Xephyr on :77 is started for it, so no window lands on your desktop).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";
const DEV_PORT = freePort();
const CDP_PORT = freePort();

const APP_TSX = (origin: string) =>
  `
import { useAio } from 'aio'
export default function App() {
  const { state } = useAio()
  return <div>
    <a id="dbl" href="${origin}//evil.example/x">odd path</a>
    <a id="ext" href="https://ext.example/y">external</a>
    <div id="v">{state ? 'v:' + state.n : 'Loading'}</div>
  </div>
}
`.trim();

function shouldSkip(): string | null {
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

async function waitForCdpPage(port: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const targets = await (await fetch(`http://localhost:${port}/json`))
        .json() as CdpTarget[];
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not up yet */ }
  }
  throw new Error(`no CDP page target after ${timeoutMs}ms`);
}

async function cdpSession(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
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
          params: { expression, returnByValue: true, awaitPromise: true },
        }));
      }),
    close: () => ws.close(),
  };
}

async function pollUntil(
  cdp: Awaited<ReturnType<typeof cdpSession>>,
  expr: string,
  want: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let got: unknown;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    got = await cdp.eval(expr);
    if (got === want) return got;
  }
  return got;
}

Deno.test({
  name:
    "electron e2e: a same-app link to //host/x routes in-app, never to that host",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron child and its CDP socket outlive the test boundary
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const dir = await tempDir("aio-route-dbl-");
    const socketPath = join(dir, "app.sock");
    const state = { n: 1 };
    const origin = `http://localhost:${DEV_PORT}`;
    // The system browser, stood in for: every URL the shell hands to
    // `xdg-open` lands in this file instead of a real browser.
    const bin = join(dir, "bin");
    const opened = join(dir, "opened.txt");
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      join(bin, "xdg-open"),
      `#!/bin/sh\necho "$1" >> '${opened}'\n`,
    );
    await Deno.chmod(join(bin, "xdg-open"), 0o755);
    const server = createServer({
      port: DEV_PORT,
      title: "Route dbl",
      getUIState: () => state,
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: false,
    });
    const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
    let proc: Deno.ChildProcess | null = null;
    try {
      await Deno.writeTextFile(join(dir, "App.tsx"), APP_TSX(origin));
      const mainFile = join(dir, "main.cjs");
      await Deno.writeTextFile(
        mainFile,
        electronMainScriptUDS(origin, socketPath, { title: "Route dbl" }),
      );
      proc = new Deno.Command(ELECTRON_BIN, {
        args: [
          mainFile,
          `--remote-debugging-port=${CDP_PORT}`,
          "--no-sandbox",
          "--disable-gpu",
        ],
        stdout: "null",
        stderr: "null",
        env: {
          ...Deno.env.toObject(),
          ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
          ...testDisplayEnv(),
          PATH: `${bin}:${Deno.env.get("PATH")}`,
        },
      }).spawn();
      const cdp = await cdpSession(
        (await waitForCdpPage(CDP_PORT)).webSocketDebuggerUrl,
      );
      const openedUrls = async () =>
        (await Deno.readTextFile(opened).catch(() => "")).trim();
      try {
        assertEquals(
          await pollUntil(
            cdp,
            "document.getElementById('v')?.textContent",
            "v:1",
            15_000,
          ),
          "v:1",
        );
        await cdp.eval("window.__doc = 'first'; 'ok'");
        // The instrument: a real external link DOES reach the stand-in.
        await cdp.eval("document.getElementById('ext').click(); 'ok'");
        const deadline = Date.now() + 5_000;
        while (!(await openedUrls()) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        assertEquals(await openedUrls(), "https://ext.example/y");

        await cdp.eval("document.getElementById('dbl').click(); 'ok'");
        await new Promise((r) => setTimeout(r, 1500));
        assertEquals(
          await openedUrls(),
          "https://ext.example/y",
          "the same-app link was sent to another site",
        );
        assertEquals(
          await cdp.eval("location.origin + location.pathname"),
          `${origin}//evil.example/x`,
          "the link must have been routed in-app, at its own path",
        );
        assertEquals(await cdp.eval("window.__doc"), "first");
      } finally {
        cdp.close();
      }
    } finally {
      try {
        proc?.kill();
      } catch { /* aio-ok: already gone */ }
      await server.shutdown().catch(() => {});
      try {
        uds.shutdown();
      } catch { /* aio-ok: already stopped */ }
      await dropTempDir(dir);
    }
  },
});
