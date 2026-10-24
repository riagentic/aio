// `am cost` attributes a full send from a view a client actually received —
// never from a user-less view no socket holds.
//
// The broadcaster's per-round attribution called `getUIState()` with no user.
// In a per-user app (every socket signed in) that built a view for nobody, and
// a `visible.forUser` that reads its user (`u!.id`) threw on it: each round
// with a full send — every change to a forUser cell is one — logged
// "visible.forUser threw — omitting the cell for this client" at ERROR, in
// production, with no such client connected. A false alarm per broadcast.
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ALICE = "tok-alice-0123456789abcdefghij";

Deno.test({
  name: "broadcast: am cost attribution never builds a view for no user",
  sanitizeOps: false, // aio-ok: a live server + socket, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    let userless = 0;
    type Item = { owner: string };
    const notes = cell("caNotes", {
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
    const dir = await tempDir("aio-cost-view");
    const port = freePort();
    const app = await aio.run({
      cells: [notes],
      appId: `cost-view-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      baseDir: dir,
      port,
      users: { [ALICE]: { id: "alice", role: "user" } },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${ALICE}`);
    const acks: unknown[] = [];
    let lastState: unknown;
    ws.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t === "ack") acks.push(f.d);
      if (f?.t === "state") lastState = f.d;
    };
    try {
      await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = () => j(new Error("ws error"));
      });
      for (let i = 0; i < 3; i++) {
        ws.send(enc("action", {
          type: "caNotes:add",
          payload: { args: ["alice"] },
          cid: `c${i}`,
        }));
      }
      for (let i = 0; i < 200; i++) {
        const items = (lastState as { caNotes?: { items: Item[] } })?.caNotes
          ?.items;
        if (acks.length === 3 && items?.length === 3) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      // The rounds went out as full sends to alice…
      assertEquals(
        (lastState as { caNotes: { items: Item[] } }).caNotes.items.length,
        3,
      );
      // …and nothing built the user-less view the old attribution asked for.
      assertEquals(
        userless,
        0,
        "forUser was run with no user — a view no connected client holds",
      );
    } finally {
      ws.close();
      await app.close();
      await dropTempDir(dir);
    }
  },
});
