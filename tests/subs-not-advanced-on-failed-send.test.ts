// A subscription the server never received must not be recorded as sent.
//
// `_scheduleSyncSubs` assigned `_currentSubs = collapsed` and THEN wrote the
// frame. A refused write therefore left the client believing it had subscribed
// to a set the server never saw — and because every later comparison is
// against `_currentSubs`, it found "no change" and never re-sent it. The server
// kept the OLD, narrower subscription, so every cell outside it silently
// stopped updating for the life of that connection: a UI rendering confidently
// stale data with nothing logged anywhere.
//
// Reachable: the transport here is the RAW socket send, and a WebSocket throws
// InvalidStateError on a send while CLOSING. `browser-air-transport.ts` already
// handles exactly that case for ACTIONS ("the socket says OPEN and refuses the
// write") by queueing them; subscriptions had no equivalent. Reconnect calls
// `resendSubscriptions`, so it healed IF the socket closed — a socket that
// refuses a write and stays open never healed at all.
import { assert, assertEquals } from "@std/assert";
import {
  _resetSubs,
  _setSubsSendFn,
  resendSubscriptions,
  trackPath,
} from "../src/state/state-subs.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

const settle = () => new Promise((r) => setTimeout(r, 40));

Deno.test("subs: a refused frame is retried, not recorded as sent", async () => {
  _resetSubs();
  const sent: string[] = [];
  let refuse = true;
  _setSubsSendFn((msg) => {
    if (refuse) throw new Error("InvalidStateError: still in CLOSING state");
    sent.push(msg);
  });
  try {
    trackPath("orders");
    await settle();
    assertEquals(sent.length, 0, "the write was refused");

    // The socket recovers. Nothing new is tracked — the ONLY thing that can
    // put this right is the retry.
    refuse = false;
    await settle();
    await settle();
    assert(
      sent.length > 0,
      "the subscription was never re-sent, so the server keeps the old, " +
        "narrower set and those cells never update again",
    );
    assert(sent[0]!.includes("orders"), sent[0]);
  } finally {
    _setSubsSendFn(null);
    _resetSubs();
  }
});

Deno.test("subs: a frame that WAS sent is not re-sent on every tick", async () => {
  _resetSubs();
  const sent: string[] = [];
  _setSubsSendFn((msg) => sent.push(msg));
  try {
    trackPath("orders");
    await settle();
    assertEquals(sent.length, 1);
    // Tracking the same path again must change nothing.
    trackPath("orders");
    await settle();
    assertEquals(
      sent.length,
      1,
      "an unchanged subscription set must not re-send — that is what " +
        "`_currentSubs` is for",
    );
    // A genuinely new path does send.
    trackPath("invoices");
    await settle();
    assertEquals(sent.length, 2);
  } finally {
    _setSubsSendFn(null);
    _resetSubs();
  }
});

// Loud is not the same as unreadable. The retry runs on a 16 ms timer, so a
// warn-per-attempt policy writes ~60 lines a second — the same flooding the
// rAF loop reporter avoids. First one loud, then counted.
Deno.test("subs: a long refusal does not flood the log", async () => {
  _resetSubs();
  const warns: string[] = [];
  const prev = getLogger();
  // The logger publishes through `pub(level, category, message, data)`.
  setLogger({
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "warn") warns.push(msg);
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  _setSubsSendFn(() => {
    throw new Error("still CLOSING");
  });
  try {
    trackPath("orders");
    // ~300 ms at a 16 ms retry ≈ 18 attempts.
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(
      warns.length,
      1,
      `expected ONE line for a run of identical refusals, got ${warns.length}`,
    );
  } finally {
    _setSubsSendFn(null);
    _resetSubs();
    setLogger(prev);
  }
});

// "No transport yet" is NOT a refusal, and collapsing the two breaks both ends.
//
// A page that has not connected yet has nothing to retry against and nothing
// wrong: `resendSubscriptions()` on connect is precisely how a set collected
// before the socket existed reaches the server. Treating it as a refusal would
// spin the 16 ms retry timer forever AND leave `_currentSubs` empty, so that
// resend would have had nothing to send and the connection would sit on the
// wildcard — every cell pushed to a client that asked for two.
Deno.test("subs: with no transport the set is remembered, not retried forever", async () => {
  _resetSubs();
  _setSubsSendFn(null); // nothing installed yet — the pre-connect state
  try {
    trackPath("orders");
    await settle();
    await settle();

    // Now the socket arrives and the reconnect path replays.
    const sent: string[] = [];
    _setSubsSendFn((msg) => sent.push(msg));
    resendSubscriptions();
    assertEquals(
      sent.length,
      1,
      "the set collected before the socket existed must reach the server on " +
        "connect — that is what `_currentSubs` is for",
    );
    assert(sent[0]!.includes("orders"), sent[0]);
  } finally {
    _setSubsSendFn(null);
    _resetSubs();
  }
});

Deno.test("subs: a refused RESEND is retried, not lost", async () => {
  _resetSubs();
  const sent: string[] = [];
  let refuse = false;
  _setSubsSendFn((msg) => {
    if (refuse) throw new Error("still CLOSING");
    sent.push(msg);
  });
  try {
    trackPath("orders");
    await settle();
    assertEquals(sent.length, 1);

    // A reconnect that races the socket's readiness.
    refuse = true;
    resendSubscriptions();
    assertEquals(sent.length, 1, "the resend was refused");

    refuse = false;
    await settle();
    await settle();
    assertEquals(
      sent.length,
      2,
      "…and it must be retried — otherwise the server stays on the wildcard " +
        "for the life of the connection",
    );
  } finally {
    _setSubsSendFn(null);
    _resetSubs();
  }
});
