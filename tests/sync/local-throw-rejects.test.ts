// tests/sync/local-throw-rejects.test.ts — a sync method that throws must
// reject its caller, exactly as the same method on a plain cell does.
//
// The engine queued the op, rebased (where the reducer threw and the failure
// was only logged as a replay problem), SENT it — the server's dispatch then
// threw too — and resolved: `await notes.add(x)` reported success for a change
// that was never going to exist. One method, two answers, decided by whether
// the cell had `sync: true`.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { REDUCER_FAILED } from "../../src/sync/rebase.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

Deno.test("a sync method that throws rejects the call, is not queued and is not sent", async () => {
  let view: Record<string, unknown> = { items: [] };
  const sent: string[] = [];
  const buffer = createOpBuffer(createMemoryStorage());
  const boom = new Error("title is required");
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { notes: normalizeSyncConfig(true) },
    buffer,
    send: (m) => sent.push(m),
    reducer: (s, action, payload) =>
      action === "add" && payload === ""
        ? REDUCER_FAILED
        : { items: [...(s.items as string[]), payload as string] },
    lastReducerError: () => boom,
    getConfirmedState: () => ({ notes: { items: [] } }),
    setConfirmedState: () => {},
    onStateUpdate: (_c, s) => {
      view = s;
    },
  });
  const origError = console.error;
  console.error = () => {};
  try {
    await engine.handleLocalAction("notes", "add", "ok");
    const err = await assertRejects(
      () => engine.handleLocalAction("notes", "add", ""),
      Error,
      "title is required",
    );
    assert(err === boom, "the method's own error, as a plain cell rejects");
  } finally {
    console.error = origError;
    engine.dispose();
  }
  assertEquals(
    (await buffer.getUnconfirmed("notes")).map((o) => o.payload),
    ["ok"],
    "the failed call left nothing in the offline queue",
  );
  assertEquals(sent.length, 1, "only the good op went out");
  assertEquals(view.items, ["ok"], "the view is the good op alone");
  assertEquals(engine.getStatus("notes").pending, 1);
});
