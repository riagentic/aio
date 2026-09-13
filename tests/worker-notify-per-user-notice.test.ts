// A `notify()` from a `worker: true` cell, raised inside a signed-in user's
// call, is shown to every user — and the server SAYS so, once, exactly as it
// does for a main-isolate cell (tests/notify-per-user-notice.test.ts).
//
// A worker cell's notify is posted home and shown by the worker pool's effect
// router in aio.ts, not by the dispatch loop's — and only the dispatch loop
// had been taught the notice. So the same method, moved into a worker, put
// alice's "Card declined" on bob's screen with nothing anywhere naming it.
// In-isolate harnesses cannot see this (the cell runs through the dispatch
// loop there), which is why this test names `workers: "real"`.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { wpinger } from "./fixtures/worker-notify-user-app.ts";

const ENTRY =
  new URL("./fixtures/worker-notify-user-app.ts", import.meta.url).href;

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

Deno.test("notify from a REAL worker cell: raised in a signed-in user's call → delivered app-wide, and named once", async () => {
  const lines: string[] = [];
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = push;
  console.info = push;
  console.warn = push;
  console.error = push;
  const alice = { c: undefined as ReturnType<typeof openWs> | undefined };
  const bob = { c: undefined as ReturnType<typeof openWs> | undefined };
  try {
    await using srv = await testServer({
      cells: [wpinger],
      workers: "real",
      workerEntry: ENTRY,
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
        d: { type: "wpnotice:ping", payload: { args: [body] }, cid },
      }));
    const bobGot = async (body: string) => {
      for (
        let i = 0;
        i < 150 && !bob.c!.frames.some((f) => f.includes(body));
        i++
      ) await sleep(20);
      return bob.c!.frames.some((f) =>
        f.includes('"t":"notify"') && f.includes(body)
      );
    };

    // A server-origin notify (no user in scope) crosses no user boundary.
    await srv.app.dispatch({
      type: "wpnotice:ping",
      payload: { args: ["from-server"] },
    } as never);
    assert(await bobGot("from-server"), "the worker's notify reached clients");
    assertEquals(
      lines.filter((l) => NOTICE.test(l)).length,
      0,
      `a call with no user in scope must not warn:\n${lines.join("\n")}`,
    );

    call("c1", "alice-1");
    call("c2", "alice-2");
    assert(
      await bobGot("alice-1") && await bobGot("alice-2"),
      "the documented contract holds: every connected client receives it",
    );
    assertEquals(
      lines.filter((l) => NOTICE.test(l)).length,
      1,
      `named once, not per call:\n${lines.join("\n")}`,
    );
  } finally {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
    for (const x of [alice.c, bob.c]) x?.ws.close();
    await Promise.all([alice.c?.closed, bob.c?.closed]);
  }
});
