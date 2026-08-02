// Regression tests for the browser-transport fixes that previously had none
//. Each drives the real module seam rather than a mock of it.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  _armAckTimer,
  _pendingAckCount,
  _registerAck,
  _rejectAck,
  _rejectAllPending,
  _resolveAck,
  _setAckTimeoutMs,
  ackMethodKey,
  ARMS_ACK_TIMER,
  armsAckTimer,
} from "../src/protocol/browser-ack.ts";
import { backoffDelay } from "../src/protocol/transport-shared.ts";
import { cell as browserCell } from "../src/protocol/protocol-cell.ts";
import { markAsync } from "../src/state/cell-impl.ts";

// ── the ack registry's terms are set by whoever registers FIRST ───────────

Deno.test("ack: a deferred registration does not start the clock until armed", async () => {
  _rejectAllPending(new Error("reset"));
  _setAckTimeoutMs(40);
  try {
    const p = _registerAck("cid-defer", { deferTimer: true, methodKey: "c:m" });
    p.catch(() => {}); // may reject later; don't surface as unhandled
    await new Promise((r) => setTimeout(r, 90)); // well past the ceiling
    assertEquals(
      _pendingAckCount(),
      1,
      "an action still sitting in the offline queue must not time out",
    );
    _armAckTimer("cid-defer"); // the frame goes out now
    await assertRejects(() => p, Error, "no response");
  } finally {
    _setAckTimeoutMs(0);
    _rejectAllPending(new Error("cleanup"));
  }
});

Deno.test("ack: the FIRST registration fixes the entry's terms", async () => {
  _rejectAllPending(new Error("reset"));
  const first = _registerAck("cid-same", {
    deferTimer: true,
    methodKey: "c:m",
  });
  const second = _registerAck("cid-same"); // a later layer re-registering
  assertEquals(
    first,
    second,
    "re-registering the same cid returns the SAME promise — so the binding " +
      "layer must register with the terms the transport needs",
  );
  _resolveAck("cid-same", "v");
  assertEquals(await first, "v");
});

Deno.test("ack: methodKey derivation matches the server's budget key", () => {
  assertEquals(ackMethodKey({ type: "cart:add" }), "cart:add");
  assertEquals(
    ackMethodKey({ type: "cart:__exec", payload: { _method: "checkout" } }),
    "cart:checkout",
    "async methods travel as __exec — the budget is keyed by the real name",
  );
});

Deno.test("ack: transports that arm their own clock are marked", () => {
  const plain = () => {};
  assertEquals(armsAckTimer(plain), false, "a custom sendFn arms nothing");
  (plain as unknown as Record<symbol, boolean>)[ARMS_ACK_TIMER] = true;
  assertEquals(armsAckTimer(plain), true);
  assertEquals(armsAckTimer(undefined), false);
});

Deno.test("ack: _rejectAllPending settles every in-flight call at once", async () => {
  _rejectAllPending(new Error("reset"));
  const a = _registerAck("cid-a", { deferTimer: true });
  const b = _registerAck("cid-b", { deferTimer: true });
  assertEquals(_pendingAckCount(), 2);
  const n = _rejectAllPending(new Error("connection lost"));
  assertEquals(n, 2, "a known-dead connection fails its calls immediately");
  await assertRejects(() => a, Error, "connection lost");
  await assertRejects(() => b, Error, "connection lost");
  assertEquals(_pendingAckCount(), 0);
});

Deno.test("ack: a dropped queued action is rejected, not left to time out", async () => {
  _rejectAllPending(new Error("reset"));
  const p = _registerAck("cid-drop", { deferTimer: true });
  assert(
    _rejectAck("cid-drop", new Error("action dropped — offline queue full")),
    "the drop path can settle the caller directly",
  );
  await assertRejects(() => p, Error, "queue full");
});

// ── reconnect backoff comes from the shared authority ─────────────────────

Deno.test("backoff: jittered and capped by the shared helper", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 50; i++) seen.add(backoffDelay(3));
  assert(seen.size > 1, "jitter must vary — clients cannot retry in lockstep");
  for (let retry = 0; retry < 12; retry++) {
    const d = backoffDelay(retry);
    assert(d > 0 && d <= 8000 * 1.2, `delay ${d} outside the shared bound`);
  }
});

// ── the browser cell stub mirrors the server's async classification ───────

Deno.test("browser stub: markAsync is honored, as on the server", () => {
  const def = browserCell("mstub", {
    state: { n: 0 },
    methods: {
      plain(s: { n: number }) {
        s.n++;
      },
      // The documented escape hatch for minifiers that rewrite
      // `constructor.name` — the case the browser bundle exists for.
      marked: markAsync((...args: unknown[]) =>
        Promise.resolve((args[0] as { n: number }).n)
      ),
      real: async function (s: { n: number }) {
        await Promise.resolve();
        s.n++;
      },
    },
  });
  const async_ = (def.__aio as { asyncMethods: Set<string> }).asyncMethods;
  assertEquals(async_.has("real"), true, "a real async fn is async");
  assertEquals(
    async_.has("marked"),
    true,
    "and so is one tagged with markAsync — otherwise its dispatch carries no " +
      "_callId and `await cell.method()` resolves undefined",
  );
  assertEquals(async_.has("plain"), false);
});
