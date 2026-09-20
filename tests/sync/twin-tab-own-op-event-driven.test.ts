// An own op that left the shared queue is noticed at the next EVENT on the
// cell, not only at the next catch-up.
//
// Two tabs of one app share the offline queue, so tab B can flush tab A's op,
// get the ack and confirm it in the shared document before A hears anything.
// A's ack goes to B's socket; A's own broadcast comes back echo-suppressed
// (`isOwnSessionOp`); and the server never replays a requester's own session's
// ops into its catch-ups. So A must NOTICE that one of its ops left the queue —
// `_ownInFlight` — and ask for the cell.
//
// It did, in `requestSync` and nowhere else. A tab that stays connected has no
// reason to call it: there is no periodic catch-up, and the watchdog only arms
// behind a held frame. So A's confirmed state was missing its OWN change, its
// screen showed a state the server never had, and it stayed that way through
// every peer op that arrived afterwards — until a reconnect, which may be
// hours away or never. Frames kept flowing; the divergence was permanent and
// silent.
//
// The check belongs where the engine already reads the queue (every rebase),
// so the next thing that happens on the cell repairs it. The fully idle tab —
// no frames at all — still waits for a reconnect: a `storage`-event listener
// is the only thing that would cover it, and that is browser-only machinery
// this harness cannot prove.
import { assertEquals } from "@std/assert";
import { createNet, type State } from "./_net.ts";
import { createLocalStorageOpStorage } from "../../src/sync/browser-storage.ts";

function shimLocalStorage(): void {
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
}

const apply = (s: State, _a: string, p: unknown): State => ({
  items: [...((s.items as string[]) ?? []), p as string],
});

Deno.test("twin tabs: a peer op repairs the tab whose op the other tab flushed", async () => {
  shimLocalStorage();
  const net = createNet({ cell: "c", initial: () => ({ items: [] }), apply });
  // Two tabs of one profile on one queue, plus a peer on its own.
  const a = net.addClient("tab", createLocalStorageOpStorage("q"));
  const b = net.addClient("tab", createLocalStorageOpStorage("q"));
  const peer = net.addClient("peer");
  try {
    for (const c of [a, b, peer]) await c.engine.requestSync();
    await net.pump();
    await peer.engine.handleLocalAction("c", "add", "s0");
    await net.pump();
    for (const c of [a, b, peer]) await c.engine.requestSync();
    await net.pump();

    // A makes a change whose own frame dies on the way out…
    await a.engine.handleLocalAction("c", "add", "x");
    a.outbox.length = 0;
    // …and B's catch-up carries the shared queue, so the server gets it.
    await b.engine.requestSync();
    await net.pump();
    assertEquals(net.live(), { items: ["s0", "x"] }, "the server has A's op");
    assertEquals(
      a.confirmed(),
      { items: ["s0"] },
      "A has not folded it — its ack went to B's socket",
    );

    // A stays connected and never calls requestSync. The next thing that
    // happens on the cell is a peer's change.
    await peer.engine.handleLocalAction("c", "add", "y");
    await net.pump();

    assertEquals(a.confirmed(), net.live(), "A's confirmed state is repaired");
    assertEquals(a.view(), net.live(), "…and so is A's screen");
    assertEquals(b.view(), net.live());
    assertEquals(peer.view(), net.live());
  } finally {
    await net.close();
  }
});
