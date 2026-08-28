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
//
// The property this file now pins is CHANNEL-WIDE, not strategy-wide: a
// per-user filter must not be bypassed by ANY path that reaches a socket —
// the patch strategy, a filter that THROWS, the getUIState memo, or CRDT sync.
// Each of those was a separate hole; each one below is the wire-level proof.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { createMemoizedUIState } from "../src/server/aio-run-helpers.ts";
import { filterPatchesByStrategy } from "../src/state/state-filter.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";
import type { AioUser } from "../src/server/aio-types.ts";

type Order = { id: string; owner: string; note: string };

function fakeClient(
  id: string,
  // Deliberately open: `resolveUser` returns whatever the app's user record is,
  // and `forUser` sees all of it (which is exactly what the memo bug got wrong).
  user: { id: string; role: string; [k: string]: unknown },
): {
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
    visible: {
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

// ── Channel 2: a filter that THROWS ───────────────────────────────────────
//
// The filter was wrapped in a try/catch that logged and fell back to "the
// structural filter". With `ui: { forUser }` alone — now a first-class shape —
// the structural filter IS THE WHOLE CELL, so the fallback broadcast every
// tenant's rows to whoever tripped it. And tripping it is trivial: a missing
// field on one user's record, `user === undefined` on a public/UDS connection,
// a null row. One ERROR line in the log, and the data ships anyway.
//
// A filter that could not run has decided nothing. Fail CLOSED: send nothing
// for that cell.
Deno.test("forUser: a filter that throws sends NOTHING for that cell (fail closed)", async () => {
  _resetAioRuntime();
  type Row = { id: string; org: string; body: string };
  const orgs = cell("tenant-orders", {
    state: { rows: [] as Row[] },
    visible: {
      // The exact shape of the exploit: it reads a field that not every user
      // record carries, so it throws for u2 and only for u2.
      forUser: (s: { rows: Row[] }, user?: unknown) => ({
        rows: s.rows.filter((r) =>
          r.org === (user as { org: string }).org.toLowerCase()
        ),
      }),
    },
    methods: {
      add(s: { rows: Row[] }, r: Row) {
        s.rows.push(r);
      },
    },
  });
  const wiring = composeCellsWiring({
    // deno-lint-ignore no-explicit-any
    cellEntries: [{ cell: orgs as any }] as any,
  });

  const serverState = {
    "tenant-orders": {
      rows: [
        { id: "1", org: "acme", body: "acme-invoice" },
        { id: "2", org: "globex", body: "GLOBEX-CONFIDENTIAL" },
      ] as Row[],
    },
  };

  // u1's record has `org`; u2's does not — u2 authenticates normally.
  const a = fakeClient("c1", { id: "u1", role: "user", org: "ACME" });
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
  broadcaster.broadcast(
    filterPatchesByStrategy(
      [{
        cell: "tenant-orders",
        // deno-lint-ignore no-explicit-any
        ops: [
          {
            op: "add",
            path: ["rows", 1],
            value: serverState["tenant-orders"].rows[1],
          } as any,
        ],
      }],
      wiring.cellPatchStrategies,
      wiring.cellFilterFields,
    ),
  );
  await new Promise((r) => setTimeout(r, 40));
  broadcaster.shutdown();

  const toU2 = b.sent.join("|");
  assert(
    !toU2.includes("GLOBEX-CONFIDENTIAL"),
    `a throwing filter shipped another tenant's data:\n${toU2}`,
  );
  assert(
    !toU2.includes("acme-invoice") && !toU2.includes('"org"'),
    `a throwing filter shipped the unfiltered cell:\n${toU2}`,
  );
  // Not merely "no secrets" — the whole cell must be absent, because nothing
  // decided what u2 may see.
  for (const frame of b.sent) {
    const d = JSON.parse(frame).d;
    const state = typeof d === "string" ? JSON.parse(d) : d;
    assertEquals(
      "tenant-orders" in (state as Record<string, unknown>),
      false,
      `the cell must be omitted entirely for a client whose filter threw: ${frame}`,
    );
  }
  // …and one broken filter must not mute the client that IS filterable.
  assert(
    a.sent.join("|").includes("acme-invoice"),
    "u1's filter ran fine — u1 must still receive their own rows",
  );
  _resetAioRuntime();
});

// ── Channel 3: the getUIState memo ────────────────────────────────────────
//
// The memo was keyed on `user.id` alone and invalidated only when the state REF
// changed — but `forUser` is handed the WHOLE user object. `resolveUser` can
// return {id:"alice", role:"admin"} for one token and {id:"alice",
// role:"viewer"} for another (impersonation, a re-issued session, a second
// device with narrower scope). Admin connects, viewer connects, no dispatch in
// between → the viewer was served the admin's view straight out of the cache.
Deno.test("forUser memo: same id, different role — no view is ever reused", () => {
  let calls = 0;
  const raw = (s: { secrets: string[] }, user?: AioUser) => {
    calls++;
    return {
      secrets: user?.role === "admin" ? s.secrets : [],
      seenBy: user?.id ?? "anonymous",
    };
  };
  const memo = createMemoizedUIState(raw);
  const state = { secrets: ["TOP-SECRET"] };

  const admin = memo(state, { id: "alice", role: "admin" }) as {
    secrets: string[];
  };
  const viewer = memo(state, { id: "alice", role: "viewer" }) as {
    secrets: string[];
  };
  assertEquals(admin.secrets, ["TOP-SECRET"]);
  assertEquals(
    viewer.secrets,
    [],
    "the viewer received the admin's cached view — same id, different role",
  );

  // The user-LESS caller (UDS, trojan, an anonymous socket) had its own bucket
  // keyed "" — shared with any user whose id was empty.
  const anon = memo(state, undefined) as { secrets: string[]; seenBy: string };
  assertEquals(anon.secrets, []);
  assertEquals(anon.seenBy, "anonymous");
  const emptyId = memo(
    state,
    { id: "", role: "admin" },
  ) as { secrets: string[]; seenBy: string };
  assertEquals(
    emptyId.secrets,
    ["TOP-SECRET"],
    "a user with an empty id must not collide with the no-user bucket",
  );

  // An in-place role change on a live connection's user object invalidates too.
  const live = { id: "bob", role: "admin" };
  assertEquals((memo(state, live) as { secrets: string[] }).secrets, [
    "TOP-SECRET",
  ]);
  live.role = "viewer";
  assertEquals(
    (memo(state, live) as { secrets: string[] }).secrets,
    [],
    "the user object was downgraded in place — the cached view is stale",
  );

  // …and the memo still memoizes: the whole point is that forUser runs per
  // client per broadcast, so an identical user must NOT recompute.
  const before = calls;
  memo(state, { id: "alice", role: "viewer" });
  memo(state, { role: "viewer", id: "alice" }); // key order is irrelevant
  assertEquals(calls, before, "an identical user must hit the cache");
  // A new state ref invalidates everything, as before.
  memo({ secrets: ["TOP-SECRET"] }, { id: "alice", role: "viewer" });
  assertEquals(calls, before + 1);
});

// ── Channel 4: CRDT sync ──────────────────────────────────────────────────
//
// `sync: true` broadcasts ONE op frame to every other socket, payload verbatim,
// and a catch-up snapshot ships the cell's state. There is no per-user variant
// and there cannot be one: peers that receive different ops do not converge,
// and an op is an opaque {cell, action, payload} with no user dimension to
// filter on. So a cell that is both replicated and per-user-filtered is a
// contradiction — the framework refuses it by name instead of silently
// replicating private data.
Deno.test("sync + a hiding ui filter is refused at compose, by name", () => {
  const shapes: { label: string; ui: unknown }[] = [
    { label: "forUser", ui: { forUser: (s: never) => s } },
    {
      label: "forUser + include",
      ui: { include: ["a"], forUser: (s: never) => s },
    },
    { label: "include", ui: { include: ["a"] } },
    { label: "exclude", ui: { exclude: ["b"] } },
    { label: '"none"', ui: "none" },
  ];
  let n = 0;
  for (const { label, ui } of shapes) {
    _resetAioRuntime();
    const id = `sync-filtered-${n++}`;
    const c = cell(id, {
      state: { a: 1, b: "secret" },
      // deno-lint-ignore no-explicit-any
      visible: ui as any,
      sync: true,
      methods: {
        bump(s: { a: number }) {
          s.a++;
        },
      },
    });
    const err = assertThrows(
      // deno-lint-ignore no-explicit-any
      () => composeCellsWiring({ cellEntries: [c] as any }),
      Error,
      undefined,
      `${label}: a replicated cell with a ui filter must be refused`,
    );
    assert(
      err.message.includes(id),
      `${label}: the refusal must name the cell — got: ${err.message}`,
    );
    assert(
      /sync/i.test(err.message) && /visible/i.test(err.message),
      `${label}: the refusal must name the conflict — got: ${err.message}`,
    );
  }
  _resetAioRuntime();
});

Deno.test("sync without a hiding ui filter still composes (the refusal is not a blanket ban)", () => {
  _resetAioRuntime();
  const c = cell("sync-public", {
    state: { a: 1 },
    sync: true,
    methods: {
      bump(s: { a: number }) {
        s.a++;
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  const wiring = composeCellsWiring({ cellEntries: [c] as any });
  assertEquals(wiring.cellPatchStrategies.get("sync-public"), "raw");
  _resetAioRuntime();
});

// localFirst adopts every server cell into sync — one flag that would otherwise
// convert a filtered cell into a fully-replicated one behind the author's back.
// Implicit adoption must DECLINE (and say so), not throw: the author never
// asked for this cell to sync.
Deno.test("localFirst never adopts a per-user-filtered cell into sync", () => {
  _resetAioRuntime();
  const priv = cell("lf-private", {
    state: { rows: [] as { owner: string }[] },
    visible: {
      forUser: (s: { rows: { owner: string }[] }, u?: { id?: string }) => ({
        rows: s.rows.filter((r) => r.owner === u?.id),
      }),
    },
    methods: {
      add(s: { rows: { owner: string }[] }, r: { owner: string }) {
        s.rows.push(r);
      },
    },
  });
  const pub = cell("lf-public", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  const { composed } = composeCellsWiring({
    // deno-lint-ignore no-explicit-any
    cellEntries: [priv, pub] as any,
    localFirst: true,
  });
  const byId = new Map(composed.cells.map((c) => [c.__aio.id, c.__aio]));
  assertEquals(
    byId.get("lf-private")!.syncConfig,
    undefined,
    "a forUser cell must stay server-authoritative under localFirst",
  );
  assert(
    byId.get("lf-public")!.syncConfig,
    "…while unfiltered cells are still adopted — localFirst is not disabled",
  );
  _resetAioRuntime();
});

Deno.test("forUser: a filter that returns nothing omits the cell too", () => {
  // A missing `return` in a braced arrow body is the everyday way to get here.
  // It is the same failure as a throw — the filter decided nothing — so it gets
  // the same answer, not a silently unfiltered slice.
  _resetAioRuntime();
  const c = cell("no-return-filter", {
    state: { rows: ["PRIVATE"] },
    // deno-lint-ignore no-explicit-any
    visible: { forUser: (() => {}) as any },
    methods: { noop() {} },
  });
  // deno-lint-ignore no-explicit-any
  const wiring = composeCellsWiring({ cellEntries: [c] as any });
  const ui = wiring.autoGetUIState!(
    { "no-return-filter": { rows: ["PRIVATE"] } },
    { id: "u1", role: "user" },
  ) as Record<string, unknown>;
  assertEquals("no-return-filter" in ui, false);
  _resetAioRuntime();
});
