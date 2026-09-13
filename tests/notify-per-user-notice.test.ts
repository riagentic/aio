// A `notify()` raised inside a signed-in user's call is shown to every user —
// and the server now SAYS so, once.
//
// docs/clients/notifications.md: "the server hands it to every connected UI
// client". Under per-user auth that is every user's session, so alice's
// "SECRET" toast reached bob's socket (r3 auth hunt) with nothing anywhere
// naming it. The contract is public and frozen, so the delivery is unchanged
// (bob still receives it — asserted, so this test notices if that ever
// changes); what changes is that the app is told the first time it relies on
// it with a user in scope. A call with no user in scope says nothing.
import { assert, assertEquals } from "@std/assert";
import { cell, notify } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const pinger = cell("pnotice", {
  state: { n: 0 },
  access: true,
  visible: "all",
  methods: {
    ping(s, body: string) {
      s.n++;
      s.$do(notify({ title: "Card declined", body }));
    },
  },
});

function openWs(port: number, token: string) {
  const frames: string[] = [];
  // deno-lint-ignore no-explicit-any
  const ws = new (WebSocket as any)(`ws://127.0.0.1:${port}/ws`, {
    headers: { authorization: `Bearer ${token}` },
  }) as WebSocket;
  ws.onmessage = (e) => frames.push(String(e.data));
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws failed to open"));
  });
  const closed = new Promise<void>((res) => (ws.onclose = () => res()));
  return { ws, frames, opened, closed };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOTICE = /shown on EVERY connected UI client, other users' sessions/;

Deno.test("notify: raised in a signed-in user's call → delivered app-wide as documented, and named once", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = push;
  console.warn = push;
  console.error = push;
  const alice = { c: undefined as ReturnType<typeof openWs> | undefined };
  const bob = { c: undefined as ReturnType<typeof openWs> | undefined };
  try {
    await using srv = await testServer({
      cells: [pinger],
      users: {
        "tok-alice": { id: "alice", role: "user" },
        "tok-bob": { id: "bob", role: "user" },
      },
    });
    alice.c = openWs(srv.port, "tok-alice");
    bob.c = openWs(srv.port, "tok-bob");
    await Promise.all([alice.c.opened, bob.c.opened]);
    const call = (cid: string, body: string) =>
      alice.c!.ws.send(JSON.stringify({
        v: 2,
        t: "action",
        d: { type: "pnotice:ping", payload: { args: [body] }, cid },
      }));

    // A server-origin notify (no user in scope) crosses no user boundary.
    await srv.app.dispatch({
      type: "pnotice:ping",
      payload: { args: ["from-server"] },
    } as never);
    await sleep(150);
    assertEquals(
      lines.filter((l) => NOTICE.test(l)).length,
      0,
      "a call with no user in scope must not warn",
    );

    call("c1", "alice-1");
    call("c2", "alice-2");
    for (
      let i = 0;
      i < 100 && bob.c.frames.filter((f) => /alice-2/.test(f)).length === 0;
      i++
    ) await sleep(20);
    assert(
      bob.c.frames.some((f) => f.includes('"t":"notify"') && /alice-1/.test(f)),
      "the documented contract holds: every connected client receives it",
    );
    assertEquals(
      lines.filter((l) => NOTICE.test(l)).length,
      1,
      `named once, not per call:\n${lines.join("\n")}`,
    );
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    for (const x of [alice.c, bob.c]) x?.ws.close();
    await Promise.all([alice.c?.closed, bob.c?.closed]);
  }
});
