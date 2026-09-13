// `merge: { x: "counter" }` must be right for an INCREMENT-style method too.
//
// `mergeField` was handed the POST-rebase view as `local`. Rebase has already
// replayed the local op on top of the NEW confirmed state — so for a reducer
// that increments (`s.n += by`, which is what the browser cell stub builds
// from `methods: { inc(s, by) { s.n += by } }`), that value already contains
// the remote delta. `mergeCounter` then adds it a second time:
//
//   base + localΔ + 2·remoteΔ
//
// Measured: base 0, a local +1 and a peer +1 produced a client view of 3, and
// the conflict record said `local: 2` — the correct answer, which the merge
// then spoiled. Declaring the strategy made the view WORSE than leaving it at
// the `lww` default. `docs/persistence/crdt.md` documents exactly this shape
// ("Base: 10, A +5, B +8 → 23") and grades `counter` "Conflict-free: Yes".
//
// The existing engine test pins an ASSIGNING reducer (`set {n:5}`), which is
// the one shape where the post-rebase value happens to be right — so the
// wrong answer had a green suite. The PRE-rebase view is correct for both,
// and this file pins the pair.
import { assertEquals } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import type { SyncConflict } from "../../src/sync/types.ts";

const CELL = "doc";

function rig(reducerKind: "increment" | "assign") {
  let confirmed: Record<string, unknown> = { count: 0 };
  const views: Record<string, unknown>[] = [];
  const conflicts: SyncConflict[] = [];
  const engine = createSyncEngine({
    clientId: "A",
    cells: {
      [CELL]: {
        merge: { count: "counter" },
        identity: {},
        offline: { retention: "4h" },
        onConflict: (c: SyncConflict[]) => conflicts.push(...c),
      } as never,
    },
    buffer: createOpBuffer(createMemoryStorage()),
    send: () => {},
    reducer: (state, action, payload) => {
      if (action !== "bump") return null;
      const by = payload as number;
      return reducerKind === "increment"
        ? { ...state, count: (state.count as number) + by }
        : { ...state, count: by };
    },
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_cell, s) => {
      confirmed = s;
    },
    onStateUpdate: (_cell, o) => views.push(o),
  });
  return { engine, views, conflicts };
}

Deno.test("counter merge: an INCREMENT reducer counts each delta once", async () => {
  const { engine, views, conflicts } = rig("increment");
  engine.setOnline(true);
  try {
    await engine.handleLocalAction(CELL, "bump", 1); // me: +1
    await engine.handleRemoteOp({
      id: "PEER-1",
      cell: CELL,
      action: "bump",
      payload: 1, // peer: +1, concurrently
      hlc: [Date.now() + 5, 0, "B"],
      confirmed: true,
      serverTs: 1,
    });
    assertEquals(
      views[views.length - 1]!.count,
      2,
      "my +1 and the peer's +1 — the remote delta must not be added twice",
    );
    assertEquals(conflicts[0]?.resolution, "counter");
  } finally {
    engine.setOnline(false);
  }
});

Deno.test("counter merge: an ASSIGNING reducer still merges both deltas", async () => {
  const { engine, views, conflicts } = rig("assign");
  engine.setOnline(true);
  try {
    await engine.handleLocalAction(CELL, "bump", 5); // local: 0 → 5
    await engine.handleRemoteOp({
      id: "PEER-2",
      cell: CELL,
      action: "bump",
      payload: 3, // remote: 0 → 3, concurrently
      hlc: [Date.now() + 5, 0, "B"],
      confirmed: true,
      serverTs: 1,
    });
    assertEquals(
      views[views.length - 1]!.count,
      8,
      "base 0, local delta +5, remote delta +3 — the documented shape",
    );
    assertEquals(conflicts[0]?.resolution, "counter");
  } finally {
    engine.setOnline(false);
  }
});

// The other half of the same missing value: "did local override this field?"
// was a REFERENCE compare, and `rebase` structuredClones the whole confirmed
// state — so once any local op was pending, every object/array field had a
// fresh identity and could never compare equal. `onConflict` fired for fields
// the client had never touched, with `local` deep-equal to `remote`, and
// `SyncStats.conflicts` was inflated by one per such field per remote op.
Deno.test("conflicts: a field the client never touched is not a conflict", async () => {
  let confirmed: Record<string, unknown> = { title: "", items: ["a"] };
  const conflicts: SyncConflict[] = [];
  const engine = createSyncEngine({
    clientId: "A",
    cells: {
      [CELL]: {
        merge: {},
        identity: {},
        offline: { retention: "4h" },
        onConflict: (c: SyncConflict[]) => conflicts.push(...c),
      } as never,
    },
    buffer: createOpBuffer(createMemoryStorage()),
    send: () => {},
    reducer: (state, action, payload) => {
      if (action === "title") return { ...state, title: payload };
      if (action === "append") {
        return { ...state, items: [...(state.items as string[]), payload] };
      }
      return null;
    },
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_cell, s) => {
      confirmed = s;
    },
    onStateUpdate: () => {},
  });
  engine.setOnline(true);
  try {
    // The client edits ONLY `title`.
    await engine.handleLocalAction(CELL, "title", "mine");
    // A peer appends to `items`, which the client never touched.
    await engine.handleRemoteOp({
      id: "PEER-3",
      cell: CELL,
      action: "append",
      payload: "b",
      hlc: [Date.now() + 5, 0, "B"],
      confirmed: true,
      serverTs: 1,
    });
    assertEquals(
      conflicts.map((c) => c.field),
      [],
      "an app that shows a 'resolve this conflict' prompt would present two " +
        "identical options for a change nobody made: " +
        JSON.stringify(conflicts),
    );
  } finally {
    engine.setOnline(false);
  }
});
