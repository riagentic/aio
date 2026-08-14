// The discovery responder answers a 13-byte datagram with an INVENTORY of this
// host — app id, window title, real port, whether auth is required. Two
// consequences, and the responder must survive both:
//
//  • an exposed app that answers ANY source is a free scan target, and UDP
//    source addresses are trivially spoofed — so it is also a reflector,
//    aiming ~100-byte replies at whatever victim a packet names as its source;
//  • even on a trusted LAN, one host must not be able to make every exposed app
//    on this machine answer thousands of times a second.
//
// Both guards are pure, so they are tested as such — a socket test could only
// prove the wiring, and the wiring is one line each at the top of the handler.
import { assertEquals } from "@std/assert";
import { isPrivateSource, makeReplyBudget } from "../src/server/discovery.ts";

Deno.test("discovery: replies only to addresses that could be on the segment", () => {
  for (
    const host of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.20",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.1.1", // link-local
      "::1",
      "fd00::1", // unique local
      "fe80::1", // link-local v6
      "::ffff:192.168.1.20", // v4-mapped v6 — the shape a dual-stack socket sees
    ]
  ) {
    assertEquals(isPrivateSource(host), true, `should answer ${host}`);
  }
});

Deno.test("discovery: a public source gets NOTHING — no scan, no reflection", () => {
  for (
    const host of [
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1", // just outside the private /12 — the classic off-by-one
      "172.15.255.255", // and just below it
      "192.169.1.1", // one octet off 192.168
      "11.0.0.1",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8", // a public v4 wearing a v6 costume
    ]
  ) {
    assertEquals(isPrivateSource(host), false, `must not answer ${host}`);
  }
});

Deno.test("discovery: a garbage source address is not private by accident", () => {
  for (const host of ["", "not-an-address", "999.999.999.999", "10.0.0"]) {
    assertEquals(isPrivateSource(host), false, `must not answer "${host}"`);
  }
});

Deno.test("discovery: the per-source budget caps replies, then recovers", () => {
  const allow = makeReplyBudget(5);
  const t0 = 1_000_000;
  const got = Array.from({ length: 8 }, () => allow("10.0.0.5", t0));
  assertEquals(
    got,
    [true, true, true, true, true, false, false, false],
    "five per second, then silence — an amplifier is a rate, not a message",
  );
  assertEquals(
    allow("10.0.0.6", t0),
    true,
    "the budget is PER SOURCE — one noisy host must not mute the LAN",
  );
  assertEquals(
    allow("10.0.0.5", t0 + 1001),
    true,
    "and it is a rolling second, not a permanent ban",
  );
});

Deno.test("discovery: the budget's memory cannot grow without bound", () => {
  // A spoofing flood names a fresh source every packet; a map keyed by source
  // is then a memory leak with extra steps.
  const allow = makeReplyBudget(1);
  for (let i = 0; i < 5000; i++) allow(`10.1.${(i >> 8) & 255}.${i & 255}`, i);
  assertEquals(
    allow("10.0.0.1", 5000),
    true,
    "still answering after 5000 distinct sources (the map clears rather than " +
      "growing) — a guard that OOMs the app it protects is not a guard",
  );
});
