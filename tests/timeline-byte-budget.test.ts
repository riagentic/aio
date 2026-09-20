// The live timeline is bounded by what it RETAINS, not only by how many
// entries it holds.
//
// Each entry keeps the payload and the before/after values of every changed
// leaf. The ring was capped at 500 entries and nothing else, under a header
// promising "memory stays bounded to the ring capacity regardless of state
// size" — so an app whose method replaces a 1 MB value kept 500 of them.
// Measured in a `--prod` run (the timeline is always on): heap 17 MB → 519 MB
// for a 1 MB cell. A 10 MB value would have taken the server past 5 GB.
import { assert, assertEquals } from "@std/assert";
import {
  approxRetainedBytes,
  createTimeline,
  TIMELINE_MAX_BYTES,
  TIMELINE_RING,
} from "../src/server/timeline.ts";
import { timelineCapped } from "../src/am/am-cmd-timeline.ts";

const MB = 1024 * 1024;

Deno.test("timeline: big values are bounded by bytes, not only by count", () => {
  const tl = createTimeline();
  let prev = { big: { blob: "" } };
  for (let i = 1; i <= 300; i++) {
    const v = String(i).padEnd(MB, "y");
    const next = { big: { blob: v } };
    tl.record(i, "big:put", { args: [v] }, prev, next, i);
    prev = next;
  }
  // Instrument check: every entry really carries a ~1 MB value.
  const kept = tl.entries();
  assert(
    approxRetainedBytes(kept[kept.length - 1]) > MB,
    "the probe's entries are not the size the test assumes",
  );
  let held = 0;
  for (const e of kept) held += approxRetainedBytes([e.payload, e.diff]);
  assert(
    held <= TIMELINE_MAX_BYTES + 4 * MB,
    `the ring retains ~${(held / MB) | 0} MB for a 1 MB cell — it must stay ` +
      `within its ${TIMELINE_MAX_BYTES / MB} MB budget`,
  );
  assert(tl.size() < 300, "entries past the budget are dropped");
  // The NEWEST are the ones kept, and the answer says the ring rotated.
  assertEquals(kept[kept.length - 1]!.seq, 300);
  assertEquals(tl.rotated(), true);
});

Deno.test("timeline: small entries still keep the whole count ring", () => {
  const tl = createTimeline();
  let prev = { c: { n: 0 } };
  for (let i = 1; i <= TIMELINE_RING; i++) {
    const next = { c: { n: i } };
    tl.record(i, "c:inc", { args: [] }, prev, next, i);
    prev = next;
  }
  assertEquals(tl.size(), TIMELINE_RING);
  assertEquals(tl.rotated(), false, "nothing has been dropped yet");
  tl.record(TIMELINE_RING + 1, "c:inc", { args: [] }, prev, { c: { n: 0 } }, 0);
  assertEquals(tl.size(), TIMELINE_RING);
  assertEquals(tl.rotated(), true);
});

Deno.test("timeline: one entry bigger than the whole budget is still kept", () => {
  const tl = createTimeline(TIMELINE_RING, undefined, 4 * MB);
  const v = "z".repeat(8 * MB);
  tl.record(1, "big:put", { args: [] }, { b: { v: "" } }, { b: { v } }, 1);
  assertEquals(tl.size(), 1, "the newest entry always stays");
  tl.record(2, "big:put", { args: [] }, { b: { v } }, { b: { v: "" } }, 2);
  assertEquals(tl.entries().map((e) => e.seq), [2]);
});

Deno.test("am timeline: a byte-rotated ring is reported as capped", () => {
  // 40 rows back for 100 asked, with the app saying it dropped entries: the
  // ring decided the answer, even though 40 < TIMELINE_RING.
  assertEquals(timelineCapped(100, 40, true), true);
  assertEquals(timelineCapped(100, 40, false), false);
  // An app that does not say is judged by count, as before.
  assertEquals(timelineCapped(100, 40), false);
  assertEquals(timelineCapped(1000, TIMELINE_RING), true);
});

// Measuring an entry walks its PAYLOAD — something recording never did before
// the byte budget. A server-side call can pass anything: an object whose
// enumerable getter throws, a revoked Proxy. The measure ran after the entry
// was already in the ring and before the count cap, so a throw there (caught
// by the observe-only hook guard) left the entry in and skipped the eviction:
// every such dispatch grew the ring past its cap, for good.
Deno.test("timeline: a payload the size walk cannot read never breaks the count cap", () => {
  const tl = createTimeline(3);
  const hostile = () => {
    const o = {};
    Object.defineProperty(o, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter throws");
      },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return { args: [o, proxy] };
  };
  let prev = { c: { n: 0 } };
  for (let i = 1; i <= 10; i++) {
    const next = { c: { n: i } };
    // Recording is observe-only for the dispatch, but it must not throw
    // either: the hook guard would report every dispatch as a HOOK_ERROR.
    tl.record(i, "c:set", hostile(), prev, next, i);
    prev = next;
  }
  assertEquals(tl.size(), 3, "the count cap holds whatever the payload is");
  assertEquals(tl.entries().map((e) => e.seq), [8, 9, 10]);
  assertEquals(tl.rotated(), true);
});
