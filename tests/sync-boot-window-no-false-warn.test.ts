// A peer's sync op landing while this page's engine is still loading is
// expected — the engine's boot catch-up re-delivers it — so it must not be
// reported as a missing handler. The warning `[aio:air] sync frame "op" but no
// handler — discarding` fired on ordinary boots of a sync app with another tab
// writing, and sent developers hunting a wiring bug that did not exist. A
// page with NO sync engine coming still says so.
import { assert, assertEquals } from "@std/assert";
import { cell } from "aio";
import { enc } from "../src/protocol/envelope.ts";
import { _resetCellRegistry } from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";
import { _teardownNow } from "../src/browser/protocol-subscription.ts";

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

Deno.test("sync boot window: a peer op before the engine is wired is not a missing handler", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWS = g.WebSocket;
  const prevLoc = g.location;
  g.WebSocket = FakeWS;
  if (!prevLoc) {
    g.location = {
      protocol: "http:",
      host: "localhost:1234",
      search: "",
      origin: "http://localhost:1234",
    };
  }
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  const bp = await import("../src/browser/browser-protocol.ts");
  try {
    await import("../src/browser/browser-air-transport.ts");
    const noHandler = () => warns.filter((w) => w.includes("no handler"));
    const op = enc("op", { id: "p-1", cell: "board-w", action: "add" });

    // No sync cell: nothing will ever handle the frame — said aloud.
    _resetCellRegistry();
    _resetSignals();
    bp._resetEnsured();
    bp.ensureConnected();
    const ws = FakeWS.instances.at(-1)!;
    ws.readyState = 1;
    ws.onopen?.();
    ws.onmessage?.({ data: op });
    assertEquals(noHandler().length, 1, JSON.stringify(warns));

    // A sync cell whose engine import has not resolved yet: expected, quiet.
    cell("board-w", {
      state: { notes: [] as string[] },
      sync: true,
      methods: {
        add(s: { notes: string[] }, t: string) {
          s.notes.push(t);
        },
      },
    });
    bp._setSyncLoaderForTest(() => new Promise(() => {})); // held open
    bp._resetEnsured();
    bp.ensureConnected();
    assert(bp._syncBooting(), "the engine is loading");
    ws.onmessage?.({ data: op });
    assertEquals(noHandler().length, 1, JSON.stringify(warns));
  } finally {
    console.warn = origWarn;
    bp._setSyncLoaderForTest(null);
    bp._resetEnsured();
    _teardownNow();
    _resetCellRegistry();
    _resetSignals();
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
    if (!prevLoc) delete g.location;
  }
});
