// AIO-399: the AIR transport's shared command router (routeCommand) used to
// silently drop the server's per-action ack frames — so awaited cell methods
// never resolved and timed out. routeCommand must settle the pending ack.
// v2 (B4b): acks arrive as `{v:2, t:"ack", d:{cid, ok}}` frames.
import { assertEquals } from "@std/assert";
import { routeCommand } from "../src/browser/browser-air-commands.ts";
import { dec } from "../src/protocol/envelope.ts";
import {
  _pendingAckCount,
  _registerAck,
  _rejectAllPending,
  _setAckTimeoutMs,
} from "../src/browser/browser-ack.ts";

const ack = (cid: string, ok: boolean) =>
  dec(JSON.stringify({ v: 2, t: "ack", d: { cid, ok } }))!;

Deno.test("routeCommand: ack ok=true resolves the pending ack", async () => {
  _setAckTimeoutMs(0);
  _rejectAllPending(new Error("reset"));
  let resolved = false;
  const p = _registerAck("cid-a").then(() => (resolved = true));
  assertEquals(_pendingAckCount(), 1);

  const consumed = routeCommand(ack("cid-a", true), () => {});
  assertEquals(consumed, true);
  await p;
  assertEquals(resolved, true);
  assertEquals(_pendingAckCount(), 0);
});

Deno.test("routeCommand: ack ok=false rejects the pending ack", async () => {
  _setAckTimeoutMs(0);
  _rejectAllPending(new Error("reset"));
  let rejected = false;
  const p = _registerAck("cid-b").catch(() => (rejected = true));
  routeCommand(ack("cid-b", false), () => {});
  await p;
  assertEquals(rejected, true);
  assertEquals(_pendingAckCount(), 0);
});

Deno.test("routeCommand: malformed ack payload doesn't throw", () => {
  assertEquals(
    routeCommand({ v: 2, t: "ack", d: "malformed" }, () => {}),
    true,
  );
  assertEquals(routeCommand({ v: 2, t: "ack" }, () => {}), true);
});
