// tests/state-transport-handler.test.ts
// Behavior tests for two public exports:
//   - setSyncHandler (src/state/state-transport.ts) — CRDT sync intercept
//     that can claim actions before normal transport dispatch.
//   - resendSubscriptions (src/state/state-subs.ts) — re-emits the current
//     subscription paths through the transport (reconnect flow).
//
// Strategy: pure module-level state, no network. A fake Transport captures
// everything sent; FakeTime drives the 16ms subscription-sync debounce.
// _resetTransport() / _resetSubs() isolate tests (same pattern as
// tests/browser-subscribe.test.ts).

import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  _resetTransport,
  flushOfflineQueue,
  send,
  setSyncHandler,
  setTransport,
  type Transport,
} from "../src/state/state-transport.ts";
import {
  _resetSubs,
  resendSubscriptions,
  trackPath,
} from "../src/state/state-subs.ts";

// ── Harness ─────────────────────────────────────────────────────────

function fakeTransport(): { transport: Transport; sent: string[] } {
  const sent: string[] = [];
  return {
    transport: { send: (data: string) => sent.push(data), close: () => {} },
    sent,
  };
}

function resetAll(): void {
  _resetTransport(); // also clears the sync handler + offline queue
  _resetSubs(); // also cancels the pending subs timer
}

// ── setSyncHandler ──────────────────────────────────────────────────

Deno.test("setSyncHandler: installed handler receives dispatched actions and claims them before transport", () => {
  resetAll();
  try {
    const { transport, sent } = fakeTransport();
    setTransport(transport);

    const received: { type: string; payload?: unknown }[] = [];
    setSyncHandler((action) => {
      received.push(action);
      return true; // claim — must short-circuit normal dispatch
    });

    const ok = send({ type: "todos:add", payload: { text: "x" } });

    assertEquals(ok, true, "claimed send must report success");
    assertEquals(received.length, 1, "handler must receive the action");
    assertEquals(received[0]?.type, "todos:add");
    assertEquals(received[0]?.payload, { text: "x" });
    assertEquals(sent.length, 0, "claimed action must never hit transport");
  } finally {
    resetAll();
  }
});

Deno.test("setSyncHandler: declining handler lets the action flow to transport with _source tag", () => {
  resetAll();
  try {
    const { transport, sent } = fakeTransport();
    setTransport(transport);

    let calls = 0;
    setSyncHandler(() => {
      calls++;
      return false; // decline — normal dispatch continues
    });

    send({ type: "counter:inc" });

    assertEquals(calls, 1, "handler still sees every dispatched action");
    assertEquals(sent.length, 1, "declined action must reach transport");
    const wire = JSON.parse(sent[0]!);
    assertEquals(wire.type, "counter:inc");
    assertEquals(wire._source, "UI", "transport sends carry the UI source tag");
  } finally {
    resetAll();
  }
});

Deno.test("setSyncHandler(null): clears the intercept so actions dispatch normally again", () => {
  resetAll();
  try {
    const { transport, sent } = fakeTransport();
    setTransport(transport);

    let calls = 0;
    setSyncHandler(() => {
      calls++;
      return true;
    });
    send({ type: "a" }); // intercepted
    setSyncHandler(null); // clear
    send({ type: "b" }); // normal dispatch

    assertEquals(calls, 1, "cleared handler must not see later actions");
    assertEquals(sent.length, 1, "only the post-clear action hits transport");
    assertEquals(JSON.parse(sent[0]!).type, "b");
  } finally {
    resetAll();
  }
});

Deno.test("setSyncHandler: claimed actions are not queued offline (handler runs before the queue)", () => {
  resetAll();
  try {
    // No transport installed — unclaimed actions would go to the offline queue.
    const claimed: string[] = [];
    setSyncHandler((action) => {
      claimed.push(action.type);
      return true;
    });

    const ok = send({ type: "sync:op" });
    assertEquals(ok, true);
    assertEquals(claimed, ["sync:op"]);

    // Attach a transport and flush — nothing must come out.
    const { transport, sent } = fakeTransport();
    setTransport(transport);
    flushOfflineQueue();
    assertEquals(sent.length, 0, "claimed action must not have been queued");
  } finally {
    resetAll();
  }
});

// ── resendSubscriptions ─────────────────────────────────────────────

Deno.test("resendSubscriptions: re-emits the current subscription paths through the transport", () => {
  resetAll();
  using time = new FakeTime();
  try {
    const { transport, sent } = fakeTransport();
    setTransport(transport); // wires the subs send fn

    trackPath("counter.value");
    trackPath("todos.items");
    time.tick(20); // fire the 16ms subs-sync debounce

    assertEquals(sent.length, 1, "tracked paths sync once after debounce");
    const expected = '__subs:["counter.value","todos.items"]';
    assertEquals(sent[0], expected);

    sent.length = 0;
    resendSubscriptions();

    assertEquals(sent.length, 1, "resend must emit exactly one message");
    assertEquals(
      sent[0],
      expected,
      "resend must repeat the current subs verbatim",
    );
  } finally {
    resetAll();
  }
});

Deno.test("resendSubscriptions: no-op when no subscriptions have been synced", () => {
  resetAll();
  try {
    const { transport, sent } = fakeTransport();
    setTransport(transport);

    resendSubscriptions();

    assertEquals(sent.length, 0, "nothing to resend — transport stays silent");
  } finally {
    resetAll();
  }
});

Deno.test("resendSubscriptions: after reconnect, subs go to the NEW transport (the real use case)", () => {
  resetAll();
  using time = new FakeTime();
  try {
    const first = fakeTransport();
    setTransport(first.transport);
    trackPath("status.ok");
    time.tick(20);
    assertEquals(first.sent, ['__subs:["status.ok"]']);

    // Reconnect: swap transports, then resend (as the reconnect flow does).
    const second = fakeTransport();
    setTransport(second.transport);
    resendSubscriptions();

    assertEquals(
      second.sent,
      ['__subs:["status.ok"]'],
      "new transport gets the subs",
    );
    assertEquals(first.sent.length, 1, "old transport receives nothing more");
  } finally {
    resetAll();
  }
});
