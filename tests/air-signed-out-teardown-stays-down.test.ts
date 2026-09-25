// A torn-down client stays down when a sign-in lands later.
//
// A signed-out tab waits for a sign-in (its event, or a focus probe) and then
// reconnects. Teardown — no subscriber left for 300ms — is "nothing of this
// client outlives it", but the sign-in still reconnected the torn-down client:
// a live socket nobody reads, and no listener gap left to close it again. It
// must wait for the next subscribe, which then connects with the new session.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { getConnectedSignal } from "../src/state/state-signals.ts";
import { SIGNED_IN_EVENT } from "../src/browser/auth-client.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as Record<string, unknown>;

Deno.test("signed out, then torn down: a later sign-in does not resurrect the client", async () => {
  _resetAuthFails();
  const c = cell("revtd", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({ cells: [c], auth: true });
  const signIn = async (path: string, status: number) => {
    const r = await srv.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: srv.url },
      body: JSON.stringify({ id: "dee", password: "correct horse battery" }),
    });
    assertEquals(r.status, status);
    return (await r.json()).token as string;
  };
  const token = await signIn("/__aio/auth/signup", 201);
  const host = new URL(srv.url).host;
  const loc = {
    protocol: "http:",
    host,
    search: `?token=${token}`,
    origin: `http://${host}`,
    reload: () => {},
  };
  g.location = loc;
  let upgrades = 0;
  const RealWS = WebSocket;
  g.WebSocket = class extends RealWS {
    constructor(u: string | URL) {
      super(u);
      upgrades++;
    }
  };
  const orig = { debug: console.debug, error: console.error };
  console.debug = () => {};
  console.error = () => {};

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
  let unsub = sub._subscribe(() => {});
  try {
    const connected = getConnectedSignal();
    for (let i = 0; i < 150 && !connected.value; i++) await sleep(20);
    assertEquals(connected.value, true, "the signed-in tab connected");

    const out = await srv.fetch("/__aio/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: srv.url },
    });
    assertEquals(out.status, 200);
    await out.body?.cancel();
    for (let i = 0; i < 150 && authUser.value !== null; i++) await sleep(20);
    assertEquals(authUser.value, null, "the tab surfaced signed-out");

    // The page unmounts everything: the client is torn down.
    unsub();
    sub._teardownNow();
    const before = upgrades;

    // A sign-in (this window's event) — the new session rides the URL here.
    loc.search = `?token=${await signIn("/__aio/auth/login", 200)}`;
    globalThis.dispatchEvent(new Event(SIGNED_IN_EVENT));
    await sleep(500);
    assertEquals(upgrades, before, "the torn-down client stayed down");
    assertEquals(connected.value, false);

    // The next subscribe connects it, with the new session.
    unsub = sub._subscribe(() => {});
    ensureConnected();
    for (let i = 0; i < 150 && !connected.value; i++) await sleep(20);
    assertEquals(connected.value, true, "a new subscriber reconnected it");
  } finally {
    console.debug = orig.debug;
    console.error = orig.error;
    unsub();
    sub._teardownNow();
    g.WebSocket = RealWS;
  }
});
