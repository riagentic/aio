// The paced writer every WebSocket frame of a page goes through
// (`src/protocol/send-pacer.ts`): the bound it promises, checked on a fake
// clock rather than trusted from the arithmetic in its comment.
//
// The server counts frames in one-second windows against the budget it
// advertises (`ProtoHello.rate`). A pacer that lets `rate` frames through in
// one window is not a pacer — a burst of 150 calls against the default 100
// dropped 50 and got the tab closed and blocked. So the property is: in EVERY
// one-second interval, at most 80% of the advertised rate leaves, however the
// frames arrive; nothing is dropped, nothing reordered.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createSendPacer,
  paceBudget,
  type PacedFrame,
} from "../src/protocol/send-pacer.ts";

/** A deterministic clock + timer queue the pacer runs on. */
function fakeClock() {
  let t = 1_000_000;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((x) => x.id !== id);
    },
    /** Advance to `ms` from now, firing due timers in order. */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

Deno.test("paceBudget: 80% of the advertised rate per window, and a default for a silent peer", () => {
  assertEquals(paceBudget(100), { perSec: 60, burst: 20 });
  assertEquals(
    paceBudget(undefined),
    paceBudget(100),
    "older server → default",
  );
  assertEquals(paceBudget(Number.NaN), paceBudget(100));
  assertEquals(paceBudget(0), paceBudget(100), "a nonsense rate is not 0/sec");
  const tiny = paceBudget(2);
  assert(tiny.perSec > 0 && tiny.burst >= 1, "a tiny budget still moves");
});

for (const rate of [100, 10, 1000]) {
  Deno.test(`send pacer (rate ${rate}): no 1 s interval exceeds 80% of the budget; nothing lost or reordered`, () => {
    const clock = fakeClock();
    const sentAt: number[] = [];
    const order: number[] = [];
    const p = createSendPacer<PacedFrame>({
      write: (e) => {
        sentAt.push(clock.now());
        order.push(e.seq);
      },
      onRefused: () => {
        throw new Error("nothing refuses here");
      },
      rate: () => rate,
      ...clock,
    });
    // A burst of 15x the budget at once, then a second one mid-drain.
    const N = rate * 15;
    for (let i = 0; i < N; i++) p.push({ frame: `f${i}`, seq: i });
    clock.advance(3_000);
    for (let i = N; i < N + rate; i++) p.push({ frame: `f${i}`, seq: i });
    clock.advance(60_000);

    assertEquals(order.length, N + rate, "every frame left");
    assertEquals(sentAt.length, N + rate, "…each with its send time");
    assertEquals(order, [...order].sort((a, b) => a - b), "in arrival order");
    assertEquals(p.length, 0);
    assertEquals(clock.pending(), 0, "an idle pacer holds no timer");
    // Sliding one-second windows over every send.
    const cap = Math.floor(rate * 0.8);
    let lo = 0;
    for (let hi = 0; hi < sentAt.length; hi++) {
      while (sentAt[hi]! - sentAt[lo]! >= 1000) lo++;
      assert(
        hi - lo + 1 <= cap,
        `${hi - lo + 1} frames within 1 s at ${sentAt[hi]} — over ${cap}`,
      );
    }
  });
}

Deno.test("send pacer: a single frame is written immediately — ordinary use is not slower", () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const p = createSendPacer<PacedFrame>({
    write: (e) => void sent.push(e.frame),
    onRefused: () => {},
    rate: () => 100,
    ...clock,
  });
  assertEquals(p.push({ frame: "a", seq: 1 }), "sent");
  assertEquals(sent, ["a"]);
  assertEquals(clock.pending(), 0);
});

Deno.test("send pacer: hold() stops ALL writes until the server's window reopens; a re-sent frame keeps its place", () => {
  const clock = fakeClock();
  const sent: number[] = [];
  const p = createSendPacer<PacedFrame>({
    write: (e) => void sent.push(e.seq),
    onRefused: () => {},
    rate: () => 100,
    ...clock,
  });
  p.hold(500);
  assertEquals(p.push({ frame: "x", seq: 10 }), "queued", "held — not sent");
  p.push({ frame: "y", seq: 11 });
  // The refused frame comes back with its ORIGINAL (earlier) seq.
  p.push({ frame: "retry", seq: 3 });
  clock.advance(499);
  assertEquals(sent, [], "nothing leaves inside the hold");
  clock.advance(10);
  assertEquals(sent, [3, 10, 11], "the re-sent frame first, then the rest");
});

Deno.test("send pacer: an immediate refusal throws to the caller; a drain-time refusal hands back everything waiting", () => {
  const clock = fakeClock();
  let refuse = false;
  const handedBack: string[][] = [];
  const p = createSendPacer<PacedFrame>({
    write: () => {
      if (refuse) throw new Error("socket closing");
    },
    onRefused: (entries) => void handedBack.push(entries.map((e) => e.frame)),
    rate: () => 10, // burst 2
    ...clock,
  });
  p.push({ frame: "a", seq: 1 });
  p.push({ frame: "b", seq: 2 });
  p.push({ frame: "c", seq: 3 }); // queued: burst spent
  p.push({ frame: "d", seq: 4 });
  refuse = true;
  clock.advance(5_000);
  assertEquals(handedBack, [["c", "d"]], "the refused frame and all behind it");
  assertEquals(p.length, 0);
  clock.advance(1_000);
  assertThrows(() => p.push({ frame: "e", seq: 5 }), Error, "socket closing");
});

Deno.test("send pacer: take() returns what is waiting, in order, and disarms", () => {
  const clock = fakeClock();
  const p = createSendPacer<PacedFrame>({
    write: () => {},
    onRefused: () => {},
    rate: () => 5, // burst 1
    ...clock,
  });
  for (let i = 0; i < 5; i++) p.push({ frame: `f${i}`, seq: i });
  assertEquals(p.take().map((e) => e.frame), ["f1", "f2", "f3", "f4"]);
  assertEquals(clock.pending(), 0);
});
