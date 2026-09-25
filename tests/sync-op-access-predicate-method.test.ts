// A sync op must be judged by the METHOD it runs, not by the word "sync".
//
// The sync path's access gate asked the cell's rule about a method named
// "sync" with no args, then dispatched `${cell}:${op.action}`. A predicate rule
// is handed the method name precisely so it can tell methods apart — so a
// deny-list rule (`m !== "wipe" || admin`) answered "yes" for "sync", and any
// signed-in user ran the admin-only `wipe` by sending an `op` frame instead of
// an `action` frame. Measured on a real loopback server: the action frame was
// refused (ACCESS_DENIED), the op frame was acked and the state was emptied.
// A row-level rule (`(u, m, id) => owns(u, id)`) had the same hole the other
// way round: it never saw the id.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

type Doc = { id: string; text: string };
type S = { items: Doc[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const docs = cell("docs", {
    state: { items: [{ id: "a", text: "keep-me" }] } as S,
    sync: true,
    visible: "all",
    // Everyone may do anything except `wipe`, which is admin-only.
    access: (u, m) => m !== "wipe" || u?.role === "admin",
    methods: {
      add(s: S, text: string) {
        s.items.push({ id: crypto.randomUUID(), text });
      },
      wipe(s: S) {
        s.items = [];
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-sync-op-access");
  const app = await aio.run({
    cells: [docs],
    appId: `sync-op-access-${crypto.randomUUID().slice(0, 8)}`,
    client: "server-only",
    libraryMode: true,
    baseDir: dir,
    port,
    users: { "tok-eve": { id: "eve", role: "user" } },
  });
  const frames: { t: string; d: Record<string, unknown> }[] = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws`,
    { headers: { Authorization: "Bearer tok-eve" } } as never,
  );
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const until = async (pred: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !pred(); i++) await sleep(10);
    assert(pred(), `timed out waiting for ${what}`);
  };
  const close = async () => {
    try {
      ws.close();
    } catch { /* already closed */ }
    await app.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  };
  return { docs, ws, frames, until, close };
}

const op = (id: string, action: string, args: unknown[] = []) =>
  JSON.stringify({
    v: 2,
    t: "op",
    d: {
      id,
      hlc: [Date.now(), 0, "attacker"],
      cell: "docs",
      action,
      payload: { args },
    },
  });

Deno.test({
  name:
    "sync op: a predicate rule sees the op's real method — a denied one is refused",
  sanitizeOps: false, // aio-ok: a live server + socket, both closed in finally
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const h = await boot();
    try {
      h.ws.send(op("op-wipe", "wipe"));
      await h.until(
        () => h.frames.some((f) => f.d?.opId === "op-wipe"),
        "a reply to the wipe op",
      );
      const reply = h.frames.find((f) => f.d?.opId === "op-wipe")!;
      assertEquals(
        reply.t,
        "op-rejected",
        "the access predicate must be asked about `wipe`, not about `sync`",
      );
      assertEquals(h.docs.items.length, 1, "the admin-only wipe never ran");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "sync op: an allowed method still passes the predicate and is applied",
  sanitizeOps: false, // aio-ok: a live server + socket, both closed in finally
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const h = await boot();
    try {
      h.ws.send(op("op-add", "add", ["hello"]));
      await h.until(
        () => h.frames.some((f) => f.d?.opId === "op-add"),
        "a reply to the add op",
      );
      assertEquals(
        h.frames.find((f) => f.d?.opId === "op-add")!.t,
        "sync-ack",
      );
      assertEquals(h.docs.items.map((d) => d.text), ["keep-me", "hello"]);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name:
    "sync pending op: the reconnect flush asks the predicate about the real method too",
  sanitizeOps: false, // aio-ok: a live server + socket, both closed in finally
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const h = await boot();
    try {
      h.ws.send(JSON.stringify({
        v: 2,
        t: "sync-req",
        d: {
          clientId: "attacker",
          cells: {},
          pendingOps: [{
            id: "p-wipe",
            hlc: [Date.now(), 0, "attacker"],
            cell: "docs",
            action: "wipe",
            payload: { args: [] },
          }],
        },
      }));
      await h.until(
        () => h.frames.some((f) => f.d?.opId === "p-wipe"),
        "a reply to the pending wipe op",
      );
      assertEquals(
        h.frames.find((f) => f.d?.opId === "p-wipe")!.t,
        "op-rejected",
      );
      assertEquals(h.docs.items.length, 1, "the admin-only wipe never ran");
    } finally {
      await h.close();
    }
  },
});
