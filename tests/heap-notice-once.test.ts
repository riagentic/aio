// The heap-ceiling warning: once per machine, not once per boot.
//
// It is correct, well written, and five lines the reader cannot act on from
// application code — V8 fixed the ceiling before any of this ran. Printed at
// every start of an app using a few MB it becomes the paragraph you scroll
// past, and one field report watched it sit directly above the ONE warning
// they had deliberately emitted and needed to read. A framework whose rule is
// "fail loud, never silent" has the most to lose from noise, because noise is
// how loud stops working.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { reportHeapCeiling } from "../src/server/heap-policy.ts";

/** A machine with 64 GB whose process got the 4 GB default — the case. */
const SHORT = {
  limitBytes: () => Promise.resolve(4_192 * 1024 * 1024),
  totalBytes: () => 64 * 1024 * 1024 * 1024,
};

function collector() {
  const lines: string[] = [];
  return { log: { warn: (m: string) => void lines.push(m) }, lines };
}

Deno.test("heap notice: said once, then remembered", async () => {
  const dir = await Deno.makeTempDir();
  const stampPath = join(dir, ".heap-notice");
  try {
    const a = collector();
    await reportHeapCeiling(a.log, { ...SHORT, stampPath });
    assertEquals(a.lines.length, 1, "the first boot must say it");
    assert(a.lines[0]!.includes("once per machine"), a.lines[0]);

    const b = collector();
    await reportHeapCeiling(b.log, { ...SHORT, stampPath });
    assertEquals(b.lines.length, 0, "the second boot must not repeat it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("heap notice: --verbose always says it", async () => {
  const dir = await Deno.makeTempDir();
  const stampPath = join(dir, ".heap-notice");
  try {
    await reportHeapCeiling(collector().log, { ...SHORT, stampPath });
    const c = collector();
    await reportHeapCeiling(c.log, { ...SHORT, stampPath, always: true });
    assertEquals(c.lines.length, 1, "asking for verbose output must get it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("heap notice: a CHANGED ceiling is news, so it speaks again", async () => {
  // The stamp records the numbers, not just "shown". Move machine, change
  // launcher, change the policy — that is exactly when the warning matters.
  const dir = await Deno.makeTempDir();
  const stampPath = join(dir, ".heap-notice");
  try {
    await reportHeapCeiling(collector().log, { ...SHORT, stampPath });
    const c = collector();
    await reportHeapCeiling(c.log, {
      limitBytes: () => Promise.resolve(2_048 * 1024 * 1024),
      totalBytes: SHORT.totalBytes,
      stampPath,
    });
    assertEquals(c.lines.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("heap notice: a ceiling that MEETS policy says nothing at all", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const c = collector();
    await reportHeapCeiling(c.log, {
      limitBytes: () => Promise.resolve(16 * 1024 * 1024 * 1024),
      totalBytes: () => 64 * 1024 * 1024 * 1024,
      stampPath: join(dir, ".heap-notice"),
    });
    assertEquals(c.lines.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("heap notice: an unwritable stamp warns EVERY boot, never never", async () => {
  // Degrading to silence because a directory is read-only would trade a noisy
  // warning for a missing one, which is the wrong direction.
  const c1 = collector();
  await reportHeapCeiling(c1.log, {
    ...SHORT,
    stampPath: "/proc/definitely/not/writable/.heap-notice",
  });
  const c2 = collector();
  await reportHeapCeiling(c2.log, {
    ...SHORT,
    stampPath: "/proc/definitely/not/writable/.heap-notice",
  });
  assertEquals(c1.lines.length, 1);
  assertEquals(c2.lines.length, 1);
});
