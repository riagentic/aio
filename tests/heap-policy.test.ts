// 25% of RAM, never below 4 GB — one rule for every surface.
//
// The failure this replaces: V8's default ceiling here is ~4 GB whatever the
// machine, so an aio app on a 32 GB box died of "out of memory" with 28 GB
// free. An app was not limited by aio; it was limited by a default nobody
// chose.
import { assertEquals, assertThrows } from "@std/assert";
import {
  describeHeapPolicy,
  HEAP_FLOOR_MB,
  maxHeapFlagArgs,
  overAdvisedShare,
  parseMaxHeap,
  reportHeapCeiling,
  resolveMaxHeapMB,
} from "../src/server/heap-policy.ts";

const GB = 1024 * 1024 * 1024;

Deno.test("heap: the default is a quarter of the machine", () => {
  assertEquals(resolveMaxHeapMB(32 * GB), 8192);
  assertEquals(resolveMaxHeapMB(64 * GB), 16384);
  assertEquals(resolveMaxHeapMB(192 * GB), 49152);
});

Deno.test("heap: never below today's default — a small machine cannot regress", () => {
  // 25% of 8 GB is 2 GB, which would be WORSE than the 4 GB V8 gives today.
  assertEquals(resolveMaxHeapMB(8 * GB), HEAP_FLOOR_MB);
  assertEquals(resolveMaxHeapMB(2 * GB), HEAP_FLOOR_MB);
  // …and exactly at the crossover the fraction takes over.
  assertEquals(resolveMaxHeapMB(16 * GB), HEAP_FLOOR_MB);
  assertEquals(resolveMaxHeapMB(24 * GB), 6144);
});

Deno.test("heap: an explicit ask is honoured — including above the 25% share", () => {
  // The automatic 25% protects a machine from an app nobody has thought about.
  // An app that legitimately needs 12 GB on a 32 GB box is not misbehaving, and
  // clamping it to 8 GB would reproduce the very crash this module exists to
  // prevent — with the framework's fingerprints on it. The author who writes
  // the number has thought about it; the framework says so loudly instead.
  assertEquals(resolveMaxHeapMB(32 * GB, "12GB"), 12288, "the whole point");
  assertEquals(resolveMaxHeapMB(64 * GB, "8GB"), 8192, "below the share, fine");
  assertEquals(resolveMaxHeapMB(64 * GB, "48GB"), 49152, "75% if you ask");
  assertEquals(
    resolveMaxHeapMB(64 * GB, 2048),
    HEAP_FLOOR_MB,
    "the floor still wins — nothing may be worse than V8's default",
  );
  assertEquals(resolveMaxHeapMB(192 * GB, "10%"), 19660);
});

Deno.test("heap: asking for more than the share is REPORTED, not refused", () => {
  // A number to say, not to enforce. An app allowed 60% of RAM is a decision
  // someone made; the next person reading a boot log should not have to
  // reverse-engineer it from two config files.
  assertEquals(overAdvisedShare(8192, 32 * GB), null, "exactly the share");
  assertEquals(overAdvisedShare(4096, 64 * GB), null, "under it");
  const over = overAdvisedShare(48 * 1024, 64 * GB);
  assertEquals(over !== null && over > 0.7, true, "75% is worth saying");
  assertEquals(
    overAdvisedShare(8192, null),
    null,
    "unmeasurable → nothing to say",
  );
});

Deno.test("heap: an unmeasurable machine is left alone", () => {
  // Guessing a ceiling from no information is how a working app starts
  // swapping. No number → no flag → V8 keeps its default.
  assertEquals(resolveMaxHeapMB(null), null);
  assertEquals(resolveMaxHeapMB(null, "25%"), null, "a percentage of nothing");
  assertEquals(
    resolveMaxHeapMB(null, "12GB"),
    12288,
    "an absolute still works",
  );
  assertEquals(maxHeapFlagArgs(null), []);
});

Deno.test("heap: `default` opts out, nonsense is refused", () => {
  assertEquals(resolveMaxHeapMB(64 * GB, "default"), 16384, "back to the rule");
  // A typo'd memory setting that silently means "default" is found under load,
  // which is the worst possible moment.
  for (const bad of ["lots", "16 gigs", "-4GB", "%", "0"]) {
    assertThrows(() => parseMaxHeap(bad, 64 * GB), Error, "maxHeap");
  }
});

Deno.test("heap: the flag is spelled in exactly one place", () => {
  assertEquals(maxHeapFlagArgs(8192), ["--v8-flags=--max-old-space-size=8192"]);
});

Deno.test("heap: the boot line states both numbers", () => {
  // "8 GB max" alone invites "of what?" — the answer is the whole policy.
  const line = describeHeapPolicy(8192, 32 * GB);
  assertEquals(line.includes("8.0 GB max"), true);
  assertEquals(line.includes("32.0 GB RAM"), true);
});

Deno.test("heap: the boot report is silent when the ceiling already meets policy", async () => {
  const said: string[] = [];
  const log = { warn: (m: string) => said.push(m) };
  const GB32 = 32 * GB;
  // Asked for 8 GB (25% of 32), got 8 GB → nothing to say.
  await reportHeapCeiling(log, {
    limitBytes: () => Promise.resolve(8192 * 1024 * 1024),
    totalBytes: () => GB32,
  });
  // V8 reports a little MORE than requested (4096 → 4192); a warning about
  // rounding is noise, and noise is how real warnings get ignored.
  await reportHeapCeiling(log, {
    limitBytes: () => Promise.resolve(7800 * 1024 * 1024),
    totalBytes: () => GB32,
  });
  assertEquals(said, []);
});

Deno.test("heap: the boot report names the gap and the exact fix", async () => {
  const said: string[] = [];
  await reportHeapCeiling({ warn: (m) => said.push(m) }, {
    limitBytes: () => Promise.resolve(4192 * 1024 * 1024), // V8's default
    totalBytes: () => 32 * GB,
  });
  assertEquals(said.length, 1);
  const msg = said[0]!;
  assertEquals(msg.includes("4.1 GB"), true, "what it has");
  assertEquals(msg.includes("8.0 GB"), true, "what the machine allows");
  assertEquals(
    msg.includes("--max-old-space-size=8192"),
    true,
    "a warning about a fixed-at-startup setting must carry the runnable fix",
  );
});

Deno.test("heap: nothing to measure, nothing to say", async () => {
  const said: string[] = [];
  const log = { warn: (m: string) => said.push(m) };
  await reportHeapCeiling(log, {
    limitBytes: () => Promise.resolve(null),
    totalBytes: () => 32 * GB,
  });
  await reportHeapCeiling(log, {
    limitBytes: () => Promise.resolve(4192 * 1024 * 1024),
    totalBytes: () => null,
  });
  assertEquals(said, []);
});
