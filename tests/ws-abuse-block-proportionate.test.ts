// The anti-abuse block stays — for a client that is NOT aio's own, which
// ignores the refusals and keeps flooding — but it is answered, proportionate,
// and it ends.
//
// Before: the frame that crossed the 50-drop line closed the socket without
// being answered; every block was a flat 60 s from the first strike, keyed by
// ADDRESS (so every page from that address was locked out with it); and a
// refused handshake was a debug line, so from the server's log it looked like
// nobody was trying to connect.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { abuseBlockMs } from "../src/server/server-ws.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("abuse block: 5 s for a first strike, doubling per repeat, capped at 60 s", () => {
  assertEquals(
    [1, 2, 3, 4, 5, 6, 20].map(abuseBlockMs),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000],
  );
  assertEquals(abuseBlockMs(0), 5_000, "a nonsense strike is a first strike");
});

Deno.test("abuse block: a flooding raw socket has EVERY dropped frame answered, is closed, is refused with 429 — and an aio client reconnects when the block ends", async () => {
  const c = cell("flood", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-flood-");
  const app = await aio.run({
    cells: [c],
    appId: `flood-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    // The DEFAULT budget of 100: the cid arithmetic below (f0..f98 in budget,
    // f99..f148 the 50 drops) is sized to it. (This used to say a tiny budget
    // trips the server-wide fuse first; the fuse now counts only frames that
    // passed the per-client check — see server-ws.ts — so it no longer does.)
    // deno-lint-ignore no-explicit-any
  } as any);
  const g = globalThis as Record<string, unknown>;
  let unsub: (() => void) | null = null;
  try {
    // ── the abusive peer: fires 200 frames and never listens to a refusal ──
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const acks = new Map<string, { ok: boolean; retryAfterMs?: number }>();
    const closed = new Promise<void>((res) => {
      // Not asserting 1008: the peer is still mid-write when the server
      // closes, so the close is unclean on this side and arrives without it.
      ws.onclose = () => res();
    });
    ws.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t !== "ack") return;
      const d = f.d as { cid?: string; ok?: boolean; retryAfterMs?: number };
      if (typeof d.cid === "string") {
        acks.set(d.cid, { ok: d.ok === true, retryAfterMs: d.retryAfterMs });
      }
    };
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("socket failed to open"));
    });
    // The hello is frame 1 of the budget of 100.
    ws.send(enc("proto", protoHello()));
    for (let i = 0; i < 200; i++) {
      ws.send(enc("action", { type: "flood:bump", payload: {}, cid: `f${i}` }));
    }
    const timedOut = await Promise.race([
      closed.then(() => false),
      sleep(5_000).then(() => true),
    ]);
    assert(!timedOut, "a 200-frame flood was never closed");
    // Frame 1 was the hello, f0..f98 fit the budget, f99..f148 are the 50
    // drops — the 50th of which closes the socket. Every one is answered.
    const unanswered = Array.from({ length: 50 }, (_, i) => `f${99 + i}`)
      .filter((cid) => !acks.has(cid));
    assertEquals(
      unanswered,
      [],
      "a dropped frame is answered — including the one that closed the socket",
    );
    assertEquals(acks.get("f148")?.ok, false);
    assert(
      typeof acks.get("f148")?.retryAfterMs === "number",
      "…with when the window reopens",
    );

    // ── the address is blocked, briefly, and says for how long ──
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/ws`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    const body = await r.text();
    assertEquals(r.status, 429, body);
    const retryAfter = Number(r.headers.get("retry-after"));
    assert(
      retryAfter >= 1 && retryAfter <= 5,
      `a first strike blocks for at most 5 s, got retry-after ${retryAfter}`,
    );

    // ── an aio client from the same address comes back when it ends ──
    const u = new URL(`http://127.0.0.1:${port}`);
    g.location = {
      protocol: u.protocol,
      host: u.host,
      search: "",
      origin: u.origin,
    };
    await import("../src/browser/browser-air-transport.ts");
    const { client, ensureConnected } = await import(
      "../src/browser/browser-protocol.ts"
    );
    const { _registerAck } = await import("../src/browser/browser-ack.ts");
    const sub = await import("../src/browser/protocol-subscription.ts");
    unsub = sub._subscribe(() => {});
    // A call made while the address is still blocked queues, and lands.
    const action = (c.__aio.actions.bump as () => { type: string })();
    const cid = crypto.randomUUID();
    const call = _registerAck(cid, {
      deferTimer: true,
      methodKey: action.type,
    });
    client.send({ ...action, cid } as { type: string });
    ensureConnected();
    await call;
    const took = Date.now() - t0;
    // Block (≤5 s) + one reconnect backoff at its ceiling (8 s ±20%) + slack.
    assert(
      took < 5_000 + 9_600 + 2_000,
      `the client reconnected ${took} ms after the block began — a retry ` +
        `stuck behind a minute-long block would take 60 s`,
    );
    assertEquals(
      (app.getState() as { flood: { n: number } }).flood.n,
      100,
      "f0..f98 from the flood, plus the aio client's queued call",
    );
  } finally {
    unsub?.();
    await sleep(400);
    await app.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
