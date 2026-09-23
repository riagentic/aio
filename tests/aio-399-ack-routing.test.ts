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

Deno.test("routeCommand: an ok ack carrying `unsaved` / `short` resolves AND warns, once per call", async () => {
  // The server's honesty contract: the call ran, but what it wrote is not on
  // disk (`unsaved`), or it ran short of arguments (`short`). `am` prints
  // both; a tab resolving the call without a word was the silent door.
  _setAckTimeoutMs(0);
  _rejectAllPending(new Error("reset"));
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    const p1 = _registerAck("cid-u");
    const p2 = _registerAck("cid-s");
    const p3 = _registerAck("cid-fine");
    const p4 = _registerAck("cid-both");
    const frame = (d: Record<string, unknown>) =>
      dec(JSON.stringify({ v: 2, t: "ack", d }))!;
    routeCommand(
      frame({
        cid: "cid-u",
        ok: true,
        value: 7,
        unsaved: "persist failed: disk says no",
      }),
      () => {},
    );
    routeCommand(
      frame({ cid: "cid-s", ok: true, short: "doc:add declares 2 arguments" }),
      () => {},
    );
    routeCommand(frame({ cid: "cid-fine", ok: true }), () => {});
    // Both at once: ONE line, both reasons joined — not two warnings.
    routeCommand(
      frame({
        cid: "cid-both",
        ok: true,
        unsaved: "persist failed: full",
        short: "doc:add declares 2 arguments",
      }),
      () => {},
    );
    assertEquals(await p1, 7, "it ran — the call still resolves");
    await p2;
    await p3;
    await p4;
    assertEquals(warned.length, 3, warned.join("\n"));
    assertEquals(
      warned[0],
      "[aio] call cid-u ran, but: NOT SAVED — persist failed: disk says no",
    );
    assertEquals(
      warned[1],
      "[aio] call cid-s ran, but: doc:add declares 2 arguments",
    );
    assertEquals(
      warned[2],
      "[aio] call cid-both ran, but: NOT SAVED — persist failed: full; " +
        "doc:add declares 2 arguments",
    );
  } finally {
    console.warn = orig;
  }
});
