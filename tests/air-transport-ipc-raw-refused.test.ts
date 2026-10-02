// The Electron IPC bridge refusing a write while it reports open — the
// UNQUEUED path (`_sendRaw`: sync ops, serverFn calls, forwarded console
// lines).
//
// The WebSocket branch of the same function has answered `false` and reported
// the drop since it was written; the IPC branch called `_ipc.send(msg)` bare,
// so the bridge's throw went into every raw caller (a serverFn call, a sync
// op, a route reply) — and a forwarded console line, whose caller catches its
// own, vanished with no report at all. It is guarded now, and says so on the
// diagnostic bus exactly as its WS twin does.
import { _teardownNow } from "../src/browser/protocol-subscription.ts";
import { assert } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";

type Fn = (line?: string) => void;

Deno.test("air transport (IPC): a refused UNQUEUED write returns, and is reported on the bus", async () => {
  const win = new Window({ url: "https://localhost" });
  const opens: Fn[] = [];
  let refuse = false;
  (win as unknown as Record<string, unknown>).__aioIPC = {
    send: () => {
      if (refuse) throw new Error("Object has been destroyed");
    },
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
  const { diagSubscribe, initDiagnosticBus } = await import(
    "../src/diagnostics/diagnostic-bus.ts"
  );
  initDiagnosticBus(true);
  const seen: string[] = [];
  const unsub = diagSubscribe((e) => seen.push(e.type));
  try {
    await import("../src/browser/browser-air-transport.ts");
    const { ensureConnected } = await import(
      "../src/browser/browser-protocol.ts"
    );
    ensureConnected();
    for (const fn of opens) fn(); // the bridge says OPEN
    refuse = true;
    // A forwarded console line is an unqueued raw frame.
    console.log("[test] a line the bridge will refuse");
    assert(
      seen.includes("browser-air-transport:raw-send-failed"),
      `the IPC drop must reach the bus like the WebSocket one. Saw: ${
        JSON.stringify([...new Set(seen)])
      }`,
    );
  } finally {
    refuse = false;
    unsub();
    _teardownNow();
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevLocation === undefined) delete g.location;
    else g.location = prevLocation;
    await closeWindow(win);
  }
});
