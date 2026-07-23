// Audit 2026-07-24 (HIGH, duplicated state): the Electron IPC bridge registers
// its callbacks with `ipcRenderer.on` (additive; the preload bridge exposes no
// `off`), but the transport re-ran its bind on every reconnect. After N server
// restarts each frame was routed N+1 times — and patch frames are NOT
// idempotent, so an Immer array `add` applied twice inserted the item twice.
// One reconnect was enough to double every new todo in the UI.

import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";

type Fn = (line?: string) => void;

Deno.test("air transport: IPC handlers bind once across reconnects", async () => {
  const win = new Window({ url: "https://localhost" });
  const opens: Fn[] = [];
  const messages: Fn[] = [];
  const closes: Fn[] = [];
  let readyCalls = 0;

  // A stand-in for the preload bridge: registrations accumulate, exactly like
  // `ipcRenderer.on`, so a re-bind is observable as a longer handler list.
  (win as unknown as Record<string, unknown>).__aioIPC = {
    send: () => {},
    onOpen: (fn: Fn) => opens.push(fn),
    onMessage: (fn: Fn) => messages.push(fn),
    onClose: (fn: Fn) => closes.push(fn),
    ready: () => readyCalls++,
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevLocation = g.location;
  g.window = win;
  g.location = win.location;

  try {
    // Import AFTER the bridge exists — the transport detects IPC at module load
    // and registers its connect fn with the protocol layer.
    await import(
      `../src/browser/browser-air-transport.ts#${crypto.randomUUID()}`
    );
    const { ensureConnected } = await import(
      "../src/browser/browser-protocol.ts"
    );
    ensureConnected();

    assertEquals(messages.length, 1, "first connect binds one message handler");

    // Server restart: the bridge reports close; the transport reconnects on its
    // own backoff timer (first retry ~1s) — the real path that re-bound.
    for (const fn of closes) fn();
    await new Promise((r) => setTimeout(r, 1400));

    assertEquals(
      messages.length,
      1,
      "reconnects must NOT stack another message handler (each stacked " +
        "handler re-applies every patch frame)",
    );
    assertEquals(opens.length, 1, "open handler bound once");
    assertEquals(closes.length, 1, "close handler bound once");
    assert(readyCalls >= 2, "the reconnect still re-armed the bridge");
  } finally {
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevLocation === undefined) delete g.location;
    else g.location = prevLocation;
    await win.happyDOM.close();
  }
});
