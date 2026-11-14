// Repro: after a reload with two queued edits of ONE field, the reconnect's
// catch-up reports the user's own first edit as a "remote op" colliding with
// their own second edit — onConflict fires with no other writer anywhere.
import { assertEquals } from "@std/assert";
import { createNet } from "./_net.ts";
import { createMemoryStorage } from "../../src/sync/op-buffer.ts";
import type { SyncConflict } from "../../src/sync/types.ts";

Deno.test("reload: own queued edits of one field are not a conflict", async () => {
  const conflicts: SyncConflict[] = [];
  const net = createNet({
    cell: "doc",
    initial: () => ({ title: "" }),
    apply: (s, action, p) => action === "setTitle" ? { ...s, title: p } : s,
    sync: { onConflict: (c) => conflicts.push(...c) },
  });
  try {
    const storage = createMemoryStorage();
    // Page load 1, offline: the user types "a" then "ab".
    const a = net.addClient("me", storage);
    a.online = false;
    a.engine.setOnline(false);
    await a.engine.handleLocalAction("doc", "setTitle", "a");
    await a.engine.handleLocalAction("doc", "setTitle", "ab");
    a.engine.dispose();
    // Page load 2 (reload), same identity and queue, comes online.
    const b = net.addClient("me", storage);
    await b.engine.requestSync();
    await net.pump();
    assertEquals(net.live().title, "ab", "server truth");
    assertEquals(b.view().title, "ab");
    assertEquals(
      conflicts,
      [],
      "no other writer exists — only this user's own two edits",
    );
  } finally {
    await net.close();
  }
});

Deno.test("twin tab: own op flushed by the other tab is not a conflict", async () => {
  const conflicts: SyncConflict[] = [];
  const net = createNet({
    cell: "doc",
    initial: () => ({ title: "" }),
    apply: (s, action, p) => action === "setTitle" ? { ...s, title: p } : s,
    sync: { onConflict: (c) => conflicts.push(...c) },
  });
  try {
    const storage = createMemoryStorage();
    const a = net.addClient("me", storage);
    const b = net.addClient("me", storage); // second tab, shared queue
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();
    // Tab A types "a" then "ab"; its op frames are lost on the wire.
    await a.engine.handleLocalAction("doc", "setTitle", "a");
    await a.engine.handleLocalAction("doc", "setTitle", "ab");
    a.outbox.length = 0;
    // Tab B reconnects and flushes the shared queue.
    await b.engine.requestSync();
    await net.pump();
    assertEquals(net.live().title, "ab", "server truth");
    assertEquals(a.view().title, "ab");
    assertEquals(conflicts, [], "only one user, editing in one tab");
  } finally {
    await net.close();
  }
});
