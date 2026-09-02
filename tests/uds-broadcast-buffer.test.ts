// Regression: the UDS broadcast throttle must BUFFER patches across the
// queue/throttle window, never DROP them. The previous implementation
// early-returned without buffering `validPatches` when throttled, then fell
// back to a no-arg full-state send — so under UDS throttling a cell update
// (e.g. an optimistic SOL balance) was silently discarded, freezing the
// electron (UDS) client at its connect-time value until an unrelated dispatch.

import { assert, assertEquals } from "@std/assert";
import { createUdsBroadcastController } from "../src/server/aio-run-helpers.ts";
import type { UDSHandle } from "../src/server/uds.ts";

type Call = boolean | { cell: string; ops: unknown[] }[] | undefined;

function fakeHandle(calls: Call[]): UDSHandle {
  return {
    broadcast: () => {},
    broadcastState: (forceOrPatches) => {
      calls.push(forceOrPatches as Call);
      // The handle reports WHAT IT SENT (see UDSHandle) — this fake pretends
      // one client got a patch, which is all these throttle tests need.
      return { full: 0, patch: 1 };
    },
    shutdown: () => {},
    socketPath: "/tmp/fake.sock",
    clients: () => [],
    requestClientState: () => Promise.resolve(null),
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const after = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

Deno.test("uds throttle buffers patches instead of dropping them", async () => {
  const calls: Call[] = [];
  const syncIntervalMs = 20;
  const ctrl = createUdsBroadcastController({
    getUdsHandle: () => fakeHandle(calls),
    syncIntervalMs,
  });

  const pA = [{ cell: "nav", ops: [{ op: "replace", path: ["i"], value: 1 }] }];
  const pB = [{
    cell: "balances",
    ops: [{ op: "replace", path: ["sol"], value: 48 }],
  }];

  // First call flushes immediately (via microtask) and arms the throttle.
  ctrl.onUdsBroadcast(pA as never);
  await tick();

  // Second call arrives while throttled — must be BUFFERED, not dropped.
  ctrl.onUdsBroadcast(pB as never);

  // After the throttle interval, the buffered balances patch must be delivered
  // as $patches (an array), NOT lost or degraded to a no-arg full-state.
  await after(syncIntervalMs + 15);

  const arrayCalls = calls.filter((
    c,
  ): c is { cell: string; ops: unknown[] }[] => Array.isArray(c));
  const sawBalances = arrayCalls.some((c) =>
    c.some((p) => p.cell === "balances")
  );
  assert(
    sawBalances,
    `balances patch must reach broadcastState as an array; calls=${
      JSON.stringify(calls)
    }`,
  );
});

Deno.test("uds throttle preserves a force-full request across throttling", async () => {
  const calls: Call[] = [];
  const ctrl = createUdsBroadcastController({
    getUdsHandle: () => fakeHandle(calls),
    syncIntervalMs: 20,
  });
  ctrl.onUdsBroadcast([{ cell: "nav", ops: [] }] as never); // arms throttle
  await tick();
  ctrl.onUdsBroadcast(true); // force-full while throttled
  await after(35);
  assert(
    calls.includes(true),
    `force-full must survive throttling; calls=${JSON.stringify(calls)}`,
  );
});

Deno.test("uds broadcastFull sends force immediately", () => {
  const calls: Call[] = [];
  const ctrl = createUdsBroadcastController({
    getUdsHandle: () => fakeHandle(calls),
    syncIntervalMs: 20,
  });
  ctrl.broadcastFull();
  assertEquals(calls, [true]);
});
