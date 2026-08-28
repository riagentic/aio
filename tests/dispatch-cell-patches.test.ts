// Perf audit P8: persistence used to clone-and-diff a whole `db:` table per
// debounce window to find ONE changed row, although the Immer patches the
// reducer produced already named it. The dispatch/commit path now hands the
// batch's patches — grouped per cell, in commit order, unfiltered — to
// `schedulePersist`, in the shape `CellPatches` documents.
import { assert, assertEquals } from "@std/assert";
import {
  type CellPatches,
  groupCellPatches,
  setupDispatch,
} from "../src/server/aio-dispatch.ts";

const noop = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

Deno.test("dispatch: groupCellPatches groups per cell in commit order and drops empty entries", () => {
  const g = groupCellPatches([
    {
      cell: "users",
      ops: [{ op: "replace", path: ["u1", "name"], value: "a" }],
    },
    { cell: "posts", ops: [] },
    { cell: "users", ops: [{ op: "add", path: ["u2"], value: {} }] },
  ]);
  assertEquals([...g.keys()], ["users"], "a cell with no ops was not written");
  assertEquals(g.get("users")!.map((p) => p.path), [["u1", "name"], ["u2"]]);
});

Deno.test("dispatch: onDone hands persistence the batch's per-cell patches, grouped by cell", async () => {
  type S = { users: { rows: Record<string, { name: string }> } };
  let state: S = { users: { rows: { u1: { name: "a" }, u2: { name: "b" } } } };
  const persisted: (CellPatches | undefined)[] = [];
  const dispatch = setupDispatch<S, { type: string; row: string }, never>({
    // What a cell reducer returns: the next state plus the Immer patches the
    // write produced — the same side-channel the main runtime reads.
    reduce: (s, a) => {
      const next = {
        users: { rows: { ...s.users.rows, [a.row]: { name: a.type } } },
      };
      return Object.assign({ state: next, effects: [] }, {
        patches: {
          cell: "users",
          ops: [{
            op: "replace",
            path: ["rows", a.row, "name"],
            value: a.type,
          }],
        },
      });
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    getApp: () => ({}),
    getServer: () => ({ broadcast: () => {}, broadcastTT: () => {} }),
    scheduleManager: { handle: () => {} },
    ownManager: { handle: () => {} },
    schedulePersist: (cp) => persisted.push(cp),
    getTT: () => null,
    setTT: () => {},
    reportOpts: {},
    freezeState: false,
    log: noop,
    debug: false,
  });
  await dispatch({ type: "rename", row: "u1" });
  assertEquals(persisted.length, 1, "one persist request per batch");
  const cp = persisted[0]!;
  assert(cp instanceof Map, "CellPatches is a Map");
  assertEquals([...cp.keys()], ["users"]);
  // The row is addressable from the path — no table diff needed.
  assertEquals(cp.get("users")![0]!.path, ["rows", "u1", "name"]);

  // Each batch gets its own fresh map — never a shared, mutated one.
  await dispatch({ type: "y", row: "u2" });
  assertEquals(persisted.length, 2);
  assert(persisted[1] !== cp, "a fresh map per batch");
  assertEquals(
    cp.get("users")!.length,
    1,
    "the first batch's map is untouched",
  );
  assertEquals(persisted[1]!.get("users")![0]!.path[1], "u2");
});
