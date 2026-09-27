// A delta that arrives while the client holds no base state (the reconnect
// window: `setTransport` resets the initial-state flag) is DROPPED — and the
// client must then ask for a full state, the rule state-message.ts states for
// "every path that does not apply a delta". This path returned "dropped"
// silently: the server believes the delta was delivered, the client never
// applied it, and nothing asks for the repair.
import { assert, assertEquals } from "@std/assert";
import { handleMessage } from "../src/state/state-message.ts";
import { setTransport } from "../src/state-core.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

Deno.test("delta before the first state after reconnect is dropped AND resynced", () => {
  _resetAioRuntime();
  try {
    const sent: string[] = [];
    // A connected client with state…
    setTransport(
      {
        send: (d: string) => sent.push(d),
        close: () => {},
      } as unknown as Parameters<typeof setTransport>[0],
    );
    handleMessage({ counter: { n: 1 } });
    // …reconnects: the new transport resets the initial-state flag.
    setTransport(
      {
        send: (d: string) => sent.push(d),
        close: () => {},
      } as unknown as Parameters<typeof setTransport>[0],
    );
    const r = handleMessage({
      $patches: [{ op: "replace", path: ["counter", "n"], value: 2 }],
    });
    assertEquals(r, "dropped");
    assert(
      sent.some((s) => /"t":"resync"/.test(s)),
      `a dropped delta leaves the client behind the server — it must ask for ` +
        `a full state. Sent: ${JSON.stringify(sent)}`,
    );
  } finally {
    _resetAioRuntime();
  }
});

Deno.test("early deltas ask for ONE resync per wait, not one each", () => {
  _resetAioRuntime();
  try {
    const sent: string[] = [];
    const t = {
      send: (d: string) => sent.push(d),
      close: () => {},
    } as unknown as Parameters<typeof setTransport>[0];
    const resyncs = () => sent.filter((s) => /"t":"resync"/.test(s)).length;
    const delta = {
      $patches: [{ op: "replace", path: ["counter", "n"], value: 2 }],
    };
    setTransport(t);
    handleMessage({ counter: { n: 1 } });
    setTransport(t);
    for (let i = 0; i < 30; i++) handleMessage(delta);
    // Each resync costs the server one full snapshot.
    assertEquals(resyncs(), 1);
    // …but a lost ask is asked again, not waited on forever.
    for (let i = 0; i < 3; i++) handleMessage(delta); // drop #33
    assertEquals(resyncs(), 2);
    // The full state ends the wait; the next reconnect may ask again.
    handleMessage({ counter: { n: 2 } });
    setTransport(t);
    handleMessage(delta);
    assertEquals(resyncs(), 3);
  } finally {
    _resetAioRuntime();
  }
});
