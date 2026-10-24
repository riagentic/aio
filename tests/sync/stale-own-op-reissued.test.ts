// tests/sync/stale-own-op-reissued.test.ts — an offline edit stamped "too
// old" only because the device clock was behind is made again, not dropped.
//
// The server refuses an UNKNOWN op stamped older than its tombstone window
// (STALE_OP_REASON): it cannot tell a swept resend from a new change. A board
// with no RTC, offline from boot, stamps every edit days in the past — and on
// reconnect EVERY offline edit was refused and dropped (`onDrop`, reason
// stale-beyond-retention): the local-first promise broken at its one job. The
// client CAN tell by TIME: a tombstone is swept no sooner than the window
// after its op was applied, so an op this page load made less than the
// window ago was never applied, whichever tab sent it. It is re-issued (new
// id, corrected stamp) in place — measured across a reload by the device-clock
// stamp in its queue entry. Anything older may be a swept resend and is still
// dropped — never applied twice.
import { assert, assertEquals } from "@std/assert";
import { createNet } from "./_net.ts";
import { log } from "../../src/diagnostics/logger-api.ts";
import { STALE_OP_REASON } from "../../src/sync/types.ts";
import { createMemoryStorage } from "../../src/sync/op-buffer.ts";

const CELL = "doc";
type S = { items: string[] };
const apply = (s: Record<string, unknown>, _a: string, p: unknown) => ({
  items: [...(s as S).items, (p as { v: string }).v],
});
const HOUR = 3600_000;

function quiet() {
  const orig = log.warn;
  const warns: string[] = [];
  (log as { warn: unknown }).warn = (_c: string, m: string) =>
    void warns.push(m);
  return { warns, restore: () => ((log as { warn: unknown }).warn = orig) };
}

Deno.test("stale reissue: offline edits on a clock 3 days behind all land, in order", async () => {
  const q = quiet();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({ items: [] }),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const pi = net.addClient("pi", undefined, {
      now: () => Date.now() - 72 * HOUR,
    });
    // Offline from boot: nothing heard from the server yet.
    pi.online = false;
    pi.engine.setOnline(false);
    for (const v of ["a", "b", "c"]) {
      await pi.engine.handleLocalAction(CELL, "add", { v });
    }
    pi.online = true;
    pi.engine.setOnline(true);
    await net.pump();
    assertEquals(net.live(), { items: ["a", "b", "c"] });
    assertEquals(pi.confirmed(), { items: ["a", "b", "c"] });
    assertEquals(pi.view(), { items: ["a", "b", "c"] });
    assertEquals(await pi.buffer.getUnconfirmed(CELL), []);
    assertEquals(rejected, [], "the app was not told of a lost change");
    assertEquals(
      q.warns.filter((w) => /made again as op/.test(w)).length,
      1,
      `said once: ${JSON.stringify(q.warns)}`,
    );
  } finally {
    q.restore();
    await net.close();
  }
});

/** Two tabs of one browser share the queue. Tab A makes X offline, tab B
 *  flushes it (applied, ack lost), and 25 h pass for everyone — the server
 *  too — on the device clock, and on the monotonic one unless the machine
 *  was suspended (which pauses it). X's tombstone may be swept by then, so
 *  tab A's stale refusal of X must drop it, never make it again. */
async function twoTabs(suspended: boolean): Promise<void> {
  const q = quiet();
  const rejected: string[] = [];
  const realNow = Date.now;
  let passed = 0;
  const net = createNet({
    cell: CELL,
    initial: () => ({ items: [] }),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const storage = createMemoryStorage();
    let mon = 0;
    const a = net.addClient("pi", storage, {
      now: () => Date.now(),
      mono: () => performance.now() + mon,
    });
    a.online = false;
    a.engine.setOnline(false);
    await a.engine.handleLocalAction(CELL, "add", { v: "x" });
    const [x] = await a.buffer.getUnconfirmed(CELL);
    const b = net.addClient("pi", storage);
    await b.engine.requestSync();
    for (const m of b.outbox.splice(0)) {
      const f = JSON.parse(m);
      if (f.t === "sync-req") {
        net.handler.handleSync(f.d, { id: "b" }, b.socket);
      }
    }
    await new Promise((r) => setTimeout(r, 30));
    b.inbox.length = 0; // the ack is lost
    b.engine.dispose();
    net.clients.splice(net.clients.indexOf(b), 1);
    assertEquals(net.live(), { items: ["x"] });
    passed = 25 * HOUR;
    Date.now = () => realNow() + passed;
    if (!suspended) mon = passed;
    a.online = true;
    await a.engine.handleRejection(
      CELL,
      x!.id,
      `${STALE_OP_REASON}: stamped 25h ago`,
    );
    a.engine.setOnline(true);
    await net.pump();
    assertEquals(net.live(), { items: ["x"] }, "applied once, not twice");
    assertEquals(await a.buffer.getUnconfirmed(CELL), []);
    assertEquals(rejected.length, 1, "the drop is said");
  } finally {
    Date.now = realNow;
    q.restore();
    await net.close();
  }
}

// aio-ok: twoTabs asserts the single application and the drop
Deno.test("stale reissue: two tabs — an op made 25 h ago (monotonic clock) is dropped, never applied twice", () =>
  twoTabs(false));

// aio-ok: twoTabs asserts the single application and the drop
Deno.test("stale reissue: two tabs — 25 h on the device clock alone (a suspend) is dropped too", () =>
  twoTabs(true));

/** A reload while still offline: a new session over the same queue. The op's
 *  in-memory reading died with the page; the device-clock stamp its queue
 *  entry carries measures it. It used to be dropped — the offline edit lost. */
async function reloaded(agedMs: number): Promise<
  { rejected: string[]; live: unknown }
> {
  const q = quiet();
  const rejected: string[] = [];
  const realNow = Date.now;
  const net = createNet({
    cell: CELL,
    initial: () => ({ items: [] }),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const storage = createMemoryStorage();
    const before = net.addClient("pi", storage, {
      now: () => Date.now() - 72 * HOUR,
    });
    before.online = false;
    before.engine.setOnline(false);
    await before.engine.handleLocalAction(CELL, "add", { v: "old" });
    before.engine.dispose();
    net.clients.splice(net.clients.indexOf(before), 1);
    Date.now = () => realNow() + agedMs; // device and server alike
    const after = net.addClient("pi", storage, {
      now: () => Date.now() - 72 * HOUR,
    });
    await after.engine.requestSync();
    await net.pump();
    return { rejected, live: net.live() };
  } finally {
    Date.now = realNow;
    q.restore();
    await net.close();
  }
}

Deno.test("stale reissue: an edit made before a reload, still offline, lands", async () => {
  const r = await reloaded(0);
  assertEquals(r.rejected, []);
  assertEquals(r.live, { items: ["old"] });
});

Deno.test("stale reissue: a reloaded op made past the window (device clock) is still dropped", async () => {
  const r = await reloaded(25 * HOUR);
  assertEquals(r.rejected.length, 1, r.rejected.join(" | "));
  assertEquals(r.live, { items: [] });
});

Deno.test("stale reissue: a clock the refusal cannot correct makes the change again ONCE, then drops it", async () => {
  const q = quiet();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({ items: [] }),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const pi = net.addClient("pi", undefined, {
      now: () => Date.now() - 72 * HOUR,
    });
    // An old server: no `serverNow`, so nothing corrects the clock and the
    // re-made op is stamped just as old — it must not loop.
    const e = pi.engine;
    const rej = e.handleRejection.bind(e);
    e.handleRejection = (cell, id, reason) => rej(cell, id, reason, undefined);
    await e.handleLocalAction(CELL, "add", { v: "a" });
    await net.pump();
    assertEquals(rejected.length, 1, rejected.join(" | "));
    assert(rejected[0]!.startsWith(STALE_OP_REASON), rejected[0]);
    assertEquals(net.live(), { items: [] });
    assertEquals(await pi.buffer.getUnconfirmed(CELL), []);
    const sent = pi.sentLog.filter((m) => JSON.parse(m).t === "op").length;
    assertEquals(sent, 2, "the original and ONE re-made op");
  } finally {
    q.restore();
    await net.close();
  }
});
