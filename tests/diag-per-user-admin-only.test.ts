// Dev `diag` frames cross the per-user boundary only to ADMINS — real server.
//
// The server forwarded every diagnostic-bus event to every socket. A reduce
// error's diag carries the thrown message verbatim — whatever the method put in
// it — so with per-user auth, bob's dev overlay showed alice's failures: the
// hunt observed `card rejected: SECRET-FAIL-2222` in bob's frames. An exposed
// dev server on a LAN is an ordinary setup, so "dev only" bounded nothing.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const SECRET = `SECRET-${crypto.randomUUID()}`;

type S = { n: number };
const vault = cell("diagvault", {
  state: { n: 0 } as S,
  access: true,
  visible: "all",
  methods: {
    fail(_s: S, note: string) {
      throw new Error(`card rejected: ${note}`);
    },
  },
});

function openWs(port: number, token: string) {
  const frames: string[] = [];
  // deno-lint-ignore no-explicit-any
  const ws = new (WebSocket as any)(`ws://127.0.0.1:${port}/ws`, {
    headers: { authorization: `Bearer ${token}` },
  }) as WebSocket;
  let onFrame = () => {};
  ws.onmessage = (e) => {
    frames.push(String(e.data));
    onFrame();
  };
  const opened = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws failed to open"));
  });
  const closed = new Promise<void>((res) => (ws.onclose = () => res()));
  /** Resolves once a frame matching `pred` has arrived (or after `ms`). */
  const waitFor = (pred: (f: string) => boolean, ms: number) =>
    new Promise<boolean>((res) => {
      if (frames.some(pred)) return res(true);
      const t = setTimeout(() => res(false), ms);
      onFrame = () => {
        if (frames.some(pred)) {
          clearTimeout(t);
          res(true);
        }
      };
    });
  return { ws, frames, opened, closed, waitFor };
}

Deno.test("diag: a user's reduce error reaches admin sockets, never another user's", async () => {
  await using srv = await testServer({
    cells: [vault],
    users: {
      "tok-alice": { id: "alice", role: "user" },
      "tok-bob": { id: "bob", role: "user" },
      "tok-carol": { id: "carol", role: "admin" },
    },
  });
  const alice = openWs(srv.port, "tok-alice");
  const bob = openWs(srv.port, "tok-bob");
  const carol = openWs(srv.port, "tok-carol");
  try {
    await Promise.all([alice.opened, bob.opened, carol.opened]);
    const isDiag = (f: string) =>
      f.includes('"t":"diag"') && f.includes(SECRET);
    alice.ws.send(JSON.stringify({
      v: 2,
      t: "action",
      d: { type: "diagvault:fail", payload: { args: [SECRET] }, cid: "c1" },
    }));
    // The admin receiving it is the positive control: the event WAS published
    // and forwarded, so bob not having it is the gate, not a missing event.
    assert(
      await carol.waitFor(isDiag, 5000),
      "the admin must still see the diag event",
    );
    // Give bob the same frame's worth of time on the same server tick.
    await bob.waitFor(isDiag, 300);
    assertEquals(
      bob.frames.filter(isDiag),
      [],
      "another user's error text must not reach bob",
    );
  } finally {
    for (const c of [alice, bob, carol]) c.ws.close();
    await Promise.all([alice.closed, bob.closed, carol.closed]);
  }
});
