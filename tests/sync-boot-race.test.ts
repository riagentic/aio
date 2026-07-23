// Regression: the sync-engine boot-window race.
//
// A sync cell's method call dispatched BEFORE the engine's lazy dynamic import
// resolves must not leak to a plain send — a plain send skips HLC stamping and
// the offline queue, silently diverging the op-log (this was the intermittent
// failure behind tests/e2e-sync-browser.test.ts "exactly one op persisted").
// ensureConnected() now knows the sync-cell ids synchronously and BUFFERS their
// actions until the engine boots, then flushes them through it.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { cell } from "aio";
import {
  _rejectAllPending,
  _setAckTimeoutMs,
} from "../src/protocol/browser-ack.ts";
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

const tick = () => new Promise((r) => setTimeout(r, 30));

Deno.test({
  name:
    "sync boot race: a sync-cell method before engine boot is buffered, never plain-sent",
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

    const plainSends: Array<{ type: string }> = [];
    const rawSends: string[] = [];
    _setClientSend((a) => void plainSends.push(a as { type: string }));
    _registerSyncTransport((raw) => void rawSends.push(raw), () => {});

    // Hold the engine boot OPEN so the buffer window is deterministic (in the
    // real browser the first import of browser-sync.ts is a slow fetch; here
    // the module is cached, so without this gate the race never opens).
    let releaseBoot!: () => void;
    const booted = new Promise<void>((r) => (releaseBoot = r));
    _setSyncLoaderForTest(() => booted.then(() => browserSync));

    // A sync cell and a plain cell registered together.
    cell("board", {
      state: { notes: [] as string[] },
      sync: true,
      methods: {
        add(s: { notes: string[] }, text: string) {
          s.notes.push(text);
        },
      },
    });
    cell("log", {
      state: { lines: [] as string[] },
      methods: {
        write(s: { lines: string[] }, line: string) {
          s.lines.push(line);
        },
      },
    });

    try {
      // Kicks the engine's async import; _syncRoute is null on this same tick.
      // bindAllCellsReactive (inside) wires each registry def's methods to the
      // send wrapper — invoke via the def so we exercise that exact path.
      ensureConnected();
      const board = getRegisteredCells().get("board") as unknown as {
        add: (t: string) => Promise<void>;
      };
      const log = getRegisteredCells().get("log") as unknown as {
        write: (l: string) => Promise<void>;
      };

      // Dispatched WHILE the engine is still booting (boot gate not released):
      board.add("milk"); // sync cell → must be buffered, not plain-sent
      log.write("hello"); // plain cell → straight to plain send
      await tick(); // drain the deferred-send microtasks

      // Mid-boot: the sync action is held; the plain action already went out.
      assertEquals(
        plainSends.filter((a) => a.type === "board:add").length,
        0,
        "sync-cell action must be BUFFERED during boot, never plain-sent",
      );
      assertEquals(
        plainSends.filter((a) => a.type === "log:write").length,
        1,
        "non-sync action must dispatch immediately (no over-buffering)",
      );
      assertEquals(
        rawSends.some((r) => r.includes("milk")),
        false,
        "nothing sync-related on the wire until the engine boots",
      );

      // Now let the engine boot and flush the buffer.
      releaseBoot();
      await tick();
      await tick();

      // The buffered action became an OP on the wire — never a plain send.
      assert(
        rawSends.some((r) => r.includes('"t":"op"') && r.includes("milk")),
        "buffered sync action flushed through the engine as an op",
      );
      assertEquals(
        plainSends.filter((a) => a.type === "board:add").length,
        0,
        "sync action stayed off the plain path through boot + flush",
      );
    } finally {
      _setSyncLoaderForTest(null);
      _rejectAllPending(new Error("test teardown"));
      _resetEnsured();
      _resetBrowserSync();
      _resetCellRegistry();
      _resetSignals();
      await win.happyDOM.close();
    }
  },
});

Deno.test({
  name: "sync boot race: with NO sync cells, nothing is buffered",
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

    const plainSends: Array<{ type: string }> = [];
    _setClientSend((a) => void plainSends.push(a as { type: string }));
    _registerSyncTransport(() => {}, () => {});

    cell("counter", {
      state: { n: 0 },
      methods: {
        inc(s: { n: number }) {
          s.n += 1;
        },
      },
    });

    try {
      ensureConnected();
      const counter = getRegisteredCells().get("counter") as unknown as {
        inc: () => Promise<void>;
      };
      counter.inc();
      await tick();
      // No sync cells → the send wrapper never buffers; the action plain-sends.
      assertEquals(
        plainSends.filter((a) => a.type === "counter:inc").length,
        1,
        "plain-only app must plain-send, no buffering",
      );
    } finally {
      _rejectAllPending(new Error("test teardown"));
      _resetEnsured();
      _resetCellRegistry();
      _resetSignals();
      await win.happyDOM.close();
    }
  },
});
