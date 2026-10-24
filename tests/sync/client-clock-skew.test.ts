// tests/sync/client-clock-skew.test.ts — a device whose clock is wrong.
//
// `HLClock.receive` ignores a remote clock more than `maxDrift` away, so a
// client far BEHIND kept stamping its ops with its own wrong time: >60 s behind
// it lost last-write-wins with edits it made AFTER a peer's, and >24 h behind
// (a Pi with no RTC before NTP) every fresh edit was refused as a "stale
// resend" whose reason never named the clock. The server now sends its wall
// clock (`serverNow`) with every ack and catch-up; a client off by more than
// `maxDrift` adopts the server's offset for its HLC and says so once, with the
// measured offset.
import { assert, assertEquals } from "@std/assert";
import { createNet } from "./_net.ts";
import { log } from "../../src/diagnostics/logger-api.ts";
import { STALE_OP_REASON } from "../../src/sync/types.ts";
import type { HLC } from "../../src/sync/types.ts";
import { compareHLC } from "../../src/sync/hlc.ts";

const CELL = "doc";
type S = Record<string, unknown>;
const apply = (_s: S, _a: string, p: unknown) => p as S;
const MIN = 60_000;
const ops = (sent: string[]) =>
  sent.map((m) => JSON.parse(m)).filter((f) => f.t === "op");

function captureWarns() {
  const warns: string[] = [];
  const orig = log.warn;
  (log as { warn: unknown }).warn = (_ch: string, msg: string) =>
    void warns.push(msg);
  return { warns, restore: () => ((log as { warn: unknown }).warn = orig) };
}

Deno.test("clock skew: a client 5 min behind stamps a later edit AFTER a peer's earlier one, and says so", async () => {
  const cap = captureWarns();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const peer = net.addClient("peer");
    const late = net.addClient("late", undefined, {
      now: () => Date.now() - 5 * MIN,
    });
    await peer.engine.requestSync();
    await late.engine.requestSync();
    await net.pump();
    await peer.engine.handleLocalAction(CELL, "set", { v: "peer" });
    await net.pump();
    await new Promise((r) => setTimeout(r, 5));
    await late.engine.handleLocalAction(CELL, "set", { v: "late" });
    await net.pump();
    const p: HLC = ops(peer.sentLog).at(-1)!.d.hlc;
    const l: HLC = ops(late.sentLog).at(-1)!.d.hlc;
    assert(
      l[0] > p[0],
      `the later edit must carry the later stamp — late ${l[0]} vs peer ${
        p[0]
      }`,
    );
    assertEquals(rejected, []);
    const said = cap.warns.filter((w) => /clock/.test(w));
    assertEquals(said.length, 1, `said once: ${JSON.stringify(cap.warns)}`);
    assert(/300s behind/.test(said[0]!), said[0]);
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a client 25 h behind (no RTC) is not refused as a stale resend", async () => {
  const cap = captureWarns();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const pi = net.addClient("pi", undefined, {
      now: () => Date.now() - 25 * 60 * MIN,
    });
    await pi.engine.requestSync();
    await net.pump();
    await pi.engine.handleLocalAction(CELL, "set", { v: "pi" });
    await net.pump();
    assert(
      !rejected.some((r) => r.startsWith(STALE_OP_REASON)),
      `refused: ${rejected.join(" | ")}`,
    );
    assertEquals(net.live(), { v: "pi" });
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a client within maxDrift keeps its own clock and says nothing", async () => {
  const cap = captureWarns();
  const net = createNet({ cell: CELL, initial: () => ({}), apply });
  try {
    const c = net.addClient("c", undefined, { now: () => Date.now() - 30_000 });
    await c.engine.requestSync();
    await net.pump();
    await c.engine.handleLocalAction(CELL, "set", { v: 1 });
    await net.pump();
    const h: HLC = ops(c.sentLog).at(-1)!.d.hlc;
    assert(h[0] <= Date.now() - 29_000, "within the drift window: no offset");
    assertEquals(cap.warns.filter((w) => /clock/.test(w)), []);
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a client 10 min AHEAD is not refused for clock drift once it has heard the server", async () => {
  const cap = captureWarns();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const c = net.addClient("c", undefined, {
      now: () => Date.now() + 10 * MIN,
    });
    await c.engine.requestSync();
    await net.pump();
    await c.engine.handleLocalAction(CELL, "set", { v: "ahead" });
    await net.pump();
    assertEquals(rejected, []);
    assertEquals(net.live(), { v: "ahead" });
    assert(cap.warns.some((w) => /600s ahead of the server's/.test(w)));
  } finally {
    cap.restore();
    await net.close();
  }
});

// ── The corrected clock runs on the monotonic clock, not the device's ──────
// The offset used to be `deviceNow() + offset`: when the OS later corrected the
// device clock (NTP finally reached a Pi), the corrected time jumped ahead by
// the whole offset, the server refused every edit as clock drift, and the HLC
// (which never runs back) kept the client locked out for the whole offset.
const HOUR = 60 * MIN;

Deno.test("clock skew: an NTP step after the offset was adopted refuses nothing", async () => {
  const cap = captureWarns();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    let skew = -25 * HOUR;
    const pi = net.addClient("pi", undefined, { now: () => Date.now() + skew });
    await pi.engine.requestSync();
    await net.pump();
    await pi.engine.handleLocalAction(CELL, "set", { v: 1 });
    await net.pump();
    skew = 0; // NTP fixes the device clock
    await pi.engine.handleLocalAction(CELL, "set", { v: 2 });
    await net.pump();
    assertEquals(rejected, []);
    assertEquals(net.live(), { v: 2 });
    const h: HLC = ops(pi.sentLog).at(-1)!.d.hlc;
    assert(Math.abs(h[0] - Date.now()) < 5_000, `stamped ${h[0]}`);
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a client whose HLC already ran ahead recovers once the server is heard", async () => {
  const cap = captureWarns();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const c = net.addClient("c", undefined, {
      now: () => Date.now() + 10 * MIN,
    });
    // An edit BEFORE any catch-up: stamped 10 min ahead, refused as drift.
    await c.engine.handleLocalAction(CELL, "set", { v: "early" });
    await net.pump();
    assertEquals(rejected.length, 1);
    assert(/clock drift/.test(rejected[0]!), rejected[0]);
    await c.engine.handleLocalAction(CELL, "set", { v: "after" });
    await net.pump();
    assertEquals(rejected.length, 1, `refused again: ${rejected.join(" | ")}`);
    assertEquals(net.live(), { v: "after" });
    const said = cap.warns.filter((w) => /clock is \d+s/.test(w));
    assertEquals(said.length, 1, JSON.stringify(cap.warns));
    assert(/600s ahead of the server's/.test(said[0]!), said[0]);
    assert(/server's time/.test(said[0]!), said[0]);
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: an edit stamped ahead before the catch-up is named in the warning as refused", async () => {
  const cap = captureWarns();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const c = net.addClient("c", undefined, {
      now: () => Date.now() + 10 * MIN,
    });
    c.engine.setOnline(false);
    await c.engine.handleLocalAction(CELL, "set", { v: "offline" });
    c.engine.setOnline(true);
    await c.engine.requestSync();
    await net.pump();
    const said = cap.warns.filter((w) => /clock is \d+s/.test(w));
    assertEquals(said.length, 1, JSON.stringify(cap.warns));
    assert(
      /refuse/i.test(said[0]!),
      `must say the earlier edit is refused: ${said[0]}`,
    );
    await c.engine.handleLocalAction(CELL, "set", { v: "next" });
    await net.pump();
    assertEquals(net.live(), { v: "next" });
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a frame that arrives late (frozen tab) is not taken as an offset", async () => {
  const cap = captureWarns();
  const net = createNet({ cell: CELL, initial: () => ({}), apply });
  try {
    let mono = 1_000;
    let late = 0;
    // The device clock is RIGHT; the catch-up is read 2 min after it was
    // sent (the net stamps `serverNow` at delivery, so the device reads
    // 2 min ahead for that one frame).
    const c = net.addClient("c", undefined, {
      now: () => Date.now() + late,
      mono: () => mono,
    });
    await c.engine.requestSync();
    late = 2 * MIN;
    mono += 2 * MIN;
    await net.pump();
    late = 0;
    await c.engine.handleLocalAction(CELL, "set", { v: 1 });
    await net.pump();
    // Neither taken as an offset nor flipped back: nothing to say.
    assertEquals(cap.warns.filter((w) => /clock/.test(w)), []);
    const h: HLC = ops(c.sentLog).at(-1)!.d.hlc;
    assert(Math.abs(h[0] - Date.now()) < 5_000, "kept its own (right) clock");
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a device hovering near the limit does not flip-flop or warn twice", async () => {
  const cap = captureWarns();
  const net = createNet({ cell: CELL, initial: () => ({}), apply });
  try {
    let skew = -70_000;
    const c = net.addClient("c", undefined, { now: () => Date.now() + skew });
    await c.engine.requestSync();
    await net.pump();
    for (const s of [-55_000, -65_000, -50_000, -61_000]) {
      skew = s;
      await c.engine.handleLocalAction(CELL, "set", { v: s });
      await net.pump();
    }
    const said = cap.warns.filter((w) => /clock/.test(w));
    assertEquals(said.length, 1, JSON.stringify(said));
  } finally {
    cap.restore();
    await net.close();
  }
});

// ── Every good sample is checked, and the device clock against the
//    monotonic one ─────────────────────────────────────────────────────────

Deno.test("clock skew: an HLC that ran ahead from boot recovers though the device clock agrees by the first catch-up", async () => {
  // `createHLC` reads the device clock at creation: a device 3 h ahead then,
  // corrected by NTP before the first catch-up, agrees with the server — and
  // the HLC, which never runs back, still stamped 3 h ahead: every edit
  // refused as drift for 3 h.
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    let skew = 3 * HOUR;
    const c = net.addClient("c", undefined, { now: () => Date.now() + skew });
    skew = 0;
    await c.engine.requestSync();
    await net.pump();
    for (let i = 0; i < 3; i++) {
      await c.engine.handleLocalAction(CELL, "set", { v: i });
      await net.pump();
    }
    assertEquals(rejected, []);
    assertEquals(net.live(), { v: 2 });
    const h: HLC = ops(c.sentLog).at(-1)!.d.hlc;
    assert(Math.abs(h[0] - Date.now()) < 5_000, `stamped ${h[0]}`);
  } finally {
    await net.close();
  }
});

Deno.test("clock skew: an NTP step BACK after the server's time was adopted refuses nothing", async () => {
  const cap = captureWarns();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    let skew = 10 * MIN;
    const c = net.addClient("c", undefined, { now: () => Date.now() + skew });
    await c.engine.requestSync();
    await net.pump();
    await c.engine.handleLocalAction(CELL, "set", { v: 1 });
    await net.pump();
    skew = 0;
    await c.engine.handleLocalAction(CELL, "set", { v: 2 });
    await net.pump();
    assertEquals(rejected, []);
    assertEquals(net.live(), { v: 2 });
    const h: HLC = ops(c.sentLog).at(-1)!.d.hlc;
    assert(Math.abs(h[0] - Date.now()) < 5_000, `stamped ${h[0]}`);
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a device clock stepped part of the way keeps the server's time", async () => {
  // A step back that does not reach the right time (3 h ahead to 2 h) moves
  // nothing that is stamped, 10 min later as well (the HLC alone would hide
  // a carried time that fell behind: it never runs back).
  const steps: [number, number][] = [[3 * HOUR, 2 * HOUR]];
  const realNow = Date.now;
  for (const [from, to] of steps) {
    let later = 0;
    Date.now = () => realNow() + later;
    const cap = captureWarns();
    const rejected: string[] = [];
    const net = createNet({
      cell: CELL,
      initial: () => ({}),
      apply,
      sync: { onRejected: (i) => void rejected.push(i.reason) },
    });
    try {
      let skew = from;
      const c = net.addClient("c", undefined, {
        now: () => Date.now() + skew,
        mono: () => performance.now() + later,
      });
      await c.engine.requestSync();
      await net.pump();
      skew = to;
      later = 10 * MIN;
      c.engine.setOnline(false);
      await c.engine.handleLocalAction(CELL, "set", { v: to });
      const h: HLC = (await c.buffer.getUnconfirmed(CELL)).at(-1)!.hlc;
      assert(
        Math.abs(h[0] - Date.now()) <= 60_000,
        `${from} → ${to}: stamped ${h[0] - Date.now()}ms off`,
      );
      c.engine.setOnline(true);
      await c.engine.requestSync();
      await net.pump();
      assertEquals(rejected, [], `${from} → ${to}`);
      assertEquals(net.live(), { v: to });
    } finally {
      Date.now = realNow;
      cap.restore();
      await net.close();
    }
  }
});

Deno.test("clock skew: a forward step that misses the right time fails loud, once", async () => {
  // 25 h behind to 45 s behind reads like a suspend: the later reading is
  // taken, the edit is refused as drift (with the server's time), it is said,
  // and the next edit lands.
  const cap = captureWarns();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    let skew = -25 * HOUR;
    const c = net.addClient("c", undefined, { now: () => Date.now() + skew });
    await c.engine.requestSync();
    await net.pump();
    skew = -45_000;
    await c.engine.handleLocalAction(CELL, "set", { v: 1 });
    await net.pump();
    assertEquals(rejected.length, 1);
    assert(/clock drift/.test(rejected[0]!), rejected[0]);
    assert(
      cap.warns.some((w) => /clock jumped/.test(w)),
      cap.warns.join(" | "),
    );
    await c.engine.handleLocalAction(CELL, "set", { v: 2 });
    await net.pump();
    assertEquals(rejected.length, 1, rejected.join(" | "));
    assertEquals(net.live(), { v: 2 });
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a device behind that sleeps about as long as it is behind keeps the server's time", async () => {
  // The suspend parts the clocks by S while the device reads B behind: with
  // |S − B| ≤ maxDrift it was taken for an NTP step and the device clock — B
  // behind — stamped again, in silence (review probe). Only a sleep as long as
  // the offset to within what a sample measures can still read as a step, and
  // then it is SAID once the next sample shows it.
  const cases: [number, number, boolean][] = [
    [120_000, 100_000, true],
    [70_000, 40_000, true],
    [90_000, 2 * HOUR, true],
    [90_000, 90_000, false],
  ];
  const realNow = Date.now;
  for (const [behind, sleep, right] of cases) {
    let slept = 0;
    Date.now = () => realNow() + slept;
    const cap = captureWarns();
    const net = createNet({ cell: CELL, initial: () => ({}), apply });
    try {
      const c = net.addClient("c", undefined, {
        now: () => Date.now() - behind,
      });
      await c.engine.requestSync();
      await net.pump();
      const before = cap.warns.length;
      slept = sleep;
      await c.engine.handleLocalAction(CELL, "set", { v: "woke" });
      const h: HLC = ops(c.sentLog).at(-1)!.d.hlc;
      await net.pump();
      const said = cap.warns.slice(before);
      const tag = `behind ${behind} sleep ${sleep}`;
      if (right) {
        assert(
          Math.abs(h[0] - Date.now()) < 5_000,
          `${tag}: ${h[0] - Date.now()}`,
        );
        assertEquals(said, [], tag);
      } else {
        assertEquals(said.length, 1, `${tag}: ${JSON.stringify(said)}`);
        assert(/jumped .* behind the server's time/.test(said[0]!), said[0]);
      }
      await c.engine.handleLocalAction(CELL, "set", { v: "next" });
      const n: HLC = ops(c.sentLog).at(-1)!.d.hlc;
      assert(
        Math.abs(n[0] - Date.now()) < 5_000,
        `${tag} next: ${n[0] - Date.now()}`,
      );
    } finally {
      Date.now = realNow;
      cap.restore();
      await net.close();
    }
  }
});

Deno.test("clock skew: a suspend (the monotonic clock paused) does not leave the server's time behind", async () => {
  // `performance.now()` does not advance while the system sleeps (macOS,
  // Linux CLOCK_MONOTONIC); the device clock does. Carried only on the
  // monotonic clock, the server's time came out of a 2 h sleep 2 h old.
  const cap = captureWarns();
  const rejected: string[] = [];
  const realNow = Date.now;
  let slept = 0;
  // Wall time (server and device alike) moves on; `performance.now()` does not.
  Date.now = () => realNow() + slept;
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const c = net.addClient("c", undefined, {
      now: () => Date.now() - 25 * HOUR,
    });
    await c.engine.requestSync();
    await net.pump();
    slept = 2 * HOUR;
    await c.engine.handleLocalAction(CELL, "set", { v: "woke" });
    const h: HLC = ops(c.sentLog).at(-1)!.d.hlc;
    assert(Math.abs(h[0] - Date.now()) < 5_000, `stamped ${h[0]}`);
    await net.pump();
    assertEquals(rejected, []);
    assertEquals(net.live(), { v: "woke" });
  } finally {
    Date.now = realNow;
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a frame answered across a suspend is not taken as an offset", async () => {
  // Sent before the sleep, read after it: the monotonic round trip is short,
  // but the server's time in it is as old as the sleep is long.
  const cap = captureWarns();
  const net = createNet({ cell: CELL, initial: () => ({}), apply });
  try {
    let skew = 0;
    const c = net.addClient("c", undefined, { now: () => Date.now() + skew });
    await c.engine.requestSync();
    skew = 2 * HOUR; // the device clock moved on during the sleep; mono did not
    await net.pump();
    assertEquals(cap.warns.filter((w) => /clock/.test(w)), []);
    c.engine.setOnline(false);
    await c.engine.handleLocalAction(CELL, "set", { v: 1 });
    const pending = await c.buffer.getUnconfirmed(CELL);
    const h: HLC = pending.at(-1)!.hlc;
    assert(h[0] >= Date.now() + 2 * HOUR - 5_000, `stamped ${h[0]}`);
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a stale refusal carries the server's time — the refused edit is made again with it, and the next one is not refused", async () => {
  const cap = captureWarns();
  const rejected: string[] = [];
  const net = createNet({
    cell: CELL,
    initial: () => ({}),
    apply,
    sync: { onRejected: (i) => void rejected.push(i.reason) },
  });
  try {
    const pi = net.addClient("pi", undefined, {
      now: () => Date.now() - 25 * HOUR,
    });
    // No catch-up first: the edit is stamped 25 h old and refused as stale.
    // Sent once by this session — so never applied: it is made again on the
    // server's time (tests/sync/stale-own-op-reissued.test.ts), not dropped.
    await pi.engine.handleLocalAction(CELL, "set", { v: "first" });
    await net.pump();
    assertEquals(rejected, [], "re-issued, not lost");
    assertEquals(net.live(), { v: "first" });
    await pi.engine.handleLocalAction(CELL, "set", { v: "next" });
    await net.pump();
    assertEquals(rejected, [], rejected.join(" | "));
    assertEquals(net.live(), { v: "next" });
    const stamps = ops(pi.sentLog).map((f) => f.d.hlc[0] as number);
    assert(
      Date.now() - stamps.at(-2)! < HOUR,
      "the re-issued edit carries the server's time",
    );
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a replaced clock still stamps after an own op in flight the server may take", async () => {
  // A within-drift stamp (device 50 s ahead) and a stamp 3 h ahead go out in
  // one reconnect; the catch-up replaces the HLC before A's ack is read. The
  // next edit must not order before A.
  const cap = captureWarns();
  const net = createNet({ cell: CELL, initial: () => ({}), apply });
  try {
    let skew = 50_000;
    const c = net.addClient("c", undefined, { now: () => Date.now() + skew });
    const e = c.engine;
    e.setOnline(false);
    await e.handleLocalAction(CELL, "set", { v: "A" });
    skew = 3 * HOUR;
    await e.handleLocalAction(CELL, "set", { v: "B" });
    const a: HLC = (await c.buffer.getUnconfirmed(CELL))[0]!.hlc;
    e.handleAck = () => Promise.resolve(); // the acks are not read yet
    e.setOnline(true);
    await e.requestSync();
    await net.pump();
    skew = 0;
    e.setOnline(false);
    await e.handleLocalAction(CELL, "set", { v: "C" });
    const h: HLC = (await c.buffer.getUnconfirmed(CELL)).at(-1)!.hlc;
    assert(h[0] < Date.now() + 2 * MIN, `the clock was replaced: ${h[0]}`);
    assert(compareHLC(h, a) > 0, `C ${h} must order after A ${a}`);
  } finally {
    cap.restore();
    await net.close();
  }
});

Deno.test("clock skew: a server that sends no serverNow leaves the device clock in charge", async () => {
  const cap = captureWarns();
  const net = createNet({ cell: CELL, initial: () => ({}), apply });
  try {
    const c = net.addClient("c", undefined, {
      now: () => Date.now() - 5 * MIN,
    });
    // An old server: no `serverNow` on anything.
    const e = c.engine;
    const res = e.handleSyncResponse.bind(e);
    const ack = e.handleAck.bind(e);
    e.handleSyncResponse = (r) => res({ ...r, serverNow: undefined });
    e.handleAck = (cell, id, h, ts) => ack(cell, id, h, ts, undefined);
    await e.requestSync();
    await net.pump();
    await e.handleLocalAction(CELL, "set", { v: 0 });
    await net.pump();
    assertEquals(net.live(), { v: 0 });
    c.engine.setOnline(false);
    await c.engine.handleLocalAction(CELL, "set", { v: 1 });
    const h: HLC = (await c.buffer.getUnconfirmed(CELL)).at(-1)!.hlc;
    assert(h[0] <= Date.now() - 5 * MIN + 5_000, `stamped ${h[0]}`);
    assertEquals(cap.warns.filter((w) => /clock/.test(w)), []);
  } finally {
    cap.restore();
    await net.close();
  }
});
