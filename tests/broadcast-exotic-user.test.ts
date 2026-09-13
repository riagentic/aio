// ONE client whose user record cannot be JSON-stringified must not take the
// app off the air.
//
// The broadcaster's per-view cache key was
// `${JSON.stringify(meta.user ?? null)}|${subs}`, built for EVERY client on
// EVERY round, inside the round-wide `try`. So one user record `JSON` refuses
// killed the round — for every client, on every round after it. Measured: a
// `resolveUser` handing back an ORM row whose `orgId` is a BigInt (what
// `node:sqlite` returns past `Number` range, and what every postgres driver
// returns for `int8`) froze every connected UI permanently. Health went
// degraded after five rounds, so it was loud on the server and completely
// invisible in the browser.
//
// The sibling reader of the same field — `userMemoKey`, used by the memoized
// UI state — was hardened for exactly this, and carries the argument in its
// own comment: "a cache miss costs time; a wrong cache hit costs someone
// else's data". Two readers of one field, one hardened, one not.
import { assert } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frames = { ws: WebSocket; frames: unknown[]; open: Promise<boolean> };

function openWs(port: number, token: string): Frames {
  const frames: unknown[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t === "state" || m.t === "patches") frames.push(m);
  };
  const open = new Promise<boolean>((res) => {
    // The guard timer has to be CLEARED on the path that wins, not just left
    // to fire into a promise that is already settled. It was not: a socket
    // that opened in 3 ms left a 5-second timer running, the test finished
    // long before it, and the run failed with "2 timers were started in this
    // test, but never completed" — a leak report about the harness, on a test
    // whose own assertions had all passed.
    const bail = setTimeout(() => res(false), 5000);
    const settle = (v: boolean) => {
      clearTimeout(bail);
      res(v);
    };
    ws.onopen = () => settle(true);
    ws.onerror = () => settle(false);
  });
  return { ws, frames, open };
}

Deno.test("broadcast: an unserializable user record does not freeze other clients", async () => {
  const port = freePort();
  // deno-lint-ignore no-explicit-any
  const docs = cell("bxu_docs", {
    state: { rows: [] as string[], n: 0 },
    access: true,
    visible: "all",
    methods: {
      bump(s: { rows: string[]; n: number }) {
        s.n += 1;
        s.rows.push(`tick-${s.n}`);
      },
    },
  }) as any;
  const app = await aio.run({
    cells: [docs],
    appId: `bxu-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await tempDir("aio-bxu-"),
    // A BigInt is the ordinary case, not an exotic one: it is what a driver
    // hands back for an integer past Number's range.
    resolveUser: (tok: string) =>
      tok === "exotic"
        ? { id: "bob", role: "user", orgId: 12345678901234567890n }
        : tok === "plain"
        ? { id: "alice", role: "user" }
        : null,
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    const alice = openWs(port, "plain");
    await alice.open;
    const bob = openWs(port, "exotic");
    await bob.open;
    await sleep(400);
    const a0 = alice.frames.length;
    const b0 = bob.frames.length;
    for (let i = 0; i < 5; i++) {
      await docs.bump();
      await sleep(120);
    }
    await sleep(800);
    assert(
      alice.frames.length - a0 >= 3,
      `the healthy client stopped receiving state: ${
        alice.frames.length - a0
      } frames for 5 dispatches`,
    );
    assert(
      bob.frames.length - b0 >= 3,
      `the client with the exotic user received nothing: ${
        bob.frames.length - b0
      } frames`,
    );
    // …and the app does not report itself broken.
    const h = await (await fetch(`http://127.0.0.1:${port}/__aio/health`, {
      headers: { authorization: "Bearer plain" },
    })).json();
    assert(
      h.status === "healthy",
      `health went ${h.status}: ${JSON.stringify(h.degraded ?? {})}`,
    );
    alice.ws.close();
    bob.ws.close();
  } finally {
    await app.close();
  }
});
