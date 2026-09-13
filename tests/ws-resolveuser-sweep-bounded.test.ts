// The `resolveUser` re-check sweep cannot be stalled by one hook call, and a
// re-check that changes a socket's user re-sends that socket's view.
//
// The sweep awaited each distinct token in turn, and a round never starts
// while the previous one is out. Measured before the fix: with the hook hanging
// for `key-slow`, a revoked `key-b` was still OPEN 20 s later (the same
// revocation closes in ~5 s without the hang), and so was a token opened and
// revoked after that — one stalled JWKS fetch ended revocation for every
// socket on the server. A healthy-but-slow hook paid linearly: 60 tokens ×
// 150 ms per round.
//
// THE TIMEOUT CHOICE, pinned below: a check that outlives its slot (3 s) keeps
// its sockets OPEN on their last verdict, is not called again while it is still
// out, and its verdict is applied whenever it finally lands. A throw is an
// answer and fails closed (tests/ws-resolveuser-revocation.test.ts); a timeout
// is no answer, and closing on it turns a slow resolver into a reconnect storm
// aimed at the same resolver. It is warned every round it lasts.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";

type S = { n: number; secret: string };
type User = { id: string; role: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openSocket(port: number, tok: string) {
  const frames: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tok}`);
  let closed: number | null = null;
  let closedAt = 0;
  const closedP = new Promise<void>((r) =>
    ws.onclose = (e) => {
      closed = e.code;
      closedAt = Date.now();
      r();
    }
  );
  ws.onmessage = (e) => frames.push(String(e.data));
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  return {
    ws,
    frames,
    closedP,
    closed: () => closed,
    closedAt: () => closedAt,
  };
}
type Sock = Awaited<ReturnType<typeof openSocket>>;

async function closeAll(socks: Sock[]) {
  for (const s of socks) s.ws.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(socks.map((s) => s.closedP)),
    new Promise((r) => timer = setTimeout(r, 1500)),
  ]);
  clearTimeout(timer);
}

const waitClosed = async (s: Sock, ms: number) => {
  const deadline = Date.now() + ms;
  while (s.closed() === null && Date.now() < deadline) await sleep(100);
};

Deno.test("ws sweep: a hanging resolveUser does not stop other tokens' revocation, and its late verdict still lands", async () => {
  _resetAuthFails();
  const c = cell("sweep_hang", {
    state: { n: 0 },
    access: true,
    visible: "all",
    methods: {},
  });
  const revoked = new Set<string>();
  const calls: Record<string, number> = {};
  let hang = false;
  let release: ((u: User | null) => void) | undefined;
  await using srv = await testServer({
    cells: [c],
    resolveUser: (tok: string) => {
      calls[tok] = (calls[tok] ?? 0) + 1;
      if (tok === "key-slow" && hang) {
        return new Promise<User | null>((r) => release = r);
      }
      return tok.startsWith("key-") && !revoked.has(tok)
        ? { id: tok, role: "user" }
        : null;
    },
  });
  const slow = await openSocket(srv.port, "key-slow");
  const b = await openSocket(srv.port, "key-b");
  try {
    const slowBefore = calls["key-slow"] ?? 0;
    hang = true;
    revoked.add("key-b");
    // Sweep period (5 s) + the hung check's slot (3 s) + slack.
    await waitClosed(b, 12_000);
    assertEquals(
      b.closed(),
      1008,
      "a revoked token must close even while another token's check hangs",
    );
    assertEquals(slow.closed(), null, "a timed-out check keeps its socket");

    // A whole further round with the hook still hung: `key-slow` is not
    // called again (no pile-up of never-settling calls), yet the round runs —
    // a token revoked NOW still closes.
    const d = await openSocket(srv.port, "key-d");
    revoked.add("key-d");
    await waitClosed(d, 12_000);
    assertEquals(d.closed(), 1008, "later rounds still run");
    assertEquals(
      calls["key-slow"]! - slowBefore,
      1,
      "one outstanding call per token, however many rounds pass",
    );

    // The hook finally answers "revoked": the verdict is applied on arrival,
    // not thrown away because its round moved on.
    assert(release, "the hung call was made");
    release(null);
    await waitClosed(slow, 2_000);
    assertEquals(slow.closed(), 1008, "a late verdict still closes");
    await closeAll([d]);
  } finally {
    release?.(null);
    await closeAll([slow, b]);
    _resetAuthFails();
  }
});

Deno.test("ws sweep: distinct tokens are re-checked in parallel, not one after another", async () => {
  _resetAuthFails();
  const c = cell("sweep_par", {
    state: { n: 0 },
    access: true,
    visible: "all",
    methods: {},
  });
  const revoked = new Set<string>();
  await using srv = await testServer({
    cells: [c],
    resolveUser: async (tok: string) => {
      // Only the sweep is slow: the handshake answers at once.
      if (revoked.has(tok)) {
        await sleep(400);
        return null;
      }
      return tok.startsWith("key-") ? { id: tok, role: "user" } : null;
    },
  });
  const N = 16;
  const socks: Sock[] = [];
  for (let i = 0; i < N; i++) {
    socks.push(await openSocket(srv.port, `key-${i}`));
  }
  try {
    for (let i = 0; i < N; i++) revoked.add(`key-${i}`);
    const deadline = Date.now() + 15_000;
    while (socks.some((s) => s.closed() === null) && Date.now() < deadline) {
      await sleep(100);
    }
    assert(socks.every((s) => s.closed() === 1008), "all revoked tokens close");
    const times = socks.map((s) => s.closedAt());
    const spread = Math.max(...times) - Math.min(...times);
    // Serial: 16 × 400 ms = 6.4 s between the first close and the last (and
    // longer than the 5 s sweep). A pool of 8: two batches, ~0.4 s apart.
    assert(
      spread < 3_000,
      `closes spread over ${spread} ms — checked serially`,
    );
  } finally {
    await closeAll(socks);
    _resetAuthFails();
  }
});

Deno.test("ws sweep: a re-check that changes the socket's role re-sends its view, with no state change", async () => {
  _resetAuthFails();
  const vault = cell("sweep_role", {
    state: { n: 0, secret: "TOPSECRET-7" },
    access: true,
    visible: {
      forUser: (s: S, u?: { role?: string }) =>
        u?.role === "admin" ? s : { n: s.n, secret: "" },
    },
    methods: {},
  });
  const roles: Record<string, string> = { "key-a": "admin" };
  await using srv = await testServer({
    cells: [vault],
    resolveUser: (tok: string) =>
      roles[tok] ? { id: tok, role: roles[tok]! } : null,
  });
  const a = await openSocket(srv.port, "key-a");
  try {
    await sleep(300);
    assert(
      a.frames.some((f) => f.includes("TOPSECRET-7")),
      "the admin view holds the secret",
    );
    roles["key-a"] = "user";
    const mark = a.frames.length;
    const deadline = Date.now() + 8_000;
    const demoted = () =>
      a.frames.slice(mark).find((f) =>
        f.includes('"t":"state"') && f.includes("sweep_role")
      );
    while (!demoted() && Date.now() < deadline) await sleep(100);
    const frame = demoted();
    assert(frame, "a demoted socket must be sent its new view while idle");
    assert(!frame.includes("TOPSECRET-7"), frame);
    assertEquals(a.closed(), null, "a role change is not a revocation");
  } finally {
    await closeAll([a]);
    _resetAuthFails();
  }
});
