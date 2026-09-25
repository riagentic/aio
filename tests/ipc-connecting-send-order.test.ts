// The Electron IPC transport marked itself connected the moment it ASKED the
// bridge to open (`_ipcConnected = true` is the re-entry guard in
// `_connectIPC`), not when the bridge said it was open. A call made in that
// gap — a reconnect retry waiting for `__aio:open` — went straight to the
// bridge, AHEAD of the calls already waiting in the offline queue (which only
// flush on open): reconnect reordered the user's intent. When the backend was
// still down the main process parked that frame in its own queue while the
// renderer counted it as in flight, so the `__aio:close` that answered the
// retry rejected it as "connection lost" — and the main process then
// delivered it on the next connection: one intent, a rejection AND an
// application.
//
// A call is only written to the bridge once the bridge is OPEN; before that it
// queues like any other offline call and flushes, in order, on open.

import { _teardownNow } from "../src/browser/protocol-subscription.ts";
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";

type Fn = (line?: string) => void;

Deno.test("air transport: an IPC call made before the bridge opens queues behind older offline calls", async () => {
  const win = new Window({ url: "https://localhost" });
  const opens: Fn[] = [];
  const closes: Fn[] = [];
  const sent: string[] = [];
  let readyCalls = 0;
  (win as unknown as Record<string, unknown>).__aioIPC = {
    send: (json: string) => sent.push(json),
    onOpen: (fn: Fn) => opens.push(fn),
    onMessage: () => {},
    onClose: (fn: Fn) => closes.push(fn),
    ready: () => readyCalls++,
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevLocation = g.location;
  g.window = win;
  g.location = win.location;

  const actions = () =>
    sent.map((s) => JSON.parse(s) as { t: string; d?: { type?: string } })
      .filter((f) => f.t === "action").map((f) => f.d?.type);

  try {
    await import(
      `../src/browser/browser-air-transport.ts#${crypto.randomUUID()}`
    );
    const { ensureConnected, client } = await import(
      "../src/browser/browser-protocol.ts"
    );
    ensureConnected();
    assertEquals(readyCalls, 1, "first connect asked the bridge to open");

    // Asked, not yet open: nothing may be written to the bridge.
    client.send({ type: "ord:early" });
    assertEquals(actions(), [], "a call before open was written to the bridge");
    for (const fn of opens) fn();
    assertEquals(actions(), ["ord:early"], "the queued call flushed on open");

    // The backend goes away; a call is queued while offline.
    for (const fn of closes) fn();
    sent.length = 0;
    client.send({ type: "ord:first" });
    assertEquals(actions(), []);

    // The reconnect retry (~1s backoff) asks the bridge to open again.
    const before = readyCalls;
    await new Promise((r) => setTimeout(r, 1500));
    assert(readyCalls > before, "the retry re-armed the bridge");

    // In the gap before `__aio:open`, the user acts again.
    client.send({ type: "ord:second" });
    assertEquals(
      actions(),
      [],
      "a call made while the bridge was still opening jumped the offline " +
        "queue (and, with the backend down, was rejected yet still delivered)",
    );

    for (const fn of opens) fn();
    assertEquals(actions(), ["ord:first", "ord:second"]);
  } finally {
    _teardownNow();
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevLocation === undefined) delete g.location;
    else g.location = prevLocation;
    await closeWindow(win);
  }
});

Deno.test("air transport: an IPC open announced after teardown does not revive the client", async () => {
  const win = new Window({ url: "https://localhost" });
  const opens: Fn[] = [];
  const sent: string[] = [];
  (win as unknown as Record<string, unknown>).__aioIPC = {
    send: (json: string) => sent.push(json),
    onOpen: (fn: Fn) => opens.push(fn),
    onMessage: () => {},
    onClose: () => {},
    ready: () => {},
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const prevWindow = g.window;
  const prevLocation = g.location;
  g.window = win;
  g.location = win.location;
  try {
    await import(
      `../src/browser/browser-air-transport.ts#${crypto.randomUUID()}`
    );
    const { ensureConnected, client, _resetEnsured } = await import(
      "../src/browser/browser-protocol.ts"
    );
    const { getConnectedSignal } = await import("../src/state-core.ts");
    _resetEnsured(); // a fresh transport instance: connect it, not the last one
    ensureConnected();
    for (const fn of opens) fn();
    assertEquals(getConnectedSignal().peek(), true);
    _teardownNow();
    assertEquals(getConnectedSignal().peek(), false);

    // The main process reconnects to its backend on its own and announces it.
    // The bridge (bound for the page's life) still delivers that open — to a
    // client that was torn down and asked for nothing.
    sent.length = 0;
    for (const fn of opens) fn();
    assertEquals(
      getConnectedSignal().peek(),
      false,
      "a torn-down client was revived by an open it never asked for",
    );
    client.send({ type: "dead:call" });
    assertEquals(sent, [], "a torn-down client wrote to the bridge");
  } finally {
    _teardownNow();
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevLocation === undefined) delete g.location;
    else g.location = prevLocation;
    await closeWindow(win);
  }
});
