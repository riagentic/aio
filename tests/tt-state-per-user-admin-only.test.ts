// Dev `tt-state` frames cross the per-user boundary only to ADMINS — real server.
//
// The time-travel panel's frame is the whole action log: every action's type,
// timing and recorded error message, whoever dispatched it. It went to every
// socket — on connect and on every coalesced flush — so with per-user auth
// bob's frames listed alice's actions (the r3 auth hunt saw them in a non-admin
// socket). The panel is operator tooling: the same bar as `tt-cmd`, which
// already refused non-admins, and as the `diag` frame beside it.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const MARK = `ttsecret${crypto.randomUUID().slice(0, 8)}`;

type S = { n: number };
const ledger = cell("ttledger", {
  state: { n: 0 } as S,
  access: true,
  visible: "all",
  methods: {
    [MARK](s: S) {
      s.n++;
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
  /** Resolves once a frame matching `pred` has arrived (or false after `ms`). */
  const waitFor = (pred: (f: string) => boolean, ms: number) =>
    new Promise<boolean>((res) => {
      if (frames.some(pred)) return res(true);
      const t = setTimeout(() => {
        onFrame = () => {};
        res(false);
      }, ms);
      onFrame = () => {
        if (frames.some(pred)) {
          clearTimeout(t);
          onFrame = () => {};
          res(true);
        }
      };
    });
  return { ws, frames, opened, closed, waitFor };
}

const isTT = (f: string) => f.includes('"t":"tt-state"');
const isTTWithMark = (f: string) => isTT(f) && f.includes(MARK);

Deno.test("tt-state: a user's action log reaches admin sockets, never another user's — on flush and on connect", async () => {
  await using srv = await testServer({
    cells: [ledger],
    users: {
      "tok-alice": { id: "alice", role: "user" },
      "tok-bob": { id: "bob", role: "user" },
      "tok-carol": { id: "carol", role: "admin" },
    },
  });
  const alice = openWs(srv.port, "tok-alice");
  const bob = openWs(srv.port, "tok-bob");
  const carol = openWs(srv.port, "tok-carol");
  const late = { bob: undefined as ReturnType<typeof openWs> | undefined };
  const lateCarol = { c: undefined as ReturnType<typeof openWs> | undefined };
  try {
    await Promise.all([alice.opened, bob.opened, carol.opened]);
    // Positive control for the CONNECT path: the admin's greeting carries it.
    assert(
      await carol.waitFor(isTT, 3000),
      "the admin's connect greeting must carry tt-state (time travel is on)",
    );
    alice.ws.send(JSON.stringify({
      v: 2,
      t: "action",
      d: { type: `ttledger:${MARK}`, payload: { args: [] }, cid: "c1" },
    }));
    // Positive control for the FLUSH path: the event was recorded and sent.
    assert(
      await carol.waitFor(isTTWithMark, 5000),
      "the admin must still receive the coalesced tt-state flush",
    );
    // The flush goes to every socket in one loop — give bob a window past it.
    await bob.waitFor(isTTWithMark, 600);
    assertEquals(
      bob.frames.filter(isTT).length,
      0,
      "a non-admin socket must receive no tt-state frame at all",
    );
    // …and a socket that connects AFTER the action: the greeting path.
    late.bob = openWs(srv.port, "tok-bob");
    lateCarol.c = openWs(srv.port, "tok-carol");
    await Promise.all([late.bob.opened, lateCarol.c.opened]);
    assert(
      await lateCarol.c.waitFor(isTTWithMark, 3000),
      "a late admin's greeting carries the history",
    );
    await late.bob.waitFor((f) => f.includes('"t":"boot"'), 3000);
    assertEquals(
      late.bob.frames.filter(isTT).length,
      0,
      "a late non-admin's greeting must not carry the history",
    );
  } finally {
    const all = [alice, bob, carol, late.bob, lateCarol.c].filter((x) =>
      x !== undefined
    );
    for (const c of all) c.ws.close();
    await Promise.all(all.map((c) => c.closed));
  }
});
