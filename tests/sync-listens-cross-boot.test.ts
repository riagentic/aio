// `listensTo` across the `sync` line, through the REAL boot and restarts.
//
// A listener reacts inside the reduce of the action it listens to, and the
// two cells' halves of that reduce are made durable by different machinery:
//   tally (KV)   ← notes:add (sync)  — its reaction lives in the KV store;
//                  boot replay must NOT re-apply notes' ops to it (it did:
//                  2, 4, 6 … one more round per restart)
//   feed (sync)  ← inbox:post (KV)   — its reaction is no op of feed's; it
//   mirror (sync)← notes:add (sync)    must be folded into feed's/mirror's own
//                  snapshot (it was durable nowhere: gone after a restart)
// Fixed by: replaySyncOps takes only the replayed cell's slice from each fold,
// and the afterAction hook folds any OTHER sync cell an action changed
// (noteServerWrite). Checked with the op-log intact and after a compaction.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { log } from "../src/diagnostics/logger-api.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function defineCells() {
  const notes = cell("notes", {
    version: 1,
    sync: true,
    state: { items: [] as string[] },
    methods: {
      add(s: { items: string[] }, t: string) {
        s.items.push(t);
      },
    },
  });
  const tally = cell("tally", {
    state: { n: 0 },
    methods: {
      onAdd(s: { n: number }) {
        s.n++;
      },
    },
    listensTo: { onAdd: notes.add },
  });
  const inbox = cell("inbox", {
    state: { posts: 0 },
    methods: {
      post(s: { posts: number }, _t: string) {
        s.posts++;
      },
    },
  });
  const feed = cell("feed", {
    version: 1,
    sync: true,
    state: { seen: [] as string[] },
    methods: {
      onPost(s: { seen: string[] }, t: string) {
        s.seen.push(t);
      },
    },
    listensTo: { onPost: inbox.post },
  });
  const mirror = cell("mirror", {
    version: 1,
    sync: true,
    state: { got: [] as string[] },
    methods: {
      onAdd(s: { got: string[] }, t: string) {
        s.got.push(t);
      },
    },
    listensTo: { onAdd: notes.add },
  });
  // The control: a listener between two non-sync cells is on one side.
  const audit = cell("audit", {
    state: { posts: 0 },
    methods: {
      onPost(s: { posts: number }) {
        s.posts++;
      },
    },
    listensTo: { onPost: inbox.post },
  });
  return { notes, tally, inbox, feed, mirror, audit };
}

type Snap = {
  notes: { items: string[] };
  tally: { n: number };
  feed: { seen: string[] };
  mirror: { got: string[] };
  audit: { posts: number };
};

Deno.test({
  name:
    "listensTo × sync: every listener's reaction survives restarts exactly once — op-log intact and after compaction",
  async fn() {
    const dir = await tempDir("aio-xsync-");
    const prevApps = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", dir);
    const infos: string[] = [];
    const origInfo = log.info.bind(log);
    log.info = ((a: string, b?: string) => infos.push(b ?? a)) as Any;
    try {
      const { aio } = await import("../mod.ts");
      const { _resetAioRuntime } = await import(
        "../src/state/runtime-reset.ts"
      );
      const boot = async () => {
        _resetAioRuntime();
        const cells = defineCells();
        const port = freePort();
        const app = await aio.run({
          cells: Object.values(cells),
          appId: "xsync-probe",
          appDir: dir,
          client: "server-only",
          libraryMode: true,
          port,
        } as Any);
        return { app, cells, port };
      };
      const expectState = (s: Snap, notes: string[], where: string) => {
        assertEquals(s.notes.items, notes, `${where}: notes`);
        assertEquals(s.tally.n, notes.length, `${where}: tally, once each`);
        assertEquals(s.mirror.got, notes, `${where}: mirror`);
        assertEquals(s.feed.seen, ["p1"], `${where}: feed`);
        assertEquals(s.audit.posts, 1, `${where}: audit (the non-sync pair)`);
      };

      const r1 = await boot();
      // Two sync ops from a client, the way the browser engine sends them…
      const ws = new WebSocket(`ws://127.0.0.1:${r1.port}/ws`);
      const acks: string[] = [];
      ws.onmessage = (e) => {
        try {
          const f = JSON.parse(e.data);
          if (f.t === "sync-ack") acks.push(f.d.opId);
        } catch { /* not a frame */ }
      };
      await new Promise((r) => (ws.onopen = r));
      for (const i of [1, 2]) {
        ws.send(JSON.stringify({
          v: 2,
          t: "op",
          d: {
            id: `op-${i}`,
            hlc: [Date.now(), i, "c1"],
            cell: "notes",
            action: "add",
            payload: { args: [`n${i}`] },
          },
        }));
      }
      // …and one plain server-side call of a non-sync cell.
      await (r1.cells.inbox as Any).post("p1");
      for (let i = 0; i < 300 && acks.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(acks.sort(), ["op-1", "op-2"]);
      expectState(r1.app.getState() as Snap, ["n1", "n2"], "live");
      const closed = new Promise((r) => (ws.onclose = r));
      ws.close();
      await closed;
      await r1.app.close();

      // The op-log intact: notes' two ops are replayed at every boot.
      for (const restart of [1, 2]) {
        const r = await boot();
        const s = r.app.getState() as Snap;
        await r.app.close();
        expectState(s, ["n1", "n2"], `restart ${restart} (op-log)`);
      }

      // A server-side write to notes folds it into a snapshot and DELETES the
      // ops — the next boots seed notes from the snapshot instead.
      {
        const r = await boot();
        await (r.cells.notes as Any).add("n3");
        expectState(r.app.getState() as Snap, ["n1", "n2", "n3"], "live 2");
        await r.app.close();
      }
      infos.length = 0;
      for (const restart of [3, 4]) {
        const r = await boot();
        const s = r.app.getState() as Snap;
        await r.app.close();
        expectState(s, ["n1", "n2", "n3"], `restart ${restart} (snapshot)`);
      }
      assert(
        infos.some((l) => l.includes('seeded cell "notes" from compaction')),
        "precondition: notes really booted from its snapshot",
      );
    } finally {
      log.info = origInfo;
      if (prevApps === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prevApps);
      await dropTempDir(dir);
    }
  },
});
