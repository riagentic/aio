// `AIO_AM_DISPLAY=:N` keeps a build smoke's window on the display named —
// as `am start` does — and starts no Xephyr on the real desktop. A Xephyr is a
// window on that desktop, drawn through its driver; on the box where an
// NVIDIA X driver crashed (feedback/critical.md) a run must be able to keep
// every window off it.
import { assertEquals } from "@std/assert";
import { smokeDisplayEnv } from "../src/build/smoke.ts";

Deno.test("smoke display: a named display that is down is no display — nothing is started in its place", () => {
  // :999 is not up: the answer is "no contained display", never a fresh
  // Xephyr (or another account's :77) instead of the one asked for.
  assertEquals(smokeDisplayEnv(":999"), null);
});
