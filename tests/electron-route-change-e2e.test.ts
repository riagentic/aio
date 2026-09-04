// REAL Electron, real UDS server, real link click: does a broadcast still reach
// the renderer afterwards?
//
// cc §5.3, ask 1, verbatim: "Test the relay against real Electron, not only
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
import { assert, assertEquals } from "@std/assert";
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

// An app with an in-app link and a cell-driven readout. The readout is what
// proves a broadcast ARRIVED; the link is the click that used to kill it.
const APP_TSX = `
import { useAio } from 'aio'
export default function App() {
  const { state } = useAio()
  return <div>
    <a id="go" href="/settings">settings</a>
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
    "electron e2e: after a real in-app link click, a broadcast still reaches the renderer",
  ignore: shouldSkip() !== null,
  // A real Electron binary driven over CDP: the Chromium child, its CDP
  // socket, the UDS listener and the dev server's esbuild child all
  // aio-ok: outlive the test boundary, so the sanitizers cannot own them
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const dir = await tempDir("aio-route-e2e-");
    const socketPath = join(dir, "app.sock");
    const state = { n: 1 };
    const server = createServer({
      port: DEV_PORT,
      title: "Route E2E",
      getUIState: () => state,
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: false,
    });
    const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
    let proc: Deno.ChildProcess | null = null;
    const stderr: string[] = [];
    try {
      await Deno.writeTextFile(join(dir, "App.tsx"), APP_TSX);
      const main = electronMainScriptUDS(
        `http://localhost:${DEV_PORT}`,
        socketPath,
        { title: "Route E2E" },
      );
      const mainFile = join(dir, "main.cjs");
      await Deno.writeTextFile(mainFile, main);
      proc = new Deno.Command(ELECTRON_BIN, {
        args: [
          mainFile,
          `--remote-debugging-port=${CDP_PORT}`,
          "--no-sandbox",
          "--disable-gpu",
        ],
        stdout: "null",
        stderr: "piped",
        env: {
          ...Deno.env.toObject(),
          ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
          ...testDisplayEnv(),
        },
      }).spawn();
      (async () => {
        for await (
          const chunk of proc!.stderr.pipeThrough(new TextDecoderStream())
        ) stderr.push(chunk);
      })();
      const cdp = await cdpSession(
        (await waitForCdpPage(CDP_PORT)).webSocketDebuggerUrl,
      );
      try {
        // ── the baseline: state arrives on the first document ─────────────
        assertEquals(
          await pollUntil(
            cdp,
            "document.getElementById('v')?.textContent",
            "v:1",
            15_000,
          ),
          "v:1",
          "state never reached the first document — the harness itself is broken",
        );
        // Mark the document, so a full reload (which would ALSO "fix" the
        // downlink, and did — cc §5.3's root-path escape) cannot pass as an
        // in-app route change.
        await cdp.eval("window.__doc = 'first'; 'ok'");

        // ── the click ─────────────────────────────────────────────────────
        await cdp.eval("document.getElementById('go').click(); 'ok'");
        await new Promise((r) => setTimeout(r, 800));
        assertEquals(
          await cdp.eval("location.pathname"),
          "/settings",
          "the link must have been relayed in-app (the router moved the url)",
        );
        assertEquals(
          await cdp.eval("window.__doc"),
          "first",
          "the document must NOT have been replaced — that is a reload, not a route change",
        );

        // ── the broadcast — the thing that used to die here ───────────────
        state.n = 2;
        uds.broadcastState(true);
        const seen = await pollUntil(
          cdp,
          "document.getElementById('v')?.textContent",
          "v:2",
          6_000,
        );
        assertEquals(
          seen,
          "v:2",
          `after one in-app link click the renderer stopped receiving: the ` +
            `server pushed a full state and the page still shows ${
              JSON.stringify(seen)
            }. Shell stderr:\n${stderr.join("")}`,
        );
        assert(
          !stderr.join("").includes("has not signalled ready"),
          `the relay must not even have STALLED on the way: ${stderr.join("")}`,
        );

        // ── a reload on a non-root route must still be a reload ───────────
        // The old root-path exemption vetoed this — dev live-reload did
        // nothing off the home page. Measured: location.reload() reaches
        // will-navigate with the current url; the shell lets a same-url
        // navigation through.
        await cdp.eval("location.reload(); 'ok'");
        await new Promise((r) => setTimeout(r, 1500));
        assertEquals(
          await pollUntil(cdp, "window.__doc === undefined", true, 5_000),
          true,
          "location.reload() on /settings must load a NEW document",
        );
        state.n = 3;
        uds.broadcastState(true);
        assertEquals(
          await pollUntil(
            cdp,
            "document.getElementById('v')?.textContent",
            "v:3",
            15_000,
          ),
          "v:3",
          `state must reach the reloaded document too. Shell stderr:\n${
            stderr.join("")
          }`,
        );
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
