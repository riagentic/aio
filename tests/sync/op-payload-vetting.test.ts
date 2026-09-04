// A CRDT op carries its payload across the SAME JSON wire every other frame
// uses, and it was the only door with no guard on it.
//
// Two consequences, both silent in their own way:
//
//  • A value JSON cannot carry (a BigInt, a cycle) was accepted into the op
//    buffer. `saveOp`'s localStorage write then failed with the quota-shaped
//    message ("unsent changes will NOT survive a reload"), which blames the
//    browser for the app's value; `enc` threw again on the send; and the op sat
//    in the buffer being retried on every reconnect for the life of the app.
//  • A value JSON CHANGES (a Date → an ISO string, a Map → `{}`) diverged the
//    two views of the same edit: the local method already ran with the real
//    Date, while the op that is replayed after a reload carries the string. The
//    optimistic view and the durable one disagree, and only the second one
//    survives.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import { createOpBuffer } from "../../src/sync/op-buffer.ts";
import { createMemoryStorage } from "./_memory-storage.ts";
import { setDevModeOverride } from "../../src/state/dev-flag.ts";
import { _resetActionWarnings } from "../../src/state/action-encode.ts";
import { getLogger, setLogger } from "../../src/diagnostics/logger-api.ts";

function setup() {
  const sent: { t: string; d: Record<string, unknown> }[] = [];
  const storage = createMemoryStorage();
  const confirmed: Record<string, Record<string, unknown>> = { todos: {} };
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { todos: normalizeSyncConfig(true) },
    buffer: createOpBuffer(storage),
    send: (msg: string) => sent.push(JSON.parse(msg)),
    reducer: (state) => state,
    getConfirmedState: () => confirmed,
    setConfirmedState: (cell, state) => {
      confirmed[cell] = state as Record<string, unknown>;
    },
    onStateUpdate: () => {},
  });
  return { engine, sent, storage };
}

Deno.test("sync op: a payload JSON cannot carry never enters the buffer", async () => {
  const { engine, sent, storage } = setup();
  const err = await engine.handleLocalAction("todos", "add", { n: 10n })
    .then(() => null, (e: unknown) => e as Error);
  assert(err instanceof Error, "the caller's promise must reject");
  assertStringIncludes(err.message, "todos:add");
  assertStringIncludes(err.message, "BigInt");

  assertEquals(sent, [], "nothing went on the wire");
  assertEquals(
    await storage.loadOps("todos"),
    [],
    "and nothing was buffered — a buffered op is retried on every reconnect",
  );

  // The engine is still usable: the refusal is about that one call.
  await engine.handleLocalAction("todos", "add", { text: "ok" });
  assertEquals(sent.length, 1, "the next op goes out normally");
});

Deno.test("sync op: dev names a value the wire will change under the app", async () => {
  _resetActionWarnings();
  setDevModeOverride(true);
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, m: string) => {
        if (lvl === "warn") seen.push(m);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    const { engine } = setup();
    await engine.handleLocalAction("todos", "due", { at: new Date(0) });
    assertEquals(seen.length, 1, `expected one warning: ${seen.join("|")}`);
    assertStringIncludes(seen[0]!, "todos:due");
    assertStringIncludes(seen[0]!, "Date → string");
  } finally {
    setLogger(prev);
    setDevModeOverride(null);
  }
});
