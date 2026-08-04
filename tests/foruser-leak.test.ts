// A per-user filter must survive the wire, not just the full-state frame.
//
// Field report (dm #1, rated the report's highest severity — "a privacy hole
// with no symptom at the call site"): a relay declared
//
//     ui: { forUser: (s, user) => viewFor(s, user) }
//
// and clients received a view that was internally inconsistent — one field
// reflected the filter, another was stale. `ui: { forUser }` with no
// include/exclude classified as the `raw` patch strategy, so every broadcast
// sent Immer patches computed from UNFILTERED server state, narrowed only by
// subscriptions. `forUser` guarded the initial/full frame and nothing else.
//
// Two distinct failures, both silent:
//   1. LEAK — another user's data reaches a client whose filter removed it.
//   2. CORRUPTION — raw ops carry raw ARRAY INDICES, but the client's array was
//      shortened by forUser, so rows land at the wrong index. That is the
//      "one field filtered, another stale" symptom the reporter chased for
//      hours before suspecting the strategy.
//
// tests/defaults-ui.test.ts pins the CLASSIFICATION property (forUser is never
// broadcast through a strategy that cannot apply it). This file pins the
// CONSEQUENCE at the wire, with two clients and a real broadcaster — the leak
// the reporter could only infer.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { filterPatchesByStrategy } from "../src/state/state-filter.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

type Order = { id: string; owner: string; note: string };

function fakeClient(id: string, user: { id: string; role: string }): {
  ws: WebSocket;
  meta: ClientMeta;
  sent: string[];
} {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send(msg: string) {
      sent.push(msg);
    },
  } as unknown as WebSocket;
  const meta = {
    id,
    index: 0,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
    user,
  } as unknown as ClientMeta;
  return { ws, meta, sent };
}

/** The cell under test: every client may see only its OWN orders. */
function ordersCell() {
  return cell("orders", {
    state: { items: [] as Order[], note: "" },
    ui: {
      forUser: (
        s: { items: Order[]; note: string },
        user?: { id?: string },
      ) => ({
        ...s,
        items: s.items.filter((o) => o.owner === user?.id),
      }),
    },
    methods: {
      add(s: { items: Order[] }, o: Order) {
        s.items.push(o);
      },
    },
  });
}

Deno.test("forUser: another user's row never reaches the wire", async () => {
  const orders = ordersCell();
  const wiring = composeCellsWiring({
    // deno-lint-ignore no-explicit-any
    cellEntries: [{ cell: orders as any }] as any,
  });
  assertEquals(
    wiring.cellPatchStrategies.get("orders"),
    "full",
    "precondition: a forUser cell must not be on the raw patch path",
  );

  // Server truth: u1 owns one order, u2 owns another (with a distinctive
  // secret in it, so a leak is unmistakable in the sent bytes).
  const serverState = {
    orders: {
      items: [
        { id: "a", owner: "u1", note: "u1-own-note" },
        { id: "b", owner: "u2", note: "U2-PRIVATE-NOTE" },
      ] as Order[],
      note: "",
    },
  };

  const a = fakeClient("c1", { id: "u1", role: "user" });
  const b = fakeClient("c2", { id: "u2", role: "user" });
  const connections = new Map<WebSocket, ClientMeta>();
  connections.set(a.ws, a.meta);
  connections.set(b.ws, b.meta);

  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: (user?: unknown) => wiring.autoGetUIState!(serverState, user),
    debug: () => {},
    syncIntervalMs: 10,
  });

  // u2's order is appended — a raw Immer op naming index 1 of the SERVER array.
  const patches: PatchEntry[] = [{
    cell: "orders",
    ops: [{
      op: "add",
      path: ["items", 1],
      value: { id: "b", owner: "u2", note: "U2-PRIVATE-NOTE" },
      // deno-lint-ignore no-explicit-any
    } as any],
  }];

  broadcaster.broadcast(
    filterPatchesByStrategy(
      patches,
      wiring.cellPatchStrategies,
      wiring.cellFilterFields,
    ),
  );
  await new Promise((r) => setTimeout(r, 40));
  broadcaster.shutdown();

  const toU1 = a.sent.join("|");
  assert(toU1.length > 0, "u1 must receive something");
  assert(
    !toU1.includes("U2-PRIVATE-NOTE"),
    `u1 received another user's data — the per-user filter was bypassed:\n${toU1}`,
  );
  assert(
    !toU1.includes('"owner":"u2"'),
    `u1 received a row owned by u2:\n${toU1}`,
  );
  // …and u1 still gets their OWN data: the filter narrows, it does not mute.
  assert(
    toU1.includes("u1-own-note"),
    `u1 must still receive their own row:\n${toU1}`,
  );
  // u2 sees theirs, and not u1's.
  const toU2 = b.sent.join("|");
  assert(
    toU2.includes("U2-PRIVATE-NOTE"),
    `u2 must receive their own row:\n${toU2}`,
  );
  assert(
    !toU2.includes("u1-own-note"),
    `u2 received a row owned by u1:\n${toU2}`,
  );
});

Deno.test("forUser: indices are never applied against a filtered array", async () => {
  // The corruption half. A raw op says "insert at index 1", but u1's filtered
  // array has ONE element, so applying it verbatim would place the row at the
  // wrong position (or leave a hole). Under `full` there are no index-bearing
  // ops on the wire at all — the client is sent whole, already-filtered state.
  const orders = ordersCell();
  const wiring = composeCellsWiring({
    // deno-lint-ignore no-explicit-any
    cellEntries: [{ cell: orders as any }] as any,
  });
  const serverState = {
    orders: {
      items: [
        { id: "a", owner: "u2", note: "n0" },
        { id: "b", owner: "u2", note: "n1" },
        { id: "c", owner: "u1", note: "mine" },
      ] as Order[],
      // Padding is load-bearing: the broadcaster falls back to full state when
      // a patch payload exceeds 50% of full state, so a TINY state would send
      // full frames even under `raw` and this test would pass against the very
      // bug it exists to catch (it did, before the pad).
      note: "z".repeat(4000),
    },
  };
  const a = fakeClient("c1", { id: "u1", role: "user" });
  const connections = new Map<WebSocket, ClientMeta>();
  connections.set(a.ws, a.meta);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: (user?: unknown) => wiring.autoGetUIState!(serverState, user),
    debug: () => {},
    syncIntervalMs: 10,
  });
  broadcaster.broadcast(
    filterPatchesByStrategy(
      [{
        cell: "orders",
        // index 2 — valid on the server's 3-element array, out of range on
        // u1's 1-element filtered view.
        // deno-lint-ignore no-explicit-any
        ops: [
          {
            op: "add",
            path: ["items", 2],
            value: { id: "c", owner: "u1", note: "mine" },
          } as any,
        ],
      }],
      wiring.cellPatchStrategies,
      wiring.cellFilterFields,
    ),
  );
  await new Promise((r) => setTimeout(r, 40));
  broadcaster.shutdown();

  const toU1 = a.sent.join("|");
  assert(
    !toU1.includes('"$p"') && !toU1.includes('"patches"'),
    `a forUser cell must not send index-bearing patch frames:\n${toU1}`,
  );
  assert(toU1.includes("mine"), `u1 must receive their own row:\n${toU1}`);
});
