// The IPC connect watchdog exists for one failure: a bridge that answers
// neither `onOpen` nor `onClose` leaves `_ipcConnected` set forever, so
// `_tryConnect` believes an attempt is live, never retries, and the client sits
// there with no connection, no retry and no error.
//
// It bailed on `_wasConnected` — true forever once the page had connected
// ONCE. So it guarded only the very first connect: after a single successful
// open, a reconnect the bridge never answered was exactly the silent dead end
// the watchdog was written to prevent.
import { _teardownNow } from "../src/browser/protocol-subscription.ts";
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";

type Fn = (line?: string) => void;

Deno.test("air transport: the IPC watchdog retries an unanswered RECONNECT, not only the first connect", async () => {
  const win = new Window({ url: "https://localhost" });
  const opens: Fn[] = [];
  const closes: Fn[] = [];
  let readyCalls = 0;
  (win as unknown as Record<string, unknown>).__aioIPC = {
    send: () => {},
    onOpen: (fn: Fn) => opens.push(fn),
    onMessage: () => {},
    onClose: (fn: Fn) => closes.push(fn),
    // Only the FIRST ready is answered; every later one goes unanswered.
    ready: () => {
      if (++readyCalls === 1) queueMicrotask(() => opens.forEach((f) => f()));
    },
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
    const { ensureConnected } = await import(
      "../src/browser/browser-protocol.ts"
    );
    ensureConnected();
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(opens.length, 1, "bridge bound");
    assertEquals(readyCalls, 1, "first connect asked once and was answered");

    // The backend goes away; the reconnect (~1s) is never answered.
    for (const fn of closes) fn();
    await new Promise((r) => setTimeout(r, 1400));
    assertEquals(readyCalls, 2, "the reconnect asked the bridge");

    // The watchdog (10s) must notice and try again (after its backoff, ≤2.4s).
    await new Promise((r) => setTimeout(r, 13_500));
    assert(
      readyCalls >= 3,
      `an unanswered reconnect was never retried (ready calls: ${readyCalls})`,
    );
  } finally {
    _teardownNow();
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevLocation === undefined) delete g.location;
    else g.location = prevLocation;
    await closeWindow(win);
  }
});
