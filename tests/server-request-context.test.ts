// `serverRequest()` — the ambient transport facts of the call in flight.
// Mirrors serverUser(): no parameter threading, survives awaits, and is
// undefined for server-origin work. Covers both arrival paths (HTTP route and
// WS frame) plus the isolation property that makes an ambient safe to trust.
import { assert, assertEquals } from "@std/assert";
import { aio, cell, route, serverRequest } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { enc } from "../src/protocol/envelope.ts";

type Seen =
  | null
  | { ip?: string; via: string; ua: string; sid: string; url: string };
type S = { probe: { seen: Seen; hops: number } };

/** One app per test — and one cell def per app: a def binds to exactly ONE
 *  app (perfect-aio D2), so the probe is built fresh inside boot(). */
function makeProbe() {
  return cell("probe", {
    state: { seen: null as Seen, hops: 0 },
    methods: {
      async record(s) {
        // Read AFTER an await too — the ambient must survive the suspension.
        await new Promise((r) => setTimeout(r, 1));
        const req = serverRequest();
        s.seen = req
          ? {
            ip: req.ip,
            via: req.via,
            ua: req.headers.get("user-agent") ?? "",
            sid: req.cookies.sid ?? "",
            url: req.url,
          }
          : null;
        s.hops++;
      },
    },
  });
}

async function boot() {
  const port = freePort();
  const probe = makeProbe();
  const state = () => (app.getState() as S).probe;
  const app = await aio.run({
    cells: [probe],
    appId: `test-serverreq-${port}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
    routes: {
      // A route that reports the ambient directly AND through a cell method.
      "/probe": route(async (ctx) => {
        const req = serverRequest();
        await probe.record();
        return ctx.json({
          inRoute: { ip: req?.ip, via: req?.via, sid: req?.cookies.sid ?? "" },
          inMethod: state().seen,
        });
      }),
    },
  });
  return { app, probe, state, base: `http://127.0.0.1:${port}`, port };
}

Deno.test("serverRequest: an HTTP route and the cell method it calls see the same request", async () => {
  const { app, base } = await boot();
  try {
    const res = await fetch(`${base}/probe`, {
      headers: { "user-agent": "probe-agent/1", cookie: "sid=abc123; x=1" },
    });
    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.inRoute.via, "http");
    assertEquals(body.inRoute.ip, "127.0.0.1", "the client IP the server sees");
    assertEquals(body.inRoute.sid, "abc123", "cookies are parsed");
    // The method ran inside the route's ambient — same facts, after an await.
    assertEquals(body.inMethod.via, "http");
    assertEquals(body.inMethod.ip, "127.0.0.1");
    assertEquals(body.inMethod.ua, "probe-agent/1", "headers survive the hop");
    assertEquals(body.inMethod.sid, "abc123");
    assert(body.inMethod.url.endsWith("/probe"), body.inMethod.url);
  } finally {
    await app.close();
  }
});

Deno.test("serverRequest: a cell method dispatched over WS sees the socket's request", async () => {
  const { app, state, port } = await boot();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((res, rej) => {
      ws.onopen = () => res(null);
      ws.onerror = () => rej(new Error("ws failed to open"));
    });
    const before = state().hops;
    ws.send(enc("action", { type: "probe:record", payload: { args: [] } }));
    for (let i = 0; i < 100 && state().hops === before; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close();
    const seen = state().seen!;
    assertEquals(seen.via, "ws", "a socket frame reports its transport");
    assertEquals(seen.ip, "127.0.0.1");
    assert(seen.url.includes("/ws"), seen.url);
  } finally {
    await app.close();
  }
});

Deno.test("serverRequest: server-origin work has no request", async () => {
  const { app, probe, state, base } = await boot();
  try {
    // Prime it with a real request first, so a later `null` can only mean
    // "cleared" — not "never set".
    await (await fetch(`${base}/probe`, { headers: { cookie: "sid=primed" } }))
      .json();
    assertEquals(state().seen?.sid, "primed");
    // Now dispatch from the server itself — nothing requested this.
    await probe.record();
    assertEquals(
      state().seen,
      null,
      "a schedule / boot / internal dispatch must not inherit a stale request",
    );
    assertEquals(serverRequest(), undefined, "and neither does plain code");
  } finally {
    await app.close();
  }
});

Deno.test("serverRequest: concurrent requests never see each other's context", async () => {
  const { app, base } = await boot();
  try {
    const sids = await Promise.all(
      ["a", "b", "c", "d"].map(async (id) => {
        const res = await fetch(`${base}/probe`, {
          headers: { cookie: `sid=${id}` },
        });
        return (await res.json()).inRoute.sid as string;
      }),
    );
    // Each response must carry ITS OWN cookie — an ambient that leaked across
    // in-flight requests would hand back another caller's session.
    assertEquals(sids.sort(), ["a", "b", "c", "d"]);
  } finally {
    await app.close();
  }
});
