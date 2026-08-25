// field report §1.3 — a page whose origin has no HTTP must NEVER fall back to WS.
//
// On an `aio://` page (the zero-port Electron shell) `location.host` is `app`
// and `ws://app/ws` is a socket that cannot exist. After a hot reload the
// renderer used to reach exactly that URL and retry it every backoff step —
// "the window comes back blank and does not recover" — while over http:// the
// same fallback silently worked, which is why it was never seen. Both clients
// that could open a WebSocket on such a page are pinned here:
//   1. the AIR transport's `_connect()` — IPC if present, else a LOUD failure
//      (throw + status + diagnostic), no WebSocket, no retry loop;
//   2. the dev reload script — skipped entirely without an HTTP origin or
//      with an IPC bridge (which already delivers reload/css/boot).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Window } from "happy-dom";
import { devWsScript } from "../src/server/server-html-scripts.ts";
import { NO_TRANSPORT_MSG } from "../src/browser/browser-shared.ts";

type Fn = (line?: string) => void;

/** Installs a happy-dom window at `url`, a recording WebSocket, and an
 *  optional IPC bridge; returns the recorder + a restore fn. */
function installPage(url: string, ipc: boolean) {
  const win = new Window({ url });
  const wsUrls: string[] = [];
  let readyCalls = 0;
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = {
    window: g.window,
    location: g.location,
    WebSocket: g.WebSocket,
    document: g.document,
  };
  g.window = win;
  g.location = win.location;
  g.document = win.document;
  g.WebSocket = class {
    constructor(u: string) {
      wsUrls.push(u);
    }
    send() {}
    close() {}
  };
  if (ipc) {
    (win as unknown as Record<string, unknown>).__aioIPC = {
      send: () => {},
      onOpen: (_fn: Fn) => {},
      onMessage: (_fn: Fn) => {},
      onClose: (_fn: Fn) => {},
      ready: () => readyCalls++,
    };
  }
  return {
    wsUrls,
    readyCalls: () => readyCalls,
    async restore() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
      await win.happyDOM.close();
    },
  };
}

async function freshTransport() {
  // A fresh transport instance registers its connect fn with the (shared)
  // protocol layer; `ensureConnected` is once-per-module, so reset it too.
  await import(
    `../src/browser/browser-air-transport.ts#${crypto.randomUUID()}`
  );
  const proto = await import("../src/browser/browser-protocol.ts");
  proto._resetEnsured();
  return proto;
}

Deno.test("air transport: aio:// page without an IPC bridge fails LOUD — no WebSocket, no retry", async () => {
  const page = installPage("aio://app/", false);
  try {
    const { ensureConnected } = await freshTransport();
    const err = assertThrows(() => ensureConnected(), Error);
    assert(
      err.message.includes(NO_TRANSPORT_MSG),
      `the failure names the cause:\n${err.message}`,
    );
    assertEquals(
      page.wsUrls,
      [],
      "no WebSocket was constructed (ws://app/ws cannot exist)",
    );
    // No retry loop: the backoff's first step is ~1s; nothing may open after it.
    await new Promise((r) => setTimeout(r, 1400));
    assertEquals(page.wsUrls, [], "…and none after the backoff window either");
  } finally {
    await page.restore();
  }
});

Deno.test("air transport: aio:// page WITH the IPC bridge uses it, never WS", async () => {
  const page = installPage("aio://app/", true);
  try {
    const { ensureConnected } = await freshTransport();
    ensureConnected();
    assert(page.readyCalls() >= 1, "the bridge was armed (ipc.ready)");
    assertEquals(page.wsUrls, [], "no WebSocket on an aio:// page");
  } finally {
    await page.restore();
  }
});

Deno.test("air transport: http:// page without IPC still opens the WebSocket (unchanged)", async () => {
  const page = installPage("http://localhost:1234/?token=t", false);
  try {
    const { ensureConnected } = await freshTransport();
    ensureConnected();
    assertEquals(page.wsUrls, ["ws://localhost:1234/ws?token=t"]);
  } finally {
    await page.restore();
  }
});

// ── the dev reload script ─────────────────────────────────────────────────

/** Runs the generated script with the page globals it reads. */
function runDevWs(url: string, ipc: boolean): string[] {
  const wsUrls: string[] = [];
  const win = new Window({ url });
  const w = win as unknown as Record<string, unknown>;
  if (ipc) w.__aioIPC = {};
  class WS {
    constructor(u: string) {
      wsUrls.push(u);
    }
  }
  const timers: unknown[] = [];
  new Function(
    "location",
    "window",
    "WebSocket",
    "document",
    "setTimeout",
    "console",
    devWsScript(),
  )(win.location, win, WS, win.document, (f: unknown) => timers.push(f), {
    debug: () => {},
    warn: () => {},
  });
  win.happyDOM.close();
  return wsUrls;
}

Deno.test("dev reload script: skipped on a page with no HTTP origin or with an IPC bridge", () => {
  assertEquals(
    runDevWs("aio://app/", false),
    [],
    "aio:// origin → no reload WS",
  );
  assertEquals(
    runDevWs("http://localhost:1234/", true),
    [],
    "IPC bridge → it delivers reload; no WS",
  );
  assertEquals(
    runDevWs("http://localhost:1234/", false),
    ["ws://localhost:1234/ws"],
    "plain http:// dev page → reload WS as before",
  );
  assertEquals(
    runDevWs("https://localhost:1234/?token=abc", false),
    ["wss://localhost:1234/ws?token=abc"],
  );
});
