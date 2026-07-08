// Regression tests for four bugs found porting FJSSM (July 2026):
//   AIO-395 — Fragment keyed children re-anchored at parent start (see
//             aio-395-fragment-region.test.ts for the DOM-order repro)
//   AIO-396 — _registerAck double-registration orphaned the caller's promise
//   AIO-397 — live proxy served nested arrays behind object targets
//   AIO-398 — browser cell() ignored scope:"client"
import { assertEquals } from "@std/assert";
import {
  _registerAck,
  _rejectAllPending,
  _resolveAck,
  _setAckTimeoutMs,
} from "../src/protocol/browser-ack.ts";
import { createBatcher, createLiveProxy } from "../src/state/cell-impl.ts";
import { cell as browserCell } from "../src/protocol/protocol-cell.ts";
import { _resetCellRegistry } from "../src/state/cell-reactive.ts";

// ── AIO-396: idempotent ack registration ──────────────────────────

Deno.test("ack: re-registering a pending cid returns the same promise", async () => {
  _setAckTimeoutMs(0);
  const first = _registerAck("cid-1");
  const second = _registerAck("cid-1"); // e.g. transport send() re-registers
  let firstResolved = false;
  let secondResolved = false;
  first.then(() => (firstResolved = true));
  second.then(() => (secondResolved = true));

  _resolveAck("cid-1");
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(firstResolved, true); // pre-fix: stayed pending forever
  assertEquals(secondResolved, true);
  _rejectAllPending(new Error("cleanup"));
});

// ── AIO-397: live proxy nested arrays keep array identity ─────────

function makeProxy<S extends Record<string, unknown>>(state: S) {
  const batcher = createBatcher("test", () => {});
  return createLiveProxy<S>("test", "test", "m", () => state, batcher);
}

Deno.test("liveProxy: nested arrays are Array.isArray + stringify as arrays", () => {
  const proxy = makeProxy({
    project: { jobOps: [[{ pt: [1, 2, 3, 4] }], []], name: "x" },
  });
  const project = proxy.project as { jobOps: unknown; name: string };
  assertEquals(Array.isArray(project.jobOps), true);
  assertEquals(
    JSON.stringify(project),
    '{"jobOps":[[{"pt":[1,2,3,4]}],[]],"name":"x"}',
  );
  // array methods still work through the proxy
  assertEquals((project.jobOps as unknown[][]).map((o) => o.length), [1, 0]);
});

Deno.test("liveProxy: top-level array state key stringifies as array", () => {
  const proxy = makeProxy({ items: [1, 2, 3] });
  assertEquals(JSON.stringify(proxy.items), "[1,2,3]");
  assertEquals((proxy.items as number[]).length, 3);
});

// ── AIO-398: browser cell() honors scope:"client" ─────────────────

Deno.test("protocol-cell: scope:'client' marks def for local binding", () => {
  _resetCellRegistry();
  const def = browserCell("uistate", {
    scope: "client",
    state: { tab: "a" },
    methods: {
      setTab(s: Record<string, unknown>, tab: string) {
        s.tab = tab;
      },
    },
  });
  const aio = def.__aio as Record<string, unknown>;
  assertEquals(aio.scope, "client");
  assertEquals(
    typeof (aio.clientMethods as Record<string, unknown>).setTab,
    "function",
  );
  _resetCellRegistry();
});

Deno.test("protocol-cell: scope:'client' rejects async methods", () => {
  _resetCellRegistry();
  let msg = "";
  try {
    browserCell("bad", {
      scope: "client",
      state: {},
      methods: { async go() {} },
    });
  } catch (e) {
    msg = (e as Error).message;
  }
  assertEquals(msg.includes("sync methods only"), true);
  _resetCellRegistry();
});
