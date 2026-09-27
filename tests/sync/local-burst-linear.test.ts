// tests/sync/local-burst-linear.test.ts — a burst of local calls folds each
// call once, not the whole queue again per call.
//
// Every local call rebased the ENTIRE pending queue onto confirmed state, so
// a 500-call burst (a seed, an import) while offline — or faster than acks
// come back — was 125,250 reducer calls: with the browser's Immer reducer
// (run twice per fold to check determinism) the page froze for ~3 s.
import { assertEquals } from "@std/assert";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

Deno.test("a 500-call offline burst runs the reducer once per call, and the view holds every call", async () => {
  let calls = 0;
  let confirmed: Record<string, unknown> = { items: [] };
  let view: Record<string, unknown> = {};
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { c: normalizeSyncConfig({}) },
    buffer: createOpBuffer(createMemoryStorage()),
    send: () => {},
    reducer: (s, _a, p) => {
      calls++;
      return { items: [...(s.items as number[]), p as number] };
    },
    getConfirmedState: () => ({ c: confirmed }),
    setConfirmedState: (_c, s) => void (confirmed = s),
    onStateUpdate: (_c, s) => void (view = s),
    catchupTimeoutMs: 1e9,
    log: { warn: () => {} },
  });
  engine.setOnline(false);
  const n = 500;
  await Promise.all(
    Array.from(
      { length: n },
      (_, i) => engine.handleLocalAction("c", "add", i),
    ),
  );
  engine.dispose();
  assertEquals(view.items, Array.from({ length: n }, (_, i) => i));
  assertEquals(calls, n);
});
