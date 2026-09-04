// REAL Electron, the PACKAGED path (aio://app/ off disk), a real UDS server:
// after the window reloads, does the new document get the connection's `cfg`?
//
// The server writes `proto` and `cfg` once per CONNECTION, at accept. The
// connection belongs to the Electron main process and outlives every
// document, so a reload — Ctrl+R, Ctrl+Shift+Del, the app's own
// location.reload() — never reaches the server as a new connection, and the
// relay handed the fresh document the last snapshot and nothing else. On the
// packaged shell `cfg` is the only carrier of `syncCells` (localFirst
// adoption), `callTimeouts` and `renderBudget` — udsProdHTML embeds none of
// them — so one Ctrl+R silently turned every localFirst cell back into a
// round-trip and every awaited call onto the default ceiling. Dev never
// showed it: its shell embeds the same keys. tests/electron-main-relay
// replays this against the stub; this is the same fact on the real shell,
// with a bundle that records exactly what reaches the page.
//
// Same gate and harness shape as tests/electron-route-change-e2e.test.ts:
// opt in with ELECTRON_E2E=1, needs node_modules/.bin/electron and a display.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";
const CDP_PORT = freePort();

// The "bundle": what a renderer does at the transport layer and nothing
// else — register the bridge listeners, record every frame, announce ready.
const APP_JS = `
export function mount(root) {
  root.innerHTML = '<p id="v">probe</p>';
  window.__frames = [];
  window.__aioIPC.onMessage((l) => window.__frames.push(l));
  window.__aioIPC.ready();
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

/** The kinds the CURRENT document has received, once it holds every one of
 *  `want` or the deadline passes. */
async function kindsSeen(
  cdp: Awaited<ReturnType<typeof cdpSession>>,
  want: string[],
  timeoutMs: number,
): Promise<string[]> {
  const expr =
    "(window.__frames || []).map((l) => { try { return JSON.parse(l).t } catch { return '?' } })";
  const deadline = Date.now() + timeoutMs;
  let got: string[] = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    got = (await cdp.eval(expr) as string[] | undefined) ?? [];
    if (want.every((k) => got.includes(k))) return got;
  }
  return got;
}

Deno.test({
  name:
    "electron e2e: a reload of the packaged window hands the new document proto and cfg again",
  ignore: shouldSkip() !== null,
  // A real Electron binary driven over CDP: the Chromium child and its CDP
  // aio-ok: socket outlive the test boundary, so the sanitizers cannot own them
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const dir = await tempDir("aio-reload-cfg-e2e-");
    const dist = join(dir, "dist");
    const socketPath = join(dir, "app.sock");
    const state = { n: 1 };
    const uds = createUDSListener(
      socketPath,
      () => state,
      () => {},
      () => {},
      undefined,
      null,
      // What aio-server.ts sends: the compose-time config the packaged shell
      // cannot embed.
      { callTimeouts: { default: 15000 }, syncCells: ["todos"] },
    );
    let proc: Deno.ChildProcess | null = null;
    const stderr: string[] = [];
    try {
      await Deno.mkdir(dist);
      await Deno.writeTextFile(join(dist, "app.js"), APP_JS);
      const main = electronMainScriptUDS("http://127.0.0.1:1/", socketPath, {
        title: "Reload Cfg E2E",
        baseDir: dist, // FROM_DISK — the packaged path
      });
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
        // ── the first document: the accept-time frames, in accept order ──
        // (The server answers the renderer's `subs` with a second snapshot
        // — the same bytes — so the list is a prefix match, not an equality.)
        const first = await kindsSeen(cdp, ["proto", "cfg", "state"], 15_000);
        assertEquals(
          first.filter((k) => k !== "tt-state").slice(0, 3),
          ["proto", "cfg", "state"],
          `the first document must get proto, cfg, state first (got ${
            JSON.stringify(first)
          }). Shell stderr:\n${stderr.join("")}`,
        );
        await cdp.eval("window.__doc = 'first'; 'ok'");

        // ── Ctrl+R ───────────────────────────────────────────────────────
        await cdp.eval("location.reload(); 'ok'");
        await new Promise((r) => setTimeout(r, 1500));
        assertEquals(
          await cdp.eval("window.__doc === undefined"),
          true,
          "location.reload() must have loaded a NEW document",
        );

        // ── the new document: the connection's hello and config, again ──
        const second = await kindsSeen(cdp, ["proto", "cfg", "state"], 8_000);
        assert(
          second.includes("state"),
          `the reloaded document never got a snapshot — the harness itself is broken (got ${
            JSON.stringify(second)
          }). Shell stderr:\n${stderr.join("")}`,
        );
        assert(
          second.includes("cfg") && second.includes("proto"),
          `after a reload the packaged page received ${
            JSON.stringify(second)
          } — no cfg, so it has no syncCells/callTimeouts/renderBudget: every ` +
            `localFirst cell round-trips and every call runs on the default ` +
            `ceiling. Shell stderr:\n${stderr.join("")}`,
        );
        assert(
          second.indexOf("proto") < second.indexOf("cfg") &&
            second.indexOf("cfg") < second.indexOf("state"),
          `accept order on the new document too — got ${
            JSON.stringify(second)
          }`,
        );
        // The frames are the SERVER's, not an invention of the relay.
        const cfgLine = await cdp.eval(
          '(window.__frames || []).find((l) => l.includes(\'"t":"cfg"\'))',
        ) as string;
        assertEquals(JSON.parse(cfgLine).d, {
          callTimeouts: { default: 15000 },
          syncCells: ["todos"],
        });
      } finally {
        cdp.close();
      }
    } finally {
      try {
        proc?.kill();
      } catch { /* aio-ok: already gone */ }
      try {
        uds.shutdown();
      } catch { /* aio-ok: already stopped */ }
      await dropTempDir(dir);
    }
  },
});
