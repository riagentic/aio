// A frame the server drops over a budget that reopens by itself is answered
// with WHEN to re-send it — and aio's client re-sends it, instead of failing a
// call that never ran.
//
// Pacing (tests/send-pacer.test.ts) keeps a client under the advertised rate,
// but it cannot see everything: the first frames of a connection leave before
// the server's hello says what the budget is, a server whose event loop stalls
// reads a backlog in one go, and the global fuse is tripped by OTHER clients.
// Before this, each of those rejected the caller with "this frame was
// dropped" — honest, but a write lost to an ordinary burst all the same.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("ws wire: a rate-dropped call's refusal carries retryAfterMs; a too-large one does not", async () => {
  const c = cell("wsretrywire", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }, _v?: string) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-wsretry-");
  const app = await aio.run({
    cells: [c],
    appId: `wsretrywire-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    wsLimits: { messagesPerSec: 3, maxMessageBytes: 4_000 },
    // deno-lint-ignore no-explicit-any
  } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const acks = new Map<string, Record<string, unknown>>();
  ws.onmessage = (e) => {
    const f = dec(String(e.data));
    if (f?.t !== "ack") return;
    const d = f.d as Record<string, unknown>;
    if (typeof d.cid === "string") acks.set(d.cid, d);
  };
  try {
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("socket failed to open"));
    });
    ws.send(enc("proto", protoHello()));
    for (let i = 0; i < 8; i++) {
      ws.send(
        enc("action", { type: "wsretrywire:bump", payload: {}, cid: `r${i}` }),
      );
    }
    for (let i = 0; i < 100 && acks.size < 8; i++) await sleep(20);
    const refused = [...acks.values()].filter((a) => a.ok === false);
    assert(
      refused.length > 0,
      "a 3/sec budget refused nothing across 9 frames",
    );
    for (const r of refused) {
      const ms = r.retryAfterMs;
      assert(
        typeof ms === "number" && ms > 0 && ms <= 1_200,
        `a budget drop must say when the window reopens: ${JSON.stringify(r)}`,
      );
    }

    // Wait out the window: what is refused now is refused for its SIZE, and
    // re-sending it cannot change that.
    await sleep(1_200);
    ws.send(enc("action", {
      type: "wsretrywire:bump",
      payload: { args: ["x".repeat(6_000)] },
      cid: "big",
    }));
    for (let i = 0; i < 100 && !acks.has("big"); i++) await sleep(20);
    const big = acks.get("big");
    assertEquals(big?.ok, false, "too large is refused");
    assertEquals(
      big?.retryAfterMs,
      undefined,
      "a frame refused for what it IS never invites a re-send",
    );
  } finally {
    try {
      ws.close();
    } catch { /* already closed */ }
    await app.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// Through the REAL client runtime. The calls are made before the socket opens,
// so they replay in the connection's first burst — which the client paces to
// the DEFAULT budget, because the server's hello (5/sec here) has not arrived
// yet. The server drops most of that burst; every one of those calls must be
// re-sent and land.
Deno.test("ws client: calls the server drops over its budget are re-sent and resolve — none rejected", async () => {
  const counter = cell("retrycount", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  await using srv = await testServer({
    cells: [counter],
    wsLimits: { messagesPerSec: 5 },
  });
  const g = globalThis as Record<string, unknown>;
  const u = new URL(srv.url);
  g.location = {
    protocol: u.protocol,
    host: u.host,
    search: "",
    origin: u.origin,
  };
  const { diagSubscribe, initDiagnosticBus } = await import(
    "../src/diagnostics/diagnostic-bus.ts"
  );
  initDiagnosticBus(true);
  const seen: string[] = [];
  const unsubDiag = diagSubscribe((e) => seen.push(e.type));
  await import("../src/browser/browser-air-transport.ts");
  const { client, ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  const { _registerAck } = await import("../src/browser/browser-ack.ts");
  const sub = await import("../src/browser/protocol-subscription.ts");
  const unsub = sub._subscribe(() => {});
  try {
    const N = 20;
    const creator = counter.__aio.actions.inc as () => { type: string };
    const calls = Array.from({ length: N }, () => {
      const action = creator();
      const cid = crypto.randomUUID();
      const p = _registerAck(cid, { deferTimer: true, methodKey: action.type });
      client.send({ ...action, cid } as { type: string });
      return p;
    });
    ensureConnected();
    const settled = await Promise.allSettled(calls);
    const rejected = settled.filter((r) => r.status === "rejected");
    assertEquals(
      rejected.length,
      0,
      `${rejected.length} of ${N} rejected — first: ${
        String((rejected[0] as PromiseRejectedResult | undefined)?.reason)
      }`,
    );
    assertEquals(
      (srv.state() as { retrycount: { n: number } }).retrycount.n,
      N,
      "each call applied exactly once — a re-send is not a duplicate",
    );
    assert(
      seen.includes("browser-air-transport:budget-retry"),
      `the drops this test exists for must have happened (else it proves ` +
        `nothing): ${JSON.stringify([...new Set(seen)])}`,
    );
    const vit = await (await srv.fetch("/__aio/vitals")).json() as {
      clients?: unknown[];
    };
    assertEquals(vit.clients?.length, 1, "and the socket is still up");
  } finally {
    unsubDiag();
    unsub();
    await sleep(400);
  }
});
