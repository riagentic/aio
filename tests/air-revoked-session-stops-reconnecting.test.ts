// A tab whose session was revoked (or expired) must learn it is signed out.
//
// A browser cannot read the status of a refused WebSocket upgrade: the 401 the
// server answers a dead credential with arrives as a bare `close` (1006). So
// the tab reconnected forever with the dead credential, said "Reconnecting…"
// instead of signed out, kept the calls it could never deliver pending, and —
// a `?token=` being a PRESENTED credential — every attempt was charged to the
// address's failed-auth budget until it answered 429.
//
// Driven through the REAL client runtime against a REAL server with the login
// flows on: sign in, connect, revoke the session out of band, and watch.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { getConnectedSignal } from "../src/state/state-signals.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as Record<string, unknown>;

Deno.test("revoked session: the tab stops reconnecting and shows signed out", async () => {
  _resetAuthFails();
  const c = cell("revk", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  await using srv = await testServer({ cells: [c], auth: true });
  const su = await srv.fetch("/__aio/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: srv.url },
    body: JSON.stringify({ id: "alice", password: "correct horse battery" }),
  });
  assertEquals(su.status, 201);
  const token = (await su.json()).token as string;

  const host = new URL(srv.url).host;
  g.location = {
    protocol: "http:",
    host,
    search: `?token=${token}`,
    origin: `http://${host}`,
    reload: () => {},
  };
  // Every upgrade the page attempts, counted at the constructor — and the
  // browser's cookie jar: a sign-in's session lands in a cookie, which every
  // later request and upgrade to this host carries.
  let upgrades = 0;
  let jar = "";
  const RealWS = WebSocket;
  g.WebSocket = class extends RealWS {
    constructor(u: string | URL) {
      super(u, jar ? { headers: { cookie: jar } } as never : undefined);
      upgrades++;
    }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== host) return await realFetch(input, init);
    const headers = new Headers(init?.headers);
    if (jar) headers.set("cookie", jar);
    const res = await realFetch(input, { ...init, headers });
    const set = res.headers.get("set-cookie");
    if (set) jar = /max-age=0/i.test(set) ? "" : set.split(";")[0]!;
    return res;
  };
  const lines: string[] = [];
  const orig = { debug: console.debug, error: console.error };
  console.debug = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));

  await import("../src/browser/browser-air-transport.ts");
  const { client, ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  const { _registerAck } = await import("../src/browser/browser-ack.ts");
  const { authUser, _setAuthUser } = await import(
    "../src/browser/browser-auth-ui.ts"
  );
  const sub = await import("../src/browser/protocol-subscription.ts");
  _setAuthUser({ id: "alice", role: "user" } as never);
  ensureConnected();
  const unsub = sub._subscribe(() => {});
  try {
    const connected = getConnectedSignal();
    for (let i = 0; i < 150 && !connected.value; i++) await sleep(20);
    assertEquals(connected.value, true, "the signed-in tab connected");
    assertEquals(upgrades, 1);

    // Revoked out of band (another tab signed out, an admin ended it).
    const out = await srv.fetch("/__aio/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: srv.url },
    });
    assertEquals(out.status, 200);
    await out.body?.cancel();

    // The server closes the live socket with 1008 "session revoked" — and the
    // transport must see THAT code (a scratch run once reported code 0).
    for (let i = 0; i < 150 && authUser.value !== null; i++) await sleep(20);
    assert(
      lines.some((l) => l.includes("session revoked") && l.includes("(1008)")),
      `the revoke close arrived as 1008: ${lines.join(" | ")}`,
    );
    assertEquals(authUser.value, null, "the tab surfaced signed-out");
    assert(
      lines.some((l) => /signed out/i.test(l)),
      `the status says signed out: ${lines.join(" | ")}`,
    );

    // A call made now is refused at once, not parked forever.
    const cid = crypto.randomUUID();
    const p = _registerAck(cid, { deferTimer: true, methodKey: "revk:inc" });
    const inc = c.__aio.actions.inc as () => { type: string };
    client.send({ ...inc(), cid } as { type: string });
    const err = await p.then(() => null, (e: Error) => e);
    assert(err && /signed out/i.test(err.message), `rejected: ${err}`);

    // …and the dead credential is not presented again and again.
    const after = upgrades;
    await sleep(4000); // backoff 1s, 2s — two more attempts before the fix
    assertEquals(upgrades, after, "no reconnect after signed-out");

    // Signing in again resumes the connection with the new session — which
    // rides the cookie, while the page URL still carries the dead `?token=`
    // (the server reads a URL token first, so presenting it again would be
    // refused forever).
    const { createAuthClient } = await import("../src/browser/auth-client.ts");
    await createAuthClient(srv.url).login("alice", "correct horse battery");
    assert(jar !== "", "the sign-in set a session cookie");
    for (let i = 0; i < 150 && !connected.value; i++) await sleep(20);
    assertEquals(connected.value, true, "a sign-in reconnected the tab");
  } finally {
    console.debug = orig.debug;
    console.error = orig.error;
    unsub();
    // The transport is a module singleton: tear it down here, before the
    // server stops under it and it schedules a reconnect into the next test.
    sub._teardownNow();
    g.WebSocket = RealWS;
    globalThis.fetch = realFetch;
    await sleep(200);
  }
});
