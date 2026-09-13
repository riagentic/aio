// `broadcastUi` — the `notify()` toast path — honours the WS high-water mark.
//
// Every other send loop in server-broadcast.ts checks `bufferedAmount`; this
// one did not, so a burst of notifications kept being queued on the server's
// heap for a peer that had stopped reading. A toast is fire-and-forget UI with
// no state behind it, so the frame is SKIPPED for that peer (not the peer
// closed, as a raw sync frame must be) — said once per peer, and not counted
// as delivered.
import { assert, assertEquals } from "@std/assert";
import { createBroadcaster } from "../src/server/server-broadcast.ts";
import { WS_BUFFER_HIGH_WATER } from "../src/server/write-backlog.ts";
import { log } from "../src/diagnostics/logger-api.ts";
import type { ClientMeta } from "../src/server/server-ws.ts";

function fakeClient(index: number, bufferedAmount: number) {
  const sent: string[] = [];
  const closes: number[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount,
    send: (m: string) => sent.push(m),
    close: (code: number) => closes.push(code),
  } as unknown as WebSocket;
  const meta = {
    id: `c${index}`,
    index,
    clientType: "browser",
    isElectron: false,
    msgCount: 0,
    bytesThisSec: 0,
    bpMultiplier: 1,
    bpConsecutiveLow: 0,
    bpLastSentAt: 0,
    subscriptions: null,
    disconnected: false,
    consecutiveDrops: 0,
  } as unknown as ClientMeta;
  return { ws, meta, sent, closes };
}

Deno.test("broadcastUi: a toast skips a peer over the high-water mark, keeps it open, says so once, and counts only deliveries", () => {
  const stuck = fakeClient(1, WS_BUFFER_HIGH_WATER + 1);
  const fine = fakeClient(2, 0);
  const connections = new Map<WebSocket, ClientMeta>([
    [stuck.ws, stuck.meta],
    [fine.ws, fine.meta],
  ]);
  const broadcaster = createBroadcaster({
    connections,
    payloadStats: new Map(),
    getUIState: () => ({}),
    debug: () => {},
    syncIntervalMs: 10,
  });
  const warns: string[] = [];
  const origWarn = log.warn;
  // deno-lint-ignore no-explicit-any
  log.warn = ((a: string, b?: string) => warns.push(b ?? a)) as any;
  try {
    const raw = '{"v":2,"t":"notify","d":{"title":"hi"}}';
    const first = broadcaster.broadcastUi(raw);
    const second = broadcaster.broadcastUi(raw);
    assertEquals([first, second], [1, 1], "only the draining peer counts");
    assertEquals(stuck.sent.length, 0, "nothing queued for the stuck peer");
    assertEquals(stuck.closes, [], "a toast is not worth a user's connection");
    assertEquals(fine.sent.length, 2, "the draining peer gets every toast");
    const named = warns.filter((w) => /client #1/.test(w));
    assertEquals(
      named.length,
      1,
      `said once per peer: ${JSON.stringify(warns)}`,
    );
    assert(/not draining/.test(named[0]!));
  } finally {
    log.warn = origWarn;
    broadcaster.shutdown();
  }
});
