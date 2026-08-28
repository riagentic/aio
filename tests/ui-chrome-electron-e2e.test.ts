// Real Electron E2E for `ui.chrome`. The unit tests prove the shell EMITS a
// title bar and the main script sets `frame:false`; only a running window can
// prove the two halves meet — that the bar mounts, that its buttons reach the
// main process, and that a frameless window is still a window you can close.
//
// Requires Electron + a display; opt in with ELECTRON_E2E=1 (same gate as
// tests/electron-ipc.test.ts).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";

const ELECTRON_BIN = "node_modules/.bin/electron";
const CDP_PORT = freePort();

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

async function cdp(port: number) {
  const deadline = Date.now() + 20_000;
  let page: CdpTarget | undefined;
  while (Date.now() < deadline && !page) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const targets = await (await fetch(`http://localhost:${port}/json`))
        .json() as CdpTarget[];
      page = targets.find((t) => t.type === "page");
    } catch { /* not up yet */ }
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
          params: { expression, returnByValue: true, awaitPromise: true },
        }));
      }),
    close: () => ws.close(),
  };
}

Deno.test({
  name: "electron: a themed window is frameless AND still operable",
  ignore: shouldSkip() !== null,
  // aio-ok: a real Electron binary driven over CDP; the Chromium child and its CDP socket outlive the test
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const dir = await Deno.makeTempDir();
    // A standalone page — no server needed. What is under test is the WINDOW
    // and the bridge, so the shell fragment is inlined by hand from the same
    // generator the server uses.
    const { generateHTML } = await import("../src/server/server-html-gen.ts");
    const html = generateHTML({
      title: "Themed Demo",
      prod: true,
      hasCSS: false,
      importMap: "",
      chrome: "themed",
    }).replace(
      // The prod shell imports /app.js, which does not exist here.
      /<script type="module">[\s\S]*?<\/script>/,
      "",
    );
    const page = join(dir, "index.html");
    await Deno.writeTextFile(page, html);
    let main = electronMainScriptUDS(
      `file://${page}`,
      join(dir, "nope.sock"),
      {
        title: "Themed Demo",
        meta: { chrome: "themed", width: 640, height: 400 },
      },
    );
    // Load the local file instead of the (absent) aio:// bundle. Anchored on
    // the RHS so a rename of USE_PROTOCOL breaks loudly here rather than
    // producing a main.cjs that silently tests nothing.
    const anchor = "BASE_DIR && fs.existsSync(path.join(BASE_DIR, 'app.js'))";
    if (!main.includes(anchor)) {
      throw new Error(
        "electron e2e is inert: the USE_PROTOCOL anchor moved in " +
          "src/electron/electron-uds.ts — update it here",
      );
    }
    main = main.replace(anchor, "false");
    const mainFile = join(dir, "main.cjs");
    await Deno.writeTextFile(mainFile, main);

    const proc = new Deno.Command(ELECTRON_BIN, {
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
        // Nested display — this test maps a REAL window, and it must not be
        // on the desktop the person is working on.
        ...testDisplayEnv(),
      },
    }).spawn();
    let session: Awaited<ReturnType<typeof cdp>> | null = null;
    try {
      session = await cdp(CDP_PORT);
      // The bridge exists → the bar mounts. In a browser tab neither happens.
      const deadline = Date.now() + 10_000;
      let mounted: unknown = false;
      while (Date.now() < deadline && !mounted) {
        await new Promise((r) => setTimeout(r, 250));
        mounted = await session.eval(
          "!!document.querySelector('.aio-titlebar')",
        );
      }
      assertEquals(mounted, true, "the themed title bar never mounted");
      assertEquals(
        await session.eval("typeof window.__aioWindow.close"),
        "function",
        "the window-control bridge is missing",
      );
      assertEquals(
        await session.eval(
          "document.querySelector('.aio-titlebar-title').textContent",
        ),
        "Themed Demo",
        "the bar must show the app's title",
      );
      assertEquals(
        await session.eval(
          "document.querySelectorAll('.aio-titlebar-button').length",
        ),
        3,
        "minimise, maximise and close must all be there",
      );
      // The drag region is what makes a frameless window movable at all.
      assertEquals(
        await session.eval(
          "getComputedStyle(document.querySelector('.aio-titlebar'))" +
            ".webkitAppRegion",
        ),
        "drag",
      );
      // The app's content must not sit UNDER the bar.
      assert(
        Number(
          await session.eval(
            "parseFloat(getComputedStyle(document.body).paddingTop)",
          ),
        ) >= 30,
        "the page must be pushed below the title bar",
      );
      // And the close button must actually close the window — the one
      // regression that would leave a user with an app they cannot quit.
      await session.eval(
        "document.querySelector('[data-act=\"close\"]').click()",
      );
      const status = await Promise.race([
        proc.status,
        new Promise((r) => setTimeout(() => r(null), 8000)),
      ]);
      assert(status !== null, "clicking close did not close the window");
    } finally {
      session?.close();
      try {
        proc.kill();
      } catch { /* already gone */ }
      await proc.status.catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── the two shells must answer `ui.chrome` the same way ─────────────────────
//
// aio generates TWO Electron main scripts and picks between them by TRANSPORT:
// `electronMainScriptUDS` when the app talks to itself over a local socket
// (the default for a local desktop app since alpha66), and `electronMainScript`
// over WebSocket whenever the app has a TCP port — `--expose`, `--port=N`, or
// `transport: "ws"`.
//
// Only the UDS one read `ui.chrome` and `childWindows`. So `ui.chrome: "none"`
// gave a frameless window under `deno task dev` and a fully framed one under
// `deno task dev --expose`: the same config, two windows, no warning. `ui.chrome`
// is one of the three identity-derived defaults the framework promises look the
// same everywhere the app appears, which is what makes a transport-dependent
// answer a divergence rather than a detail.
//
// This is a source-level parity gate (no display, always on) because the
// divergence is in what the scripts SAY; the E2E above proves the UDS half
// meets a real window.

Deno.test("ui.chrome + childWindows: both generated shells decide identically", async () => {
  const { electronMainScript } = await import(
    "../src/electron/electron-scripts.ts"
  );
  const shape = (src: string) => ({
    frame: src.match(/b\.frame\s*=\s*(\w+)/)?.[1],
    webview: src.match(/webviewTag:\s*(\w+)/)?.[1],
  });
  for (const chrome of ["standard", "themed", "none"] as const) {
    for (const childWindows of [false, true]) {
      const meta = { title: "parity", chrome, childWindows };
      const ws = shape(electronMainScript("http://127.0.0.1:3000", meta));
      const uds = shape(
        electronMainScriptUDS("aio://app/", "/tmp/parity.sock", { meta }),
      );
      assertEquals(
        ws,
        uds,
        `chrome=${chrome} childWindows=${childWindows}: the WebSocket shell ` +
          `and the UDS shell must build the same window`,
      );
      assertEquals(
        ws.frame,
        String(chrome === "standard"),
        `chrome=${chrome}: only "standard" keeps the OS frame`,
      );
      assertEquals(ws.webview, String(childWindows));
    }
  }
  // …and the default, which is what most apps get.
  const bare = shape(electronMainScript("http://127.0.0.1:3000"));
  assertEquals(bare, { frame: "true", webview: "false" });
});
