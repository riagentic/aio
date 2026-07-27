// risoto 2026-07-26: an app entry that prepared its data directory before
// aio.run() stalled the worker handshake ("cell worker heavy did not become
// ready within 30000ms") — because a `worker: true` cell re-imports that very
// entry and redid the same work. isCellWorker() is how an app skips it.
import { assertEquals } from "@std/assert";
import {
  CELL_WORKER_PREFIX,
  isCellWorker,
} from "../src/server/cell-worker-protocol.ts";

Deno.test("isCellWorker: false on the main isolate, true under the worker name", () => {
  const g = globalThis as { name?: string };
  const original = g.name;
  try {
    g.name = "";
    assertEquals(isCellWorker(), false);
    g.name = `${CELL_WORKER_PREFIX}heavy`;
    assertEquals(isCellWorker(), true);
    g.name = "some-other-worker";
    assertEquals(isCellWorker(), false);
  } finally {
    g.name = original;
  }
});
