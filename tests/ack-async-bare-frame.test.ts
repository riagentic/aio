// A client that sends exactly the DOCUMENTED frame must hear the truth.
//
// Return-value transport was keyed on `payload._callId`, a field
// `ActionPayload` — the declared client-action wire type — has never
// mentioned. The trojan door stamped one when it was absent; the WS and UDS
// doors never did. So a third-party client sending `{type, payload, cid}` got
// `{ok: true, value: undefined}` for an async method that THREW, and lost the
// return value of one that succeeded. With 100 concurrent calls on a
// `transaction: true` cell, 98 write-sets were aborted and zero callers were
// told, while the server logged "the caller that awaited it was rejected with
// this error".
//
// aio's own browser and CLI clients set the field and were fine, which is
// exactly why it survived to the edge of a frozen wire.
//
// Worse, the field was TRUSTED. `registerCall` did a blind `set` on a
// process-global map, so two clients sending the same id collided: the first
// to finish resolved the OTHER caller with its return value, and the loser
// hung past its ceiling because expiry short-circuits on an id that now names
// a different call. The id is minted server-side now, in `dispatchNetwork`,
// for every door at once.
import { assert, assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";

type Ack = { cid: string; ok: boolean; error?: string; value?: unknown };
const settle = () => new Promise((r) => setTimeout(r, 400));

async function rig() {
  const { aio, cell } = await import("../mod.ts");
  const probe = cell("bare", {
    state: { n: 0 },
    visible: "all",
    methods: {
      async ok(s: { n: number }) {
        await Promise.resolve();
        s.n += 1;
        return 42;
      },
      async boomAfterAwait(_s: { n: number }) {
        await Promise.resolve();
        throw new Error("BOOM-after-await");
      },
      async boomImmediate(_s: { n: number }) {
        throw new Error("BOOM-immediate");
      },
      syncOk(s: { n: number }) {
        s.n += 1;
        return "sync-value";
      },
    },
  });
  const port = freePort();
  const app = await aio.run({
    cells: [probe],
    appId: "test-ack-bare-frame",
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
  return {
    ws,
    ackFor: (cid: string) => acks.find((a) => a.cid === cid),
    close: async () => {
      ws.close();
      await app.close();
    },
  };
}

Deno.test("ack: a bare frame gets an async method's VALUE and its THROW", async () => {
  const r = await rig();
  try {
    // Exactly the documented shape: type, payload, cid. No `_callId`.
    r.ws.send(enc("action", { type: "bare:ok", payload: {}, cid: "a1" }));
    r.ws.send(
      enc("action", { type: "bare:boomAfterAwait", payload: {}, cid: "a2" }),
    );
    r.ws.send(
      enc("action", { type: "bare:boomImmediate", payload: {}, cid: "a3" }),
    );
    // The control: a SYNC method has always answered honestly here.
    r.ws.send(enc("action", { type: "bare:syncOk", payload: {}, cid: "a4" }));
    await settle();

    assertEquals(r.ackFor("a1")?.ok, true, JSON.stringify(r.ackFor("a1")));
    assertEquals(r.ackFor("a1")?.value, 42, "the return value must cross");

    assertEquals(r.ackFor("a2")?.ok, false, JSON.stringify(r.ackFor("a2")));
    assert(
      String(r.ackFor("a2")?.error).includes("BOOM-after-await"),
      String(r.ackFor("a2")?.error),
    );

    assertEquals(r.ackFor("a3")?.ok, false, JSON.stringify(r.ackFor("a3")));
    assert(
      String(r.ackFor("a3")?.error).includes("BOOM-immediate"),
      String(r.ackFor("a3")?.error),
    );

    assertEquals(r.ackFor("a4")?.ok, true);
    assertEquals(r.ackFor("a4")?.value, "sync-value");
  } finally {
    await r.close();
  }
});

Deno.test("ack: a forged _callId cannot steal another caller's value", async () => {
  const r = await rig();
  try {
    // Two calls that both claim the same correlation id. Before, the map was
    // keyed by exactly this field: one caller received the other's return
    // value and the other hung out its whole ceiling.
    r.ws.send(
      enc("action", {
        type: "bare:ok",
        payload: { _callId: "COLLIDE" },
        cid: "b1",
      }),
    );
    r.ws.send(
      enc("action", {
        type: "bare:ok",
        payload: { _callId: "COLLIDE" },
        cid: "b2",
      }),
    );
    await settle();

    // Both are answered, independently, each with its own value.
    for (const cid of ["b1", "b2"]) {
      assertEquals(
        r.ackFor(cid)?.ok,
        true,
        `${cid}: ${JSON.stringify(r.ackFor(cid))}`,
      );
      assertEquals(r.ackFor(cid)?.value, 42, cid);
    }
  } finally {
    await r.close();
  }
});

Deno.test("sanitize: `_callId` is stripped before dispatch", async () => {
  // The strip is not what makes the collision test above pass — the
  // server-minted id overwrites the client's either way. It is here so the
  // field can never be read as trusted by some later path. Tested on its own
  // terms, because a belt-and-braces guard nothing can see is a guard that
  // rots. It is stripped QUIETLY: aio's own client sends it on every async
  // call (tests/sanitize-own-client-quiet.test.ts pins the silence).
  const { sanitizeClientAction } = await import("../src/server/server-ws.ts");
  const action: Record<string, unknown> = {
    type: "bare:ok",
    payload: { _callId: "FORGED", keep: 1 },
  };
  sanitizeClientAction(action, "ws");
  assertEquals(action.payload, { keep: 1 });
  assertEquals(action._source, "UI");
});

Deno.test("registerCall: a duplicate id is refused, loudly", async () => {
  // Ids are minted per call now, so a duplicate is a framework defect rather
  // than a race — and the map used to `set` it blind, silently reassigning one
  // caller's slot to another call.
  const { registerCall, resolveCall } = await import(
    "../src/state/cell-impl.ts"
  );
  const id = `dup-${crypto.randomUUID()}`;
  const first = registerCall(id, "probe:method");
  let threw = "";
  try {
    registerCall(id, "probe:method");
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("duplicate call id"), threw);
  assert(threw.includes(id), threw);
  resolveCall(id, "done");
  assertEquals(await first, "done");
});
