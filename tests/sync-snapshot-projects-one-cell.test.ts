// A server-side write to a sync cell projects THAT cell for its clients —
// never the whole app's view for no user.
//
// The sync handler's `getClientCellState(cell)` built the full UI state with
// no user and picked one cell out of it. Every other cell's `visible.forUser`
// ran too, for a viewer no socket is, and one that reads its user (`u!.id`)
// threw: each server write to the sync cell logged "visible.forUser threw —
// omitting the cell for this client" at ERROR, with no such client connected.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ALICE = "tok-alice-0123456789abcdefghij";

Deno.test({
  name:
    "sync: a server write to a sync cell never runs another cell's forUser for no user",
  sanitizeOps: false, // aio-ok: a live server + socket, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    let userless = 0;
    type Item = { owner: string };
    const notes = cell("ssNotes", {
      state: { items: [] as Item[] },
      visible: {
        forUser: (s, u) => {
          if (!u) userless++;
          return { ...s, items: s.items.filter((i) => i.owner === u!.id) };
        },
      },
      access: () => true,
      methods: {
        add(s, owner: string) {
          s.items.push({ owner });
        },
      },
    });
    const chat = cell("ssChat", {
      state: { n: 0 },
      visible: "all",
      sync: true,
      access: () => true,
      methods: {
        bump(s) {
          s.n++;
        },
      },
    });
    const dir = await tempDir("aio-sync-one-cell");
    const port = freePort();
    const app = await aio.run({
      cells: [notes, chat],
      appId: `sync-one-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      libraryMode: true,
      baseDir: dir,
      port,
      users: { [ALICE]: { id: "alice", role: "user" } },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${ALICE}`);
    // A server-origin write reaches a sync client as a pushed `sync-res`.
    const pushes: unknown[] = [];
    ws.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t === "sync-res") pushes.push(f.d);
    };
    try {
      await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = () => j(new Error("ws error"));
      });
      await notes.add("alice"); // a row the filter must read its user for
      for (let i = 0; i < 3; i++) await chat.bump();
      for (let i = 0; i < 300 && pushes.length < 1; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert(pushes.length >= 1, "the server writes never reached the client");
      assertEquals(
        userless,
        0,
        "forUser ran with no user — a view no connected client holds",
      );
    } finally {
      ws.close();
      await app.close();
      await dropTempDir(dir);
    }
  },
});
