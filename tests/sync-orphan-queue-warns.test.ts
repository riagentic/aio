// A cell that stops syncing (its `sync` option dropped, the cell removed)
// leaves `__aio_sync.<app>:<cell>` in localStorage with its unsent ops, and no
// engine ever loads for it again — the changes were lost with nothing said.
// The eager bundle now checks once, at the first `cfg` frame, and names the
// cell, the count and the key.
import { assertEquals } from "@std/assert";
import { _teardownNow } from "../src/browser/protocol-subscription.ts";
import { _resetBrowserSync } from "../src/browser/browser-sync.ts";
import { _resetCellRegistry } from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";
import { _rejectAllPending } from "../src/browser/browser-ack.ts";
import { orphanSyncQueues } from "../src/sync/storage-prefix.ts";

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

function fakeStorage(store: Map<string, string>) {
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

const op = (id: string, confirmed: boolean) => ({
  id,
  cell: "notes",
  action: "add",
  payload: {},
  hlc: [1, 0, "c"],
  confirmed,
});

Deno.test("orphanSyncQueues: counts unsent ops of cells that no longer sync", () => {
  const g = globalThis as Record<string, unknown>;
  const prevLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>([
    [
      "__aio_sync.app:notes",
      JSON.stringify({ ops: [op("a", false), op("b", true), op("c", false)] }),
    ],
    ["__aio_sync.app:live", JSON.stringify({ ops: [op("d", false)] })],
    ["__aio_sync.app:done", JSON.stringify({ ops: [op("e", true)] })],
    ["__aio_sync.app:clientId", "x"],
    ["__aio_sync.app:bad.corrupt", "{"],
    ["__aio_sync.other:notes", JSON.stringify({ ops: [op("f", false)] })],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: fakeStorage(store),
  });
  try {
    assertEquals(orphanSyncQueues("__aio_sync.app", new Set(["live"])), [
      { cell: "notes", unsent: 2 },
    ]);
  } finally {
    if (prevLS) Object.defineProperty(globalThis, "localStorage", prevLS);
    else delete (g as { localStorage?: unknown }).localStorage;
  }
});

Deno.test("the first cfg frame warns once about an orphaned offline queue", async () => {
  const g = globalThis as Record<string, unknown>;
  const prevWS = g.WebSocket;
  const prevLoc = g.location;
  const prevCfg = g.__aioConfig;
  const prevLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  g.WebSocket = FakeWS;
  if (!prevLoc) {
    g.location = {
      protocol: "http:",
      host: "localhost:1234",
      search: "",
      origin: "http://localhost:1234",
      href: "http://localhost:1234/",
      pathname: "/",
    };
  }
  const store = new Map<string, string>([
    ["__aio_sync.myapp:notes", JSON.stringify({ ops: [op("a", false)] })],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: fakeStorage(store),
  });
  delete g.__aioConfig;
  const proto = await import("../src/browser/browser-protocol.ts");
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    await import("../src/browser/browser-air-transport.ts");
    proto._resetEnsured();
    proto.ensureConnected();
    proto._applyServerConfig({ appId: "myapp" });
    proto._applyServerConfig({ appId: "myapp" });
    const said = warns.filter((w) => w.includes("unsent offline changes"));
    assertEquals(said.length, 1, JSON.stringify(warns));
    assertEquals(said[0]!.includes('"notes" (1, key'), true, said[0]);
    assertEquals(said[0]!.includes("__aio_sync.myapp:notes"), true, said[0]);
    assertEquals(store.has("__aio_sync.myapp:notes"), true, "read-only");
  } finally {
    console.warn = warn;
    _teardownNow();
    _resetBrowserSync();
    _rejectAllPending(new Error("test teardown"));
    _resetCellRegistry();
    _resetSignals();
    proto._resetEnsured();
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
    if (!prevLoc) delete g.location;
    if (prevCfg === undefined) delete g.__aioConfig;
    else g.__aioConfig = prevCfg;
    if (prevLS) Object.defineProperty(globalThis, "localStorage", prevLS);
    else delete (g as { localStorage?: unknown }).localStorage;
  }
});
