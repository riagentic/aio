// The dev reload socket pauses when the transport says signed out and resumes
// on a sign-in — but a signed-out tab ALSO resumes when the user signed in in
// another tab and comes back to this one (the transport's focus probe). That
// resume announced nothing in this window, so the transport reconnected and
// the dev socket stayed parked for good: no more reloads on edit in that tab.
//
// Driven with the REAL transport and the REAL dev script against a REAL
// loopback server, with one cookie jar shared by the page's sockets and
// fetches (a browser's jar).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { devWsScript } from "../src/server/server-html-scripts.ts";
import { getConnectedSignal } from "../src/state/state-signals.ts";
import { SIGNED_OUT_EVENT } from "../src/browser/auth-client.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as Record<string, unknown>;

Deno.test("dev reload socket: resumes when a sign-in in another tab resumes the transport on focus", async () => {
  _resetAuthFails();
  const c = cell("devfocus", {
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
    body: JSON.stringify({ id: "dee", password: "correct horse battery" }),
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
  g.window = globalThis;
  let jar = "";
  const RealWS = WebSocket;
  g.WebSocket = class extends RealWS {
    constructor(u: string | URL) {
      super(u, jar ? { headers: { cookie: jar } } as never : undefined);
    }
  };
  const devSockets: WebSocket[] = [];
  let devOpens = 0;
  const DevWS = class extends RealWS {
    constructor(u: string | URL) {
      super(u, jar ? { headers: { cookie: jar } } as never : undefined);
      devSockets.push(this);
      this.addEventListener("open", () => void devOpens++);
    }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== host) return await realFetch(input, init);
    const headers = new Headers(init?.headers);
    if (jar) headers.set("cookie", jar);
    return await realFetch(input, { ...init, headers });
  };
  const orig = {
    debug: console.debug,
    error: console.error,
    warn: console.warn,
  };
  console.debug = () => {};
  console.error = () => {};
  console.warn = () => {};

  await import("../src/browser/browser-air-transport.ts");
  const { ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  const { authUser, _setAuthUser } = await import(
    "../src/browser/browser-auth-ui.ts"
  );
  const sub = await import("../src/browser/protocol-subscription.ts");
  _setAuthUser({ id: "dee", role: "user" } as never);
  ensureConnected();
  const unsub = sub._subscribe(() => {});
  new Function("WebSocket", devWsScript())(DevWS);
  try {
    const connected = getConnectedSignal();
    for (let i = 0; i < 150 && !(connected.value && devOpens); i++) {
      await sleep(20);
    }
    assertEquals(connected.value, true, "the signed-in tab connected");
    assertEquals(devOpens, 1, "the dev socket connected");

    const out = await srv.fetch("/__aio/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: srv.url },
    });
    assertEquals(out.status, 200);
    await out.body?.cancel();
    for (let i = 0; i < 150 && authUser.value !== null; i++) await sleep(20);
    assertEquals(authUser.value, null, "the tab surfaced signed-out");
    for (let i = 0; i < 150 && connected.value; i++) await sleep(20);

    // Signed in again in ANOTHER tab: only the shared cookie changes here.
    const li = await srv.fetch("/__aio/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: srv.url },
      body: JSON.stringify({ id: "dee", password: "correct horse battery" }),
    });
    assertEquals(li.status, 200);
    await li.body?.cancel();
    jar = (li.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert(jar !== "", "the sign-in set a session cookie");
    globalThis.dispatchEvent(new Event("focus"));
    for (let i = 0; i < 150 && !connected.value; i++) await sleep(20);
    assertEquals(connected.value, true, "the transport resumed on focus");
    // The dev socket retries 2s after a close — give it that and a margin.
    for (let i = 0; i < 200 && devOpens < 2; i++) await sleep(20);
    assert(devOpens >= 2, "the dev reload socket resumed with it");
  } finally {
    console.debug = orig.debug;
    console.error = orig.error;
    console.warn = orig.warn;
    unsub();
    // The transport is a module singleton: tear it down here, before the
    // server stops under it and it schedules a reconnect into the next test.
    sub._teardownNow();
    globalThis.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    for (const s of devSockets) s.close();
    // Closed for real, while parked: a closing socket's retry timer would
    // otherwise outlive the test.
    for (
      let i = 0;
      i < 150 && devSockets.some((s) => s.readyState !== WebSocket.CLOSED);
      i++
    ) {
      await sleep(20);
    }
    g.WebSocket = RealWS;
    globalThis.fetch = realFetch;
  }
});
