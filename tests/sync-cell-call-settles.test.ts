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
import { within as raceWithin } from "./within.ts";
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
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
  return raceWithin(p.then(() => "ok", (e) => `rejected: ${e}`), ms, "HUNG");
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
    await closeWindow(win);
  }
}

Deno.test({
  name: "sync cell: an awaited method call settles (it is a local-first op)",
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
      await closeWindow(win);
    }
  },
});

Deno.test({
  name: "sync cell: the method's promise settles AFTER the op is on the wire",
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

// ── An ASYNC method on a sync cell must go to the SERVER, not the op log ──
//
// `handleSyncLocalAction` claimed every non-`__` method on a sync cell,
// async ones included, and resolved the caller's ack the moment the op was
// queued — with no value, because that IS the honest settle point for a
// local-first write. For an async method it is not a settle point at all: the
// answer comes from the server, correlated by the `_callId` the plain action
// path stamps. So `const id = await notes.create(…)` resolved `undefined` in
// a BROWSER TAB while the identical call over `am`/CLI returned the value —
// one call, two answers, decided by which kind of client you were. Under
// `localFirst: true` every methods-style cell is adopted, so it was every
// async method in the app, silently.
//
// The routing is what is pinned here: a sync method goes down the CRDT
// transport, an async one goes down the plain client send carrying a
// `_callId`. That is the decision the bug got wrong, and it is observable
// without a server.
Deno.test({
  name:
    "sync cell: an async method routes to the server, a sync one to the op log",
  async fn() {
    shimLocalStorage();
    _setAckTimeoutMs(0);
    _resetEnsured();
    _resetBrowserSync();
    _resetCellRegistry();
    _resetSignals();
    const win = new Window({ url: "https://localhost" });
    const rawSends: string[] = [];
    const plainSends: unknown[] = [];
    _setClientSend((a) => void plainSends.push(a));
    _registerSyncTransport((raw) => void rawSends.push(raw), () => {});
    _setSyncLoaderForTest(() => Promise.resolve(browserSync));
    cell("scs-mixed", {
      state: { notes: [] as string[] },
      sync: true,
      methods: {
        addSync(s: { notes: string[] }, text: string) {
          s.notes.push(text);
          return "SYNC-RET";
        },
        // deno-lint-ignore require-await
        async addAsync(s: { notes: string[] }, text: string) {
          s.notes.push(text);
          return "ASYNC-RET";
        },
      },
    });
    try {
      ensureConnected();
      await tick();
      const board = getRegisteredCells().get("scs-mixed") as unknown as {
        addSync: (t: string) => Promise<unknown>;
        addAsync: (t: string) => Promise<unknown>;
      };

      await within(board.addSync("a"), 500);
      const opsAfterSync = rawSends.filter((f) => f.includes('"t":"op"'));
      assertEquals(
        opsAfterSync.length,
        1,
        "a SYNC method on a sync cell is a CRDT op",
      );
      assertEquals(plainSends.length, 0, "and it does not go to the server");

      // The async call will not settle here — there is no server to answer —
      // which is itself the point: it is WAITING for a return value now.
      void board.addAsync("b");
      await tick();
      assertEquals(
        rawSends.filter((f) => f.includes('"t":"op"')).length,
        1,
        "an ASYNC method must NOT be written to the op log: it has no local " +
          "reduction, and replaying it is what the reducer already refuses",
      );
      assertEquals(
        plainSends.length,
        1,
        "it goes down the ordinary action path, where the answer comes from",
      );
      const sent = plainSends[0] as {
        type?: string;
        payload?: { _callId?: string };
      };
      assertEquals(sent.type, "scs-mixed:addAsync");
      assert(
        typeof sent.payload?._callId === "string",
        "carrying the _callId the server resolves with the RETURN VALUE — " +
          `got ${JSON.stringify(sent)}`,
      );
    } finally {
      _setSyncLoaderForTest(null);
      _rejectAllPending(new Error("test teardown"));
      _setAckTimeoutMs(15_000);
      _resetEnsured();
      _resetBrowserSync();
      _resetCellRegistry();
      _resetSignals();
      await closeWindow(win);
    }
  },
});
