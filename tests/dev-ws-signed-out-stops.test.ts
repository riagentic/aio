// The dev reload socket (`devWsScript`) kept retrying every 2s after the
// tab was signed out — with the page's dead `?token=`, a PRESENTED credential,
// so every retry was charged to the address's failed-auth budget until the
// server answered 429 and the user could not sign back in (dev only: prod has
// no dev socket). The bundle's transport had already stopped (see
// air-revoked-session-stops-reconnecting.test.ts); the dev socket must stop
// with it and resume after a sign-in.
//
// Driven with the REAL transport and the REAL dev script against a REAL
// loopback server; the charge is counted where the server records it.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { devWsScript } from "../src/server/server-html-scripts.ts";
import { getConnectedSignal } from "../src/state/state-signals.ts";
import {
  SIGNED_IN_EVENT,
  SIGNED_OUT_EVENT,
} from "../src/browser/auth-client.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as Record<string, unknown>;

Deno.test("dev reload socket: stops presenting a dead token once signed out, resumes on sign-in", async () => {
  _resetAuthFails();
  const c = cell("devso", {
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
    body: JSON.stringify({ id: "bob", password: "correct horse battery" }),
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
  const RealWS = WebSocket;
  const devSockets: WebSocket[] = [];
  let devOpens = 0;
  // Every failed auth the server records, counted at its audit line.
  let fails = 0;
  const orig = {
    debug: console.debug,
    error: console.error,
    warn: console.warn,
  };
  const count = (...a: unknown[]) => {
    if (a.map(String).join(" ").includes("failed auth from")) fails++;
  };
  console.warn = count;
  console.error = count;
  console.debug = () => {};

  await import("../src/browser/browser-air-transport.ts");
  const { ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  const { authUser, _setAuthUser } = await import(
    "../src/browser/browser-auth-ui.ts"
  );
  const sub = await import("../src/browser/protocol-subscription.ts");
  _setAuthUser({ id: "bob", role: "user" } as never);
  ensureConnected();
  const unsub = sub._subscribe(() => {});
  // The dev script, run as the page runs it — its sockets told apart from
  // the transport's by constructing them through a separate class.
  const DevWS = class extends RealWS {
    constructor(u: string | URL) {
      super(u);
      devSockets.push(this);
      this.addEventListener("open", () => void devOpens++);
    }
  };
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

    // The dev socket retries every 2s: 5s is two retries before the fix.
    await sleep(500);
    const before = fails;
    const socketsBefore = devSockets.length;
    await sleep(5000);
    assertEquals(
      fails,
      before,
      "no failed auth is charged while the tab is signed out",
    );
    assertEquals(devSockets.length, socketsBefore, "no dev retry either");

    // Sign in again: the dev socket resumes with the new session. (This
    // page's session is in its URL; the URL is updated BEFORE the sign-in is
    // announced, so both sockets reconnect with the live token.)
    const li = await srv.fetch("/__aio/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: srv.url },
      body: JSON.stringify({ id: "bob", password: "correct horse battery" }),
    });
    assertEquals(li.status, 200);
    (g.location as { search: string }).search = `?token=${
      (await li.json()).token
    }`;
    globalThis.dispatchEvent(new Event(SIGNED_IN_EVENT));
    for (let i = 0; i < 200 && devOpens < 2; i++) await sleep(20);
    assert(devOpens >= 2, "a sign-in reconnected the dev socket");
    assertEquals(fails, before, "and the resumed socket was not refused");
  } finally {
    console.debug = orig.debug;
    console.error = orig.error;
    console.warn = orig.warn;
    unsub();
    // The transport is a module singleton: tear it down here, before the
    // server stops under it and it schedules a reconnect into the next test.
    sub._teardownNow();
    // Park it for good: a signed-out socket schedules no retry.
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
  }
});

// The same socket alone, driven by the two events: after a sign-in in a real
// browser the page URL STILL carries the refused token (the new session rides
// the cookie) — presenting it again would be charged every 2s all over again.
Deno.test("dev reload socket: after sign-in it never re-presents the refused URL token", async () => {
  _resetAuthFails();
  const c = cell("devso2", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({ cells: [c], auth: true });
  const su = await srv.fetch("/__aio/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: srv.url },
    body: JSON.stringify({ id: "cy", password: "correct horse battery" }),
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
  const urls: string[] = [];
  const socks: WebSocket[] = [];
  let opens = 0;
  const DevWS = class extends WebSocket {
    constructor(u: string | URL) {
      super(u);
      urls.push(String(u));
      socks.push(this);
      this.addEventListener("open", () => void opens++);
    }
  };
  let fails = 0;
  const orig = { debug: console.debug, warn: console.warn };
  console.debug = () => {};
  console.warn = (...a: unknown[]) => {
    if (a.map(String).join(" ").includes("failed auth from")) fails++;
  };
  new Function("WebSocket", devWsScript())(DevWS);
  try {
    for (let i = 0; i < 150 && !opens; i++) await sleep(20);
    assertEquals(opens, 1, "the dev socket connected");
    const out = await srv.fetch("/__aio/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: srv.url },
    });
    assertEquals(out.status, 200);
    await out.body?.cancel();
    globalThis.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    await sleep(300);
    globalThis.dispatchEvent(new Event(SIGNED_IN_EVENT));
    await sleep(4500); // two 2s retries
    assert(urls.length >= 2, `the dev socket resumed: ${urls.length}`);
    for (const u of urls.slice(1)) {
      assert(!u.includes("token="), `re-presented the dead token: ${u}`);
    }
    assertEquals(fails, 0, "no failed auth charged");
  } finally {
    console.debug = orig.debug;
    console.warn = orig.warn;
    // Park it for good: a signed-out socket schedules no retry.
    globalThis.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    for (const s of socks) s.close();
    // Closed for real, while parked: a closing socket's retry timer would
    // otherwise outlive the test.
    for (
      let i = 0;
      i < 150 && socks.some((s) => s.readyState !== WebSocket.CLOSED);
      i++
    ) {
      await sleep(20);
    }
  }
});
