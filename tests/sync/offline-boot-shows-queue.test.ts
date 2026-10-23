// tests/sync/offline-boot-shows-queue.test.ts — a page that boots OFFLINE
// shows the unsent changes a previous page load queued.
//
// Measured in headless Chromium through a proxy that refused the socket (a
// PWA opened from its cache, a reload on dropped Wi-Fi): five changes made
// offline, then a reload — the view came up without any of them, and stayed
// so until the next local call or a reconnect. The queue was intact in
// localStorage; only the catch-up's rebase ever painted it, and offline no
// catch-up is sent.
import { assertEquals } from "@std/assert";
import { createSyncEngine } from "../../src/sync/sync-engine.ts";
import {
  createMemoryStorage,
  createOpBuffer,
} from "../../src/sync/op-buffer.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";

const CELL = "notes";
type S = Record<string, unknown>;

function boot(storage: ReturnType<typeof createMemoryStorage>) {
  let confirmed: S = { items: [] };
  let view: S | undefined;
  const engine = createSyncEngine({
    clientId: "c1",
    cells: { [CELL]: normalizeSyncConfig(true) },
    buffer: createOpBuffer(storage),
    send: () => {},
    reducer: (s, action, payload) =>
      action === "add"
        ? { items: [...(s.items as string[]), payload as string] }
        : s,
    getConfirmedState: () => ({ [CELL]: confirmed }),
    setConfirmedState: (_c, s) => {
      confirmed = s;
    },
    onStateUpdate: (_c, s) => {
      view = s;
    },
  });
  return { engine, view: () => view };
}

Deno.test("an offline boot paints the queue the previous page load left", async () => {
  const storage = createMemoryStorage();
  // Page load 1, offline: two changes queued, never sent.
  const one = boot(storage);
  one.engine.setOnline(false);
  await one.engine.handleLocalAction(CELL, "add", "a");
  await one.engine.handleLocalAction(CELL, "add", "b");
  assertEquals(one.view(), { items: ["a", "b"] });
  one.engine.dispose();

  // Page load 2 — what initBrowserSync does: boot request first, then the
  // transport reports the socket that never opened.
  const two = boot(storage);
  const boot2 = two.engine.requestSync();
  two.engine.setOnline(false);
  await boot2;
  assertEquals(two.view(), { items: ["a", "b"] }, "the queue is on screen");
  assertEquals(two.engine.getStatus(CELL).pending, 2);

  // …and a boot that knew it was offline from the start, the same.
  const three = boot(storage);
  three.engine.setOnline(false);
  await three.engine.requestSync();
  assertEquals(three.view(), { items: ["a", "b"] });
  two.engine.dispose();
  three.engine.dispose();
});
