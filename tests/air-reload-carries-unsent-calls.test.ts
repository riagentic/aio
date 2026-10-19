// A framework reload (new boot id) must not throw away the calls it could not
// send in time.
//
// `_reloadWhenDrained` waits at most 10 s for the offline queue to leave the
// socket, then reloads. MEASURED in a real dev app (headless Chromium, two
// tabs, server restarted while the UI keeps calling): the dev reload socket
// saw the new boot id ~3 s before the transport's backoff reconnected, and a
// UI calling steadily kept the pacer from ever emptying — so the bound ran
// out and ~200 calls per restart died with the page, with one console line
// (wiped by the reload) as the only trace. The page now carries its unsent
// calls across the reload (sessionStorage, per tab) and the next page sends
// them on its first connection — only once the server's hello on THAT
// connection says it is the same app and the same user, ahead of the next
// page's own calls, each with a fresh cid so the server can answer for it.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { freePort, testServer } from "../src/testing/server-test.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { SIGNED_IN_EVENT } from "../src/browser/auth-client.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as Record<string, unknown>;
const KEY = "aio:reload-carry";
const APP_ID = "carry-app";

const counter = cell("carry", {
  state: { n: 0, log: [] as string[] },
  methods: {
    inc(s: { n: number }) {
      s.n++;
    },
    note(s: { log: string[] }, what: string) {
      s.log.push(what);
    },
    boom() {
      throw new Error("kaboom");
    },
  },
});
const type = (m: string) =>
  (counter.__aio.actions as unknown as Record<string, () => { type: string }>)[
    m
  ]!().type;

const { client, ensureConnected } = await import(
  "../src/browser/browser-protocol.ts"
);
const sub = await import("../src/browser/protocol-subscription.ts");
// `useCell().send` / `useAio().send`: the core transport's door.
const { send: coreSend } = await import("../src/state-core.ts");

/** A real server behind a proxy that can be down, can say any user in the
 *  hello (`helloUser`, as the auth layer would), and records the action
 *  frames it relays. */
async function rig() {
  // An Electron UDS shell has no __aioConfig at import: the app comes from
  // the hello, never from the shell.
  delete g.__aioConfig;
  const srv = await testServer({ cells: [counter], appId: APP_ID });
  const r = {
    up: false,
    helloUser: null as string | null,
    /** Server→client frames held back (in order) while true — a hello that
     *  has not arrived yet. */
    holdS2C: false,
    held: [] as (() => void)[],
    frames: [] as { type?: string; cid?: unknown }[],
    live: [] as WebSocket[],
    state: () => (srv.state() as { carry: { n: number; log: string[] } }).carry,
  };
  const port = freePort();
  const proxy = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (new URL(req.url).pathname !== "/ws" || !r.up) {
        return new Response("down", { status: 503 });
      }
      const { socket: c, response } = Deno.upgradeWebSocket(req);
      const s = new WebSocket(`ws://${new URL(srv.url).host}/ws`);
      const buf: string[] = [];
      s.onopen = () => {
        for (const m of buf.splice(0)) s.send(m);
      };
      c.onmessage = (e) => {
        const f = dec(String(e.data));
        if (f?.t === "action") r.frames.push(f.d as { type?: string });
        s.readyState === WebSocket.OPEN ? s.send(e.data) : buf.push(e.data);
      };
      s.onmessage = (e) => {
        const deliver = () => {
          if (c.readyState !== WebSocket.OPEN) return;
          const f = dec(String(e.data));
          c.send(
            f?.t === "proto"
              ? enc("proto", { ...(f.d as object), user: r.helloUser })
              : e.data,
          );
        };
        r.holdS2C || r.held.length ? r.held.push(deliver) : deliver();
      };
      const kill = () => {
        if (c.readyState < WebSocket.CLOSING) c.close();
        if (s.readyState < WebSocket.CLOSING) s.close();
      };
      c.onclose = kill;
      s.onclose = kill;
      r.live.push(c);
      return response;
    },
  );
  let reloaded = false;
  g.location = {
    protocol: "http:",
    host: `127.0.0.1:${port}`,
    search: "",
    origin: `http://127.0.0.1:${port}`,
    reload: () => {
      reloaded = true;
    },
  };
  return Object.assign(r, {
    reloaded: () => reloaded,
    app: `${APP_ID}@http://127.0.0.1:${port}`,
    async [Symbol.asyncDispose]() {
      await proxy.shutdown();
      await srv[Symbol.asyncDispose]();
    },
  });
}

let page = 0;
const newPage = () =>
  import(`../src/browser/browser-air-transport.ts?page=${++page}`);

/** Connect the current page; returns its "page close" (subscription gone →
 *  client torn down). */
function connect(): () => Promise<void> {
  ensureConnected();
  const unsub = sub._subscribe(() => {});
  return async () => {
    unsub();
    await sleep(500);
  };
}

async function said(
  fn: (out: string[]) => Promise<void>,
): Promise<string[]> {
  const out: string[] = [];
  const { error, warn } = console;
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    await fn(out);
  } finally {
    Object.assign(console, { error, warn });
  }
  return out;
}

const seed = (
  app: string,
  user: string | null | undefined,
  calls: unknown[],
  at = Date.now(),
) => sessionStorage.setItem(KEY, JSON.stringify({ app, user, at, calls }));
const call = (m: string, ...args: unknown[]) => ({
  a: { type: type(m), payload: { args }, _source: "UI" },
});

Deno.test("calls still unsent when a framework reload fires are carried across it and sent by the next page", async () => {
  await using r = await rig();
  sessionStorage.clear();
  await newPage();
  r.up = true;
  let close = connect();
  // The old page's connection: its hello says which app and user it is.
  for (let i = 0; i < 100 && r.live.length === 0; i++) await sleep(20);
  await sleep(300);
  // Down: the socket drops and reconnects are refused.
  r.up = false;
  for (const c of r.live.splice(0)) c.close();
  await sleep(200);
  const N = 40;
  for (let i = 0; i < N; i++) {
    client.send(
      { type: type("inc"), cid: crypto.randomUUID() } as { type: string },
    );
  }
  // A new boot id was seen (the dev reload socket's path) — the transport
  // waits out its drain bound with nowhere to send, then reloads.
  (g.__aioReloadWhenDrained as () => void)();
  for (let i = 0; i < 500 && !r.reloaded(); i++) await sleep(25);
  assertEquals(r.reloaded(), true, "the drain bound ran out and reloaded");
  globalThis.dispatchEvent(new Event("pagehide")); // the old page goes
  await close(); // …and its client with it
  assertEquals(r.state().n, 0, "nothing reached the server before the reload");

  // The NEXT page: a fresh transport module, same tab (same sessionStorage).
  await newPage();
  r.up = true;
  close = connect();
  for (let i = 0; i < 400 && r.state().n < N; i++) await sleep(25);
  assertEquals(r.state().n, N, "every carried call landed via the next page");
  assertEquals(sessionStorage.length, 0, "the carry is consumed once");
  assert(
    r.frames.every((f) => typeof f.cid === "string"),
    "each carried call is sent with a fresh cid, so the server answers for it",
  );
  await close();
});

Deno.test("carried calls are sent only when the connection's hello names the same user — no side request", async () => {
  await using r = await rig();
  r.up = true;
  for (const [now, lands] of [["bob", false], ["alice", true]] as const) {
    sessionStorage.clear();
    seed(r.app, "alice", [call("inc")]);
    r.helloUser = now; // a `users:` token page: the socket knows, no cookie
    const before = r.state().n;
    const lines = await said(async () => {
      await newPage();
      const close = connect();
      for (let i = 0; i < 80 && r.state().n === before; i++) await sleep(25);
      await close();
    });
    assertEquals(r.state().n - before, lands ? 1 : 0, `hello says ${now}`);
    if (!lands) {
      assert(
        lines.some((l) => l.includes("DROPPED") && l.includes("alice")),
        JSON.stringify(lines),
      );
    }
  }
});

Deno.test("a carry from another app on the same origin is dropped loudly at the hello", async () => {
  await using r = await rig();
  r.up = true;
  sessionStorage.clear();
  seed(`other-app@${(g.location as { origin: string }).origin}`, null, [
    call("inc"),
  ]);
  const lines = await said(async (out) => {
    await newPage();
    const close = connect();
    for (let i = 0; i < 80 && !out.some((l) => l.includes("DROPPED")); i++) {
      await sleep(25);
    }
    await close();
  });
  assertEquals(r.state().n, 0);
  assert(
    lines.some((l) => l.includes("DROPPED") && l.includes("different app")),
    JSON.stringify(lines),
  );
});

Deno.test("a sign-in or sign-out before the hello drops the carry loudly", async () => {
  await using r = await rig();
  sessionStorage.clear();
  seed(r.app, null, [call("inc")]);
  const lines = await said(async () => {
    await newPage();
    globalThis.dispatchEvent(new Event(SIGNED_IN_EVENT));
    r.up = true;
    const close = connect();
    await sleep(800);
    await close();
  });
  assertEquals(r.state().n, 0);
  assert(lines.some((l) => l.includes("DROPPED")), JSON.stringify(lines));
});

Deno.test("a carried call the server fails is reported — no caller survived to hear it", async () => {
  await using r = await rig();
  r.up = true;
  sessionStorage.clear();
  seed(r.app, null, [call("boom")]);
  const lines = await said(async (out) => {
    await newPage();
    const close = connect();
    for (let i = 0; i < 80 && !out.some((l) => l.includes("kaboom")); i++) {
      await sleep(25);
    }
    await close();
  });
  assert(
    lines.some((l) => l.includes(type("boom")) && l.includes("kaboom")),
    JSON.stringify(lines),
  );
});

Deno.test("carried calls land before the next page's own calls", async () => {
  await using r = await rig();
  sessionStorage.clear();
  seed(r.app, null, [call("note", "old-1"), call("note", "old-2")]);
  await newPage();
  // The new page calls at once — before any connection, and again the
  // moment it is open but the server has not said hello yet.
  client.send({ type: type("note"), payload: { args: ["new-1"] } });
  r.up = true;
  const close = connect();
  client.send({ type: type("note"), payload: { args: ["new-2"] } });
  for (let i = 0; i < 80 && r.state().log.length < 4; i++) await sleep(25);
  assertEquals(r.state().log, ["old-1", "old-2", "new-1", "new-2"]);
  await close();
});

Deno.test("carried calls land before a useCell().send made after the socket opened but before the server's hello", async () => {
  await using r = await rig();
  sessionStorage.clear();
  seed(r.app, null, [call("note", "old-1"), call("note", "old-2")]);
  await newPage();
  r.holdS2C = true; // the socket opens; the server's hello is still on its way
  r.up = true;
  const close = connect();
  for (let i = 0; i < 100 && r.live.length === 0; i++) await sleep(20);
  await sleep(200);
  coreSend({ type: type("note"), payload: { args: ["core-1"] } });
  client.send({ type: type("note"), payload: { args: ["new-1"] } });
  await sleep(100);
  r.holdS2C = false;
  for (const d of r.held.splice(0)) d();
  for (let i = 0; i < 80 && r.state().log.length < 4; i++) await sleep(25);
  assertEquals(r.state().log, ["old-1", "old-2", "core-1", "new-1"]);
  await close();
});

Deno.test("no hello within the age window drops the carry loudly; a page that goes while holding re-saves it", async () => {
  await using r = await rig(); // stays down: no hello will come
  sessionStorage.clear();
  seed(r.app, null, [call("inc")], Date.now() - 59_500);
  const lines = await said(async (out) => {
    await newPage();
    for (let i = 0; i < 80 && !out.some((l) => l.includes("DROPPED")); i++) {
      await sleep(25);
    }
  });
  assert(
    lines.some((l) => l.includes("DROPPED") && l.includes("no server hello")),
    JSON.stringify(lines),
  );

  sessionStorage.clear();
  const at = Date.now();
  seed(r.app, "alice", [call("inc")], at);
  await newPage(); // holding, no hello yet…
  globalThis.dispatchEvent(new Event("pagehide")); // …and the tab reloads
  const back = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
  assertEquals(back?.calls?.length, 1, "the held carry is saved again");
  assertEquals(back.user, "alice");
  assertEquals(back.at, at, "under its own stamp: the age window still runs");
  // This page holds nothing now; the next one would take it up. Clear the
  // seed so no later page in this process does.
  sessionStorage.clear();
});
