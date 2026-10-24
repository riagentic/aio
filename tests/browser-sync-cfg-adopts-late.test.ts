// A build-time shell (Electron, Android, a static web build) learns the
// server's `localFirst` adoptions only from the `cfg` frame. When the app also
// has a cell that says `sync: true` itself, the engine boots for THAT cell at
// connect — before the frame — and its cell set was fixed there: every cell
// the server adopted kept round-tripping as a plain action for the whole
// session (no optimistic call, no durable offline queue), while the
// server-served page of the same app ran them locally. They join the running
// engine now.
import { assert, assertEquals } from "@std/assert";
import { _teardownNow } from "../src/browser/protocol-subscription.ts";
import {
  _resetBrowserSync,
  getBrowserSyncEngine,
  syncCellNames,
} from "../src/browser/browser-sync.ts";
import {
  _resetCellRegistry,
  registerCell,
} from "../src/state/cell-reactive.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { _resetSignals } from "../src/state/state-signals.ts";
import { _rejectAllPending } from "../src/browser/browser-ack.ts";

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
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
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Boot an app with one explicit sync cell and one the server adopts, in a
 *  build-time shell; the cfg frame lands after the engine booted, or — with
 *  `hold` — while its import is still on its way. */
async function lateAdoption(hold: boolean): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const prevWS = g.WebSocket;
  const prevLoc = g.location;
  const prevCfg = g.__aioConfig;
  const prevLS = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  g.WebSocket = FakeWS;
  FakeWS.instances = [];
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
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  delete g.__aioConfig; // the build-time shell: no compose decisions
  const proto = await import("../src/browser/browser-protocol.ts");
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    await import("../src/browser/browser-air-transport.ts");
    const { cell } = await import("../src/browser/protocol-cell.ts");
    proto._resetEnsured();
    let release = () => {};
    if (hold) {
      const gate = new Promise<void>((r) => (release = r));
      proto._setSyncLoaderForTest(async () => {
        await gate;
        return await import("../src/browser/browser-sync.ts");
      });
    }
    cell("lx-own", {
      state: { n: 0 },
      sync: true,
      methods: {
        inc(s: { n: number }) {
          s.n++;
        },
      },
    });
    const adopted = cell("lx-adopted", {
      state: { items: [] as string[] },
      methods: {
        add(s: { items: string[] }, t: string) {
          s.items.push(t);
        },
      },
    });
    proto.ensureConnected();
    const ws = FakeWS.instances[0]!;
    ws.open();
    await sleep(30);
    assertEquals(getBrowserSyncEngine() !== null, !hold);

    // A cell the server adopted that cannot replay locally (no replay
    // reducer): the late path warns exactly as the boot path does.
    registerCell(
      {
        __aio: { id: "lx-noreplay", scope: "server", state: {} },
      } as never as CellDef,
    );
    // The server's cfg frame: it adopted lx-adopted and lx-noreplay.
    proto._applyServerConfig({ syncCells: ["lx-adopted", "lx-noreplay"] });
    await sleep(20);
    proto._applyServerConfig({ syncCells: ["lx-adopted", "lx-noreplay"] });
    await sleep(20);
    ws.sent.length = 0;
    const call = (adopted as unknown as { add(t: string): Promise<unknown> })
      .add("milk");
    release();
    await call;
    await sleep(30);
    assertEquals([...syncCellNames()].sort(), ["lx-adopted", "lx-own"]);
    const kinds = ws.sent.map((f) =>
      JSON.parse(f) as { t: string; d: { cell?: string } }
    );
    assert(
      kinds.some((f) => f.t === "op" && f.d.cell === "lx-adopted"),
      `the adopted cell's call leaves as a CRDT op — the socket saw: ${
        JSON.stringify(kinds.map((f) => f.t))
      }`,
    );
    const items = (adopted as unknown as { items: string[] }).items;
    // A reactive read arms the subscription narrowing timer — let it run here.
    await sleep(150);
    assertEquals(items, ["milk"], "applied locally");
    assertEquals(
      warns.filter((w) => w.includes("'lx-noreplay' but this cell cannot"))
        .length,
      1,
      `said once: ${JSON.stringify(warns)}`,
    );
  } finally {
    console.warn = warn;
    proto._setSyncLoaderForTest(null);
    _teardownNow();
    _resetBrowserSync();
    _rejectAllPending(new Error("test teardown"));
    _resetCellRegistry();
    _resetSignals();
    if (prevWS === undefined) delete g.WebSocket;
    else g.WebSocket = prevWS;
    if (!prevLoc) delete g.location;
    if (prevCfg === undefined) delete g.__aioConfig;
    else g.__aioConfig = prevCfg;
    if (prevLS) Object.defineProperty(globalThis, "localStorage", prevLS);
    else delete (g as { localStorage?: unknown }).localStorage;
  }
}

// aio-ok: lateAdoption asserts the routing and the local apply
Deno.test("sync: a cell adopted by the cfg frame joins an engine already booted for an explicit sync cell", () =>
  lateAdoption(false));

// aio-ok: lateAdoption asserts the routing and the local apply
Deno.test("sync: a cell adopted by the cfg frame while the engine is still loading is buffered, then routed", () =>
  lateAdoption(true));
