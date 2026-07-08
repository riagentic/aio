// AIO-399: the AIR transport's shared command router (routeCommand) consumed
// every "__"-prefixed line via its catch-all `return true`, silently dropping
// the server's `__ack:<cid>:1` frames — so awaited cell methods never resolved
// and timed out. routeCommand must settle the pending ack.
import { assertEquals } from "@std/assert";
import { routeCommand } from "../src/browser/browser-air-commands.ts";
import {
  _pendingAckCount,
  _registerAck,
  _rejectAllPending,
  _setAckTimeoutMs,
} from "../src/protocol/browser-ack.ts";

Deno.test("routeCommand: __ack:<cid>:1 resolves the pending ack", async () => {
  _setAckTimeoutMs(0);
  _rejectAllPending(new Error("reset"));
  let resolved = false;
  const p = _registerAck("cid-a").then(() => (resolved = true));
  assertEquals(_pendingAckCount(), 1);

  const consumed = routeCommand("__ack:cid-a:1", () => {});
  assertEquals(consumed, true);
  await p;
  assertEquals(resolved, true);
  assertEquals(_pendingAckCount(), 0);
});

Deno.test("routeCommand: __ack:<cid>:0 rejects the pending ack", async () => {
  _setAckTimeoutMs(0);
  _rejectAllPending(new Error("reset"));
  let rejected = false;
  const p = _registerAck("cid-b").catch(() => (rejected = true));
  routeCommand("__ack:cid-b:0", () => {});
  await p;
  assertEquals(rejected, true);
  assertEquals(_pendingAckCount(), 0);
});

Deno.test("routeCommand: unknown __ack shape doesn't throw", () => {
  assertEquals(routeCommand("__ack:malformed", () => {}), true);
});
