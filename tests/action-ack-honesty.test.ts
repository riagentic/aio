// An ack must mean the call RAN. Four ways it did not, and said it did.
//
// The per-action ack was taken from the dispatch promise alone, and dispatch
// resolves whether or not anything happened. So:
//
//   • `await ghost.bump()` — a cell the server never booted — resolved `ok`.
//   • `await todos.renamed()` from a client built before the rename resolved
//     `ok` while the reduce logged "'todos:renamed' does NOTHING".
//
// …forever, on a UI that reports success and data that never moves. The reduce
// had already RECORDED the refusal (state/rejection-tracker.ts) — only the
// sync handler ever read it. Now the ack reads it too, on both transports
// (server/action-ack.ts). (audit a2/W5)
//
// And the mirror image, a frame the server refuses at the door for its SHAPE
// (no type, a framework-internal type, a non-object payload): those returned
// silently, so a caller with a `cid` registered waited out the full 15 s call
// ceiling and was then told the server "never confirmed the call: it may still
// be running" — about a frame the server had deliberately thrown away. Every
// refusal that carries a cid is now answered. (audit a2/W6)
import { assertEquals, assertMatch } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

type Ack = { cid: string; ok: boolean; error?: string; value?: unknown };

const settle = () => new Promise((r) => setTimeout(r, 250));

async function rig() {
  const { aio, cell } = await import("../mod.ts");
  const guard = cell("guard", {
    state: { n: 0 },
    visible: "all",
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
        return "ran";
      },
    },
  });
  const port = freePort();
  const app = await aio.run({
    cells: [guard],
    appId: "test-action-ack-honesty",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  const acks: Ack[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
    s.onmessage = (e) => {
      const f = dec(String(e.data)) as { t?: string; d?: unknown } | null;
      if (f?.t === "ack") acks.push(f.d as Ack);
      clearTimeout(t);
      resolve(s);
    };
    s.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
  const n = () => (app.getState() as { guard: { n: number } }).guard.n;
  const ackFor = (cid: string) => acks.find((a) => a.cid === cid);
  return {
    ws,
    acks,
    ackFor,
    n,
    close: async () => {
      ws.close();
      await app.close();
    },
  };
}

Deno.test("ack honesty: a refused action is acked ok:false, not ok:true", async () => {
  const r = await rig();
  try {
    // CONTROL first: the door is open and a real method really is acked ok.
    r.ws.send(enc("action", { type: "guard:bump", payload: {}, cid: "c-ok" }));
    // An unknown METHOD on a booted cell — the stale-client-after-a-rename
    // case, and the one the reduce already warned about.
    r.ws.send(enc("action", { type: "guard:nope", payload: {}, cid: "c-m" }));
    // An unknown CELL — imported by the client, never passed to aio.run().
    r.ws.send(enc("action", { type: "ghost:bump", payload: {}, cid: "c-c" }));
    await settle();

    assertEquals(r.n(), 1, "control: the real method must have run");
    assertEquals(
      r.ackFor("c-ok"),
      { cid: "c-ok", ok: true, value: "ran" },
      `control ack: ${JSON.stringify(r.acks)}`,
    );

    const m = r.ackFor("c-m");
    assertEquals(
      m?.ok,
      false,
      `an unknown METHOD must not be acked ok — the caller's await resolves ` +
        `over a change that never happened: ${JSON.stringify(r.acks)}`,
    );
    assertMatch(String(m?.error), /does NOTHING|no method by that name/);

    const c = r.ackFor("c-c");
    assertEquals(
      c?.ok,
      false,
      `an unbooted CELL must not be acked ok: ${JSON.stringify(r.acks)}`,
    );
    assertMatch(String(c?.error), /unregistered cell 'ghost'/);
  } finally {
    await r.close();
  }
});

// A bare type ("inc") is NOT refused: an onAction/plugin hook may be what it
// is for (docs/basics/plugins.md), and 1.0.24 acked it ok. With no hook,
// listener or cell to observe it, dev says so once per type.
Deno.test("ack honesty: a bare type is acked ok, and dev warns once when nothing observed it", async () => {
  const { aio, cell } = await import("../mod.ts");
  const { getLogger } = await import("../src/diagnostics/logger-api.ts");
  const c = cell("bare", { state: { n: 0 }, methods: {} });
  const port = freePort();
  const baseDir = await tempDir("aio-bare-");
  const app = await aio.run({
    cells: [c],
    appId: "test-ack-bare-type",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir,
  });
  const acks: Ack[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((r) => ws.onopen = r);
    ws.onmessage = (e) => {
      const f = dec(String(e.data)) as { t?: string; d?: unknown } | null;
      if (f?.t === "ack") acks.push(f.d as Ack);
    };
    for (const cid of ["b1", "b2"]) {
      ws.send(enc("action", { type: "zzping", payload: {}, cid }));
    }
    await settle();
    assertEquals(acks.map((a) => [a.cid, a.ok]), [["b1", true], ["b2", true]]);
    await getLogger()?.flush();
    // app.log holds every level once (warning.log / debug.log repeat it).
    const text = await Deno.readTextFile(
      join(baseDir, ".aio", "logs", "app.log"),
    );
    const hits = text.split("\n").filter((l) =>
      l.includes("WARN") && l.includes("'zzping' has no 'cell:' prefix")
    );
    assertEquals(
      hits.length,
      1,
      `one warning, once per type:\n${text.slice(-3000)}`,
    );
  } finally {
    ws.close();
    await app.close();
    await dropTempDir(baseDir);
  }
});

Deno.test("ack honesty: every shape refusal that carries a cid is answered", async () => {
  const r = await rig();
  try {
    // The three early returns in the WS action handler. Each used to `return`
    // in silence with a cid registered on the other side.
    r.ws.send(enc("action", { type: 42, payload: {}, cid: "s-type" }));
    r.ws.send(
      enc("action", {
        type: "guard:__setBump",
        payload: { mutations: [] },
        cid: "s-internal",
      }),
    );
    r.ws.send(
      enc("action", { type: "guard:bump", payload: [1, 2], cid: "s-payload" }),
    );
    await settle();

    for (const cid of ["s-type", "s-internal", "s-payload"]) {
      const a = r.ackFor(cid);
      assertEquals(
        a?.ok,
        false,
        `a deliberately refused frame must be TOLD, not left to time out ` +
          `(${cid}): ${JSON.stringify(r.acks)}`,
      );
    }
    assertMatch(String(r.ackFor("s-type")?.error), /missing type field/);
    assertMatch(
      String(r.ackFor("s-internal")?.error),
      /framework-internal action type/,
    );
    assertMatch(
      String(r.ackFor("s-payload")?.error),
      /payload must be a plain object/,
    );
    assertEquals(r.n(), 0, "none of these may reduce");
  } finally {
    await r.close();
  }
});
