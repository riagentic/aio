// One undeliverable action in the sync boot-window buffer must not take the
// ones behind it.
//
// A sync cell's methods are BUFFERED until the CRDT engine's lazy import
// resolves (tests/sync-boot-race.test.ts pins why). If that boot fails, the
// buffer is replayed as plain sends "so nothing is lost" — through a bare
// `for` loop with no guard. A send that THROWS there (the frame could not be
// built at all: a BigInt, a cycle — a transport that merely refuses the write
// queues instead of throwing) abandoned every action after it, in silence.
//
// Same shape as both offline queues, which were each fixed for it separately:
// an action is delivered, or it waits, or its caller hears why. Never
// "silently gone, along with the ones behind it".
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { cell } from "aio";
import {
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
    "sync boot flush: an action that cannot be sent is dropped alone, loudly",
  async fn() {
    shimLocalStorage();
    _setAckTimeoutMs(0);
    _resetEnsured();
    _resetBrowserSync();
    _resetCellRegistry();
    _resetSignals();
    const win = new Window({ url: "https://localhost" });

    const sent: string[] = [];
    _setClientSend((a) => {
      // The middle one is the frame that cannot be built.
      if (JSON.stringify(a.payload ?? {}).includes("poison")) {
        throw new Error("Do not know how to serialize a BigInt");
      }
      sent.push(
        `${a.type}(${(a.payload as { args?: unknown[] })?.args?.[0]})`,
      );
    });
    _registerSyncTransport(() => {}, () => {});

    // The engine never boots — the "flush as plain sends so nothing is lost"
    // branch, which is the one with the bare loop.
    _setSyncLoaderForTest(() =>
      Promise.reject(new Error("engine unavailable"))
    );

    cell("board", {
      state: { notes: [] as string[] },
      sync: true,
      methods: {
        add(s: { notes: string[] }, text: string) {
          s.notes.push(text);
        },
      },
    });

    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      ensureConnected();
      const board = getRegisteredCells().get("board") as unknown as {
        add: (t: string) => Promise<void>;
      };
      board.add("first");
      board.add("poison");
      board.add("third");
      await tick();
      await tick();

      assertEquals(
        sent,
        ["board:add(first)", "board:add(third)"],
        "the action behind the undeliverable one still went out",
      );
      assert(
        errors.some((e) => e.includes("board:add") && e.includes("dropped")),
        `the drop must be said out loud, got: ${errors.join(" | ")}`,
      );
    } finally {
      console.error = realError;
      _setSyncLoaderForTest(null);
      _rejectAllPending(new Error("test teardown"));
      _resetEnsured();
      _resetBrowserSync();
      _resetCellRegistry();
      _resetSignals();
      await closeWindow(win);
    }
  },
});
