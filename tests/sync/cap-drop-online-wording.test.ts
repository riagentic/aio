// tests/sync/cap-drop-online-wording.test.ts — a full queue on a CONNECTED
// client is named for what it is.
//
// A burst of calls (a seed, an import) faster than acks return fills the queue
// while the socket is up — sending is paced. The refusal told the developer
// "the client has not reached the server in a long time … check
// connectivity" and "Reconnect": a false lead, on a client that was online.
import { assert, assertRejects } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
  dropReport,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

Deno.test("a connected burst past the cap is refused as a burst, not as lost connectivity", async () => {
  let confirmed: Record<string, unknown> = { n: 0 };
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { c: normalizeSyncConfig({}) },
    buffer: createOpBuffer(createMemoryStorage(), {
      pendingCap: 3,
      onDrop: () => {},
    }),
    send: () => {},
    reducer: (s) => ({ n: (s.n as number) + 1 }),
    getConfirmedState: () => ({ c: confirmed }),
    setConfirmedState: (_c, s) => void (confirmed = s),
    onStateUpdate: () => {},
    catchupTimeoutMs: 1e9,
    log: { warn: () => {} },
  });
  try {
    for (let i = 0; i < 3; i++) await engine.handleLocalAction("c", "inc", i);
    const e = await assertRejects(() =>
      engine.handleLocalAction("c", "inc", 3)
    );
    const msg = (e as Error).message;
    assert(!/Reconnect/.test(msg), msg);
    assert(/faster than acks/.test(msg), msg);
  } finally {
    engine.dispose();
  }
  const { hint } = dropReport("prune-failed");
  assert(!/has not reached the server/.test(hint), hint);
  assert(/faster than acks/.test(hint), hint);
});
