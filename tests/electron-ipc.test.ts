// Real Electron E2E test: proves that state arrives in the renderer (not "Loading...")
// via the UDS → Electron main → IPC → browser.ts __aio:ready handshake.
//
// Regression: v0.9.4 used did-finish-load + 50ms timeout before sending state via IPC.
// The timeout fired before browser.ts registered its ipcRenderer.on('__aio:msg') listener
// → state dropped → renderer stuck on "Loading..." forever.
//
// Fix (v0.9.5): _connectIPC() calls _ipc.ready() after registering all listeners.
// Electron main only sends state in response to __aio:ready — guaranteed after listeners exist.
//
// Requires: Electron installed at node_modules/.bin/electron + a display (DISPLAY or WAYLAND_DISPLAY)

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server.ts";
import { electronMainScriptUDS } from "../src/electron.ts";
import { createUDSListener } from "../src/aio.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";
const DEV_PORT = 19950;
const CDP_PORT = 19951;

// App that takes >100ms to "load" by busy-waiting before calling useAio.
// This forces did-finish-load to fire well before IPC listeners are registered,
// creating the exact race the __aio:ready handshake was built to solve.
const APP_TSX = `
import { useAio } from 'aio'

// Simulate slow module loading: busy-wait 300ms so the Electron main
// did-finish-load+50ms timeout definitely expires before IPC listeners register
const _t = Date.now(); while (Date.now() - _t < 300) { /* busy wait */ }

export default function App() {
  const { state } = useAio()
  if (!state) return <div id="aio-status">Loading</div>
  return <div id="aio-status">ready:{state.count}</div>
}
`.trim();

// ── helpers ──────────────────────────────────────────────────────────

function shouldSkip(): string | null {
  try {
    Deno.statSync(ELECTRON_BIN);
  } catch {
    return "Electron not installed — run: deno task install:electron";
  }
  if (!Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY")) {
    return "no display (set DISPLAY or WAYLAND_DISPLAY)";
  }
  // This E2E test requires the full dev server build pipeline (esbuild + JSX transform).
  // Skip if explicitly not requested — run with ELECTRON_E2E=1 to enable.
  if (!Deno.env.get("ELECTRON_E2E")) {
    return "E2E disabled — set ELECTRON_E2E=1 to run";
  }
  return null;
}

type CdpTarget = { type: string; webSocketDebuggerUrl: string };

async function waitForCdpPage(
  port: number,
  timeoutMs = 15_000,
): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await fetch(`http://localhost:${port}/json`);
      const targets = await r.json() as CdpTarget[];
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* Electron not ready yet */ }
  }
  throw new Error(
    `CDP page target not found after ${timeoutMs}ms — Electron failed to start`,
  );
}

async function cdpSession(
  wsUrl: string,
): Promise<{ eval: (expr: string) => Promise<string>; close: () => void }> {
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map<number, (v: string) => void>();
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data as string) as {
      id: number;
      result?: { result?: { value?: string } };
    };
    pending.get(data.id)?.(data.result?.result?.value ?? "");
    pending.delete(data.id);
  };
  return {
    eval: (expr) =>
      new Promise((resolve) => {
        const id = ++msgId;
        pending.set(id, resolve);
        ws.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression: expr, returnByValue: true },
          }),
        );
      }),
    close: () => ws.close(),
  };
}

async function pollDom(
  cdp: Awaited<ReturnType<typeof cdpSession>>,
  selector: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let val = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    val = await cdp.eval(
      `document.getElementById('${selector}')?.textContent ?? ''`,
    );
    if (val && val !== "Loading") break;
  }
  return val;
}

async function launchElectron(
  mainFile: string,
  cdpPort: number,
): Promise<Deno.ChildProcess> {
  return new Deno.Command(ELECTRON_BIN, {
    args: [
      mainFile,
      `--remote-debugging-port=${cdpPort}`,
      "--no-sandbox",
      "--disable-gpu",
    ],
    stdout: "null",
    stderr: "null",
    env: { ...Deno.env.toObject(), ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  }).spawn();
}

// ── tests ─────────────────────────────────────────────────────────────

// Run both tests sequentially in one Deno.test to share the dev server
// (esbuild child process) and avoid port conflicts.
Deno.test({
  name:
    "electron: IPC ready handshake — state arrives in renderer after 300ms module load",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const skip = shouldSkip();
    if (skip) {
      console.log(`  (skipped — ${skip})`);
      return;
    }

    const dir = await Deno.makeTempDir();
    const socketPath = join(dir, "test.sock");
    let proc: Deno.ChildProcess | null = null;

    const server = createServer({
      port: DEV_PORT,
      title: "IPC Test",
      getUIState: () => ({ count: 42 }),
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: false,
    });
    const uds = createUDSListener(
      socketPath,
      () => ({ count: 42 }),
      () => {},
      () => {},
    );

    try {
      await Deno.writeTextFile(join(dir, "App.tsx"), APP_TSX);

      // ── Part 1: broken version (timeout, not handshake) ──────────────────
      // Generate main script with the OLD broken behavior: did-finish-load + 1ms timeout.
      // The App.tsx busy-waits 300ms, so the 1ms timeout fires long before IPC listeners register.
      // State should NOT arrive → DOM stays "Loading".
      const brokenScript = electronMainScriptUDS(
        `http://localhost:${DEV_PORT}`,
        socketPath,
        { title: "IPC Test" },
      )
        .replace(
          // Inject broken behavior: replace __aio:ready handler with a 1ms did-finish-load timeout
          `  // Track page readiness (data events need this to decide whether to forward or buffer)
  win.webContents.on('did-start-navigation', () => { pageReady = false; }); // AIO-247: reset on F5/Ctrl+R
  win.webContents.on('did-finish-load', () => { pageReady = true; });

  // Renderer signals it has registered IPC listeners — request fresh state from server
  ipcMain.on('__aio:ready', () => {
    if (closing) return;
    if (sock) {
      win.webContents.send('__aio:open');
      // Request fresh full state from server via subscribe-all.
      // This replaces relying on lastFullState which may be stale (captured on
      // initial UDS connect before async feature initialization completed, and
      // never updated because all subsequent states are $f-tagged or $p deltas).
      // The server responds with current complete state — no $f because * = unfiltered.
      sock.write('__subs:["*"]\\n');
      // AIO-259: replay only when connected — without __aio:open the renderer
      // would show stale data with no active connection for actions/updates
      if (lastFullState) {
        win.webContents.send('__aio:msg', lastFullState);
      }
    }
  });`,
          `  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      pageReady = true;
      if (closing) return;
      if (sock) win.webContents.send('__aio:open');
      if (lastState) win.webContents.send('__aio:msg', lastState);
    }, 1);  // 1ms — fires before 300ms busy-wait completes
  });`,
        );
      const brokenFile = join(dir, "main-broken.cjs");
      await Deno.writeTextFile(brokenFile, brokenScript);

      proc = await launchElectron(brokenFile, CDP_PORT);
      const target1 = await waitForCdpPage(CDP_PORT);
      const cdp1 = await cdpSession(target1.webSocketDebuggerUrl);
      const statusBroken = await pollDom(cdp1, "aio-status", 5_000);
      cdp1.close();
      proc.kill();
      proc = null;
      await new Promise((r) => setTimeout(r, 300)); // let Electron exit + port free

      assertEquals(
        statusBroken === "Loading" || statusBroken === "",
        true,
        `Broken version unexpectedly showed "${statusBroken}" — test is not simulating the race correctly`,
      );

      // ── Part 2: fixed version (__aio:ready handshake) ────────────────────
      // The fixed script waits for __aio:ready before sending state.
      // Even with a 300ms module load delay, state must arrive after the handshake.
      const fixedFile = join(dir, "main-fixed.cjs");
      await Deno.writeTextFile(
        fixedFile,
        electronMainScriptUDS(`http://localhost:${DEV_PORT}`, socketPath, {
          title: "IPC Test",
        }),
      );

      proc = await launchElectron(fixedFile, CDP_PORT);
      const target2 = await waitForCdpPage(CDP_PORT);
      const cdp2 = await cdpSession(target2.webSocketDebuggerUrl);
      const statusFixed = await pollDom(cdp2, "aio-status", 8_000);
      cdp2.close();

      assertEquals(
        statusFixed,
        "ready:42",
        `Fixed version shows "${statusFixed}" after 8s — state did not arrive via __aio:ready handshake.\n` +
          `UDS→Electron IPC→renderer chain is broken.`,
      );
    } finally {
      try {
        proc?.kill();
      } catch { /* already gone */ }
      await server.shutdown().catch(() => {});
      try {
        uds.shutdown();
      } catch { /* already stopped */ }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
