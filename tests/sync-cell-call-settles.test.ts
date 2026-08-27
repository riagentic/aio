// Regression: a `sync: true` cell method call must SETTLE.
//
// The measured defect: a sync cell's method goes through the send wrapper,
// `_syncRoute` claims it as a CRDT op (no `cid` on the wire, so no ack frame
// ever comes back), and the wrapper inherits ARMS_ACK_TIMER from the plain
// transport — so no clock is armed either. `await todos.add("milk")` therefore
// never settled at ANY ceiling, and every call leaked one permanent entry in
// the pending-ack map.
//
// The existing browser-sync tests call `handleSyncLocalAction` directly, which
// is precisely the path that CANNOT see this: the bug lives between the bound
// method and the route. These tests go through the bound method.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { cell } from "aio";
import {
  _pendingAckCount,
  _rejectAllPending,
  _setAckTimeoutMs,
} from "../src/browser/browser-ack.ts";
import {
  _resetCellRegistry,
  getRegisteredCells,
} from "../src/state/cell-reactive.ts";
import { _resetSignals } from "../src/state/state-signals.ts";
import {
  _registerSyncTransport,
  _resetEnsured,
  _setClientSend,
  _setSyncLoaderForTest,
  ensureConnected,
} from "../src/browser/browser-protocol.ts";
import * as browserSync from "../src/browser/browser-sync.ts";
import { _resetBrowserSync } from "../src/browser/browser-sync.ts";

function shimLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
    configurable: true,
  });
}

/** Settle-or-hang: a call that does not settle within `ms` reports "HUNG"
 *  instead of stalling the suite — the failure mode under test. */
function within<T>(p: Promise<T>, ms: number): Promise<string> {
  return Promise.race([
    p.then(() => "ok", (e) => `rejected: ${e}`),
    new Promise<string>((r) => setTimeout(() => r("HUNG"), ms)),
  ]);
}

const tick = () => new Promise((r) => setTimeout(r, 30));

async function withSyncApp(
  fn: (board: { add: (t: string) => Promise<unknown> }) => Promise<void>,
): Promise<void> {
  shimLocalStorage();
  _setAckTimeoutMs(0); // no clock: only a real settle can end the wait
  _resetEnsured();
  _resetBrowserSync();
  _resetCellRegistry();
  _resetSignals();
  const win = new Window({ url: "https://localhost" });
  const rawSends: string[] = [];
  _setClientSend(() => {});
  _registerSyncTransport((raw) => void rawSends.push(raw), () => {});
  _setSyncLoaderForTest(() => Promise.resolve(browserSync));
  cell("scs-board", {
    state: { notes: [] as string[] },
    sync: true,
    methods: {
      add(s: { notes: string[] }, text: string) {
        s.notes.push(text);
      },
    },
  });
  try {
    ensureConnected();
    await tick(); // let the engine's (immediate) import resolve
    await fn(
      getRegisteredCells().get("scs-board") as unknown as {
        add: (t: string) => Promise<unknown>;
      },
    );
  } finally {
    _setSyncLoaderForTest(null);
    _rejectAllPending(new Error("test teardown"));
    _setAckTimeoutMs(15_000);
    _resetEnsured();
    _resetBrowserSync();
    _resetCellRegistry();
    _resetSignals();
    await win.happyDOM.close();
  }
}

Deno.test({
  name: "sync cell: an awaited method call settles (it is a local-first op)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withSyncApp(async (board) => {
      assertEquals(
        await within(board.add("milk"), 500),
        "ok",
        "a sync-cell method must settle once the op is durably queued — it " +
          "is never acked over the wire, so nothing else ever will settle it",
      );
    }),
});

Deno.test({
  name: "sync cell: repeated calls leak no pending acks",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withSyncApp(async (board) => {
      const before = _pendingAckCount();
      const calls = ["a", "b", "c", "d", "e", "f"].map((t) => board.add(t));
      assertEquals(
        await within(Promise.all(calls), 800),
        "ok",
        "six sync-cell calls must all settle",
      );
      assertEquals(
        _pendingAckCount(),
        before,
        "every sync-cell call must release its pending-ack entry — they are " +
          "unreleasable otherwise (no ack frame, no timer)",
      );
    }),
});

Deno.test({
  name: "sync cell: a call made during the engine boot window still settles",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    shimLocalStorage();
    _setAckTimeoutMs(0);
    _resetEnsured();
    _resetBrowserSync();
    _resetCellRegistry();
    _resetSignals();
    const win = new Window({ url: "https://localhost" });
    _setClientSend(() => {});
    _registerSyncTransport(() => {}, () => {});
    let releaseBoot!: () => void;
    const booted = new Promise<void>((r) => (releaseBoot = r));
    _setSyncLoaderForTest(() => booted.then(() => browserSync));
    cell("scs-window", {
      state: { notes: [] as string[] },
      sync: true,
      methods: {
        add(s: { notes: string[] }, text: string) {
          s.notes.push(text);
        },
      },
    });
    try {
      ensureConnected();
      const board = getRegisteredCells().get("scs-window") as unknown as {
        add: (t: string) => Promise<unknown>;
      };
      // Dispatched while the engine is still importing: the action is BUFFERED,
      // and its `cid` has to survive the flush or the caller waits forever.
      const call = board.add("buffered");
      await tick();
      releaseBoot();
      assertEquals(await within(call, 800), "ok");
      assertEquals(_pendingAckCount(), 0);
    } finally {
      _setSyncLoaderForTest(null);
      _rejectAllPending(new Error("test teardown"));
      _setAckTimeoutMs(15_000);
      _resetEnsured();
      _resetBrowserSync();
      _resetCellRegistry();
      _resetSignals();
      await win.happyDOM.close();
    }
  },
});

Deno.test({
  name: "sync cell: the method's promise settles AFTER the op is on the wire",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () =>
    withSyncApp(async (board) => {
      await board.add("ordered");
      const engine = browserSync.getBrowserSyncEngine();
      assert(engine, "engine must be up");
      // Awaiting the call means the op is buffered + dispatched: the caller's
      // `await` is a real durability point, not a coin flip.
      assertEquals(engine!.getStatus("scs-board").status !== "blocked", true);
    }),
});
