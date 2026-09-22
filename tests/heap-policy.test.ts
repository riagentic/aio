// 25% of RAM, never below 4 GB — one rule for every surface.
//
// The failure this replaces: V8's default ceiling here is ~4 GB whatever the
// machine, so an aio app on a 32 GB box died of "out of memory" with 28 GB
// free. An app was not limited by aio; it was limited by a default nobody
// chose.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  compiledMaxHeapMB,
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

// A field report: "Nothing can launch this app without a heap warning" — both
// launch paths warned, in opposite directions, and no app setting could silence
// either. Two causes, both here.
Deno.test("heap: the FLOOR is never reported as a share someone asked for", () => {
  // Under ~16 GB of RAM the 4 GB floor IS more than 25% — but nobody chose it,
  // so calling it "above the share an app gets automatically" is a warning
  // about the framework's own minimum, unactionable from the app.
  assertEquals(overAdvisedShare(HEAP_FLOOR_MB, 8 * GB), null, "8 GB laptop");
  assertEquals(overAdvisedShare(HEAP_FLOOR_MB, 4 * GB), null, "4 GB machine");
  // V8 hands back slightly more than the floor it was given (4096 → 4192), and
  // that 96 MB used to be enough to call V8's own default "a share someone
  // asked for" — on every machine of 8 GB or less, on every boot.
  assertEquals(
    overAdvisedShare(4192, 8 * GB),
    null,
    "V8's rounding, not a decision",
  );
  assertEquals(overAdvisedShare(4192, 4 * GB), null, "…on a tiny machine too");
  // Above the floor, on a machine where that really is a large share, still speaks.
  const over = overAdvisedShare(6144, 8 * GB);
  assertEquals(over !== null && over > 0.7, true, "a real over-ask is said");
});

Deno.test("heap: rounding at the advised share is not a warning", () => {
  // `am start` sizes the ceiling TO the advised share; V8 then reports slightly
  // more than it was handed (46.6 GB → 46.7 GB), which used to trip this branch
  // — the app warned about the very ceiling the framework had just chosen. The
  // under-policy branch has had a 10% band for this exact reason since it was
  // written; this one had none.
  const total = 186 * GB;
  const want = Math.floor((total * 0.25) / (1024 * 1024));
  assertEquals(overAdvisedShare(want, total), null, "exactly the share");
  assertEquals(overAdvisedShare(want + 120, total), null, "V8's rounding");
  const real = overAdvisedShare(Math.floor(want * 1.5), total);
  assertEquals(real !== null, true, "a deliberate 37% ask still speaks");
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
  // …and a value of the wrong SHAPE is refused with the same teaching, not
  // with `s.trim is not a function` from three frames down.
  for (const bad of [{}, [], true]) {
    assertThrows(
      () => parseMaxHeap(bad as unknown as string, 64 * GB),
      Error,
      "maxHeap",
    );
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

// ── The number a BINARY carries, and the line it prints ───────────────────────
//
// Found by booting a cross-compiled Windows binary in a real 8 GB VM: it said
// `heap 46.7 GB max of 8.0 GB RAM`. 46.7 GB is 25% of the 187 GB machine that
// BUILT it. V8 fixes the ceiling at isolate creation and a compiled binary
// ignores DENO_V8_FLAGS (measured), so the build is the only place it can be
// set — and a build that sets it from its OWN RAM ships a number that is right
// on exactly one machine in the world.

Deno.test("heap: a compiled artifact never carries the BUILD machine's share", () => {
  const buildHost = 187 * GB;
  // Nothing declared → nothing baked. V8's own default is the policy floor and
  // it is the same on every machine; 25% of the builder is not.
  assertEquals(compiledMaxHeapMB(undefined, buildHost), {
    mb: null,
    note: null,
  });
  assertEquals(compiledMaxHeapMB("default", buildHost), {
    mb: null,
    note: null,
  });
  assertEquals(compiledMaxHeapMB(null, null), { mb: null, note: null });
});

Deno.test("heap: an absolute maxHeap travels; a percentage says whose it is", () => {
  const buildHost = 187 * GB;
  // A SIZE means the same thing on every machine — the one form that can be
  // baked honestly.
  assertEquals(compiledMaxHeapMB("12GB", buildHost).mb, 12288);
  assertEquals(compiledMaxHeapMB("12GB", buildHost).note, null);
  assertEquals(compiledMaxHeapMB(512, buildHost).mb, HEAP_FLOOR_MB, "floored");
  // A PERCENTAGE cannot be re-resolved inside the binary, so it silently
  // becomes "25% of whoever built it". Honoured — someone asked — but never
  // silently: the note is the build log's one chance to say it.
  const pct = compiledMaxHeapMB("25%", buildHost);
  assertEquals(pct.mb, Math.floor((buildHost * 0.25) / (1024 * 1024)));
  assert(pct.note !== null, "a build-host percentage must be said out loud");
  assert(pct.note!.includes("BUILD MACHINE"), pct.note!);
  assert(pct.note!.includes("8GB"), "and it must name the fix");
  // An unmeasurable build host has no number to bake — and says so rather than
  // guessing one.
  const unknown = compiledMaxHeapMB("25%", null);
  assertEquals(unknown.mb, null);
  assert(unknown.note !== null, "silence would be a ceiling nobody chose");
});

Deno.test("heap: the boot line is TRUE on the machine reading it", () => {
  // The exact line from the field: 46.7 GB of ceiling on a machine with 8 GB of
  // RAM. "46.7 GB max of 8.0 GB RAM" is two true numbers in a false sentence —
  // it reads as an allowance this machine granted.
  const line = describeHeapPolicy(47800, 8 * GB, true);
  assert(line.includes("46.7 GB max"), line);
  assert(line.includes("8.0 GB"), line);
  assert(
    /MORE than this machine/.test(line),
    `the line must state the relation, not imply the wrong one: ${line}`,
  );
  assert(line.includes("unreachable"), line);
  assert(
    line.includes("built"),
    `a ceiling the reader cannot change must say where it came from: ${line}`,
  );
  assert(
    !/47800|of 8\.0 GB RAM/.test(line),
    `it must not claim the machine granted it: ${line}`,
  );
  // A ceiling the machine really does allow reads exactly as before.
  assertEquals(describeHeapPolicy(8192, 32 * GB), "8.0 GB max of 32.0 GB RAM");
  // …and a compiled binary says so even when the number is fine, because the
  // reader cannot change it from here either way.
  assert(describeHeapPolicy(8192, 32 * GB, true).includes("built"));
});

Deno.test("heap: a ceiling above the machine's RAM warns, with cause and fix", async () => {
  const said: string[] = [];
  await reportHeapCeiling({ warn: (m) => said.push(m) }, {
    limitBytes: () => Promise.resolve(47800 * 1024 * 1024),
    totalBytes: () => 8 * GB,
  });
  assertEquals(said.length, 1, said.join(" | "));
  const msg = said[0]!;
  assert(msg.includes("46.7 GB"), msg);
  assert(msg.includes("8.0 GB"), msg);
  assert(msg.includes("MORE than"), msg);
  assert(/BUILD time/.test(msg), `the CAUSE: ${msg}`);
  assert(msg.includes("maxHeap"), `the FIX: ${msg}`);
  assert(msg.includes("rebuild"), `the FIX, runnable: ${msg}`);
});

Deno.test("heap: the FLOOR above a tiny machine's RAM is not a warning", () => {
  // A 4 GB machine gets V8's ~4 GB default and nobody decided that. Warning
  // about the framework's own minimum is the "nothing can launch this app
  // without a heap warning" field report, in a new place.
  return (async () => {
    const said: string[] = [];
    const log = { warn: (m: string) => said.push(m) };
    await reportHeapCeiling(log, {
      limitBytes: () => Promise.resolve(4192 * 1024 * 1024),
      totalBytes: () => 4 * GB,
    });
    await reportHeapCeiling(log, {
      limitBytes: () => Promise.resolve(4192 * 1024 * 1024),
      totalBytes: () => 2 * GB,
    });
    assertEquals(said, []);
  })();
});

// ── `memory.maxHeap` that cannot reach this process ─────────────────────────
// A field report: `memory.maxHeap: "12GB"` declared, 4 GB actually in effect,
// and three surfaces giving three different answers — the build honours the
// key, the top-level-deno.json hint calls it inert, and the heap warning never
// mentioned it. The warning is the one place the author is already looking, so
// it is the place that has to say the key did not arrive, and what does apply
// it. Only when it IS declared and IS unmet: crying wolf here is the "nothing
// can launch this app without a heap warning" report all over again.

Deno.test("heap: a declared maxHeap this process did not get is SAID, with the fix", async () => {
  const said: string[] = [];
  // 16 GB box → the automatic share is the 4 GB FLOOR, which V8's own default
  // already meets. Before, that returned silently and the declared 12 GB was
  // invisible: the gap was only ever measured against the automatic share.
  await reportHeapCeiling({ warn: (m) => said.push(m) }, {
    limitBytes: () => Promise.resolve(4192 * 1024 * 1024),
    totalBytes: () => 16 * GB,
    declaredMaxHeap: "12GB",
  });
  assertEquals(said.length, 1, said.join(" | "));
  const msg = said[0]!;
  assert(msg.includes("memory.maxHeap"), `names the key: ${msg}`);
  assert(msg.includes("12.0 GB"), `names the declared number: ${msg}`);
  assert(msg.includes("4.1 GB"), `names what it actually got: ${msg}`);
  assert(/did NOT get it/.test(msg), `states the relation: ${msg}`);
  assert(msg.includes("am start"), `the runnable fix: ${msg}`);
  assert(
    msg.includes("--max-old-space-size=12288"),
    `the by-hand fix, with the DECLARED number: ${msg}`,
  );
  assert(msg.includes("deno compile"), `where it does apply today: ${msg}`);
});

Deno.test("heap: a declaration REPLACES the automatic share as the yardstick", async () => {
  // 64 GB box, V8's default ceiling, `maxHeap: "32GB"` declared. The automatic
  // share (16 GB) is not the measure any more: the author overrode it, and
  // telling them the machine "allows" 16 GB is the framework arguing with the
  // only person who knows the workload. One yardstick, one answer.
  const said: string[] = [];
  await reportHeapCeiling({ warn: (m) => said.push(m) }, {
    limitBytes: () => Promise.resolve(4192 * 1024 * 1024),
    totalBytes: () => 64 * GB,
    declaredMaxHeap: "32GB",
  });
  assertEquals(said.length, 1, said.join(" | "));
  const msg = said[0]!;
  assert(msg.includes("32.0 GB"), `the declared ceiling: ${msg}`);
  assert(
    !msg.includes("16.0 GB (25% of RAM)"),
    `the share the author overrode must not be argued back: ${msg}`,
  );
  assert(msg.includes("--max-old-space-size=32768"), msg);
});

Deno.test("heap: NO declaration → the warning is unchanged, to the byte", async () => {
  // The cry-wolf pin. An app that declared nothing must not gain a sentence
  // about a key it never wrote.
  const base: string[] = [];
  await reportHeapCeiling({ warn: (m) => base.push(m) }, {
    limitBytes: () => Promise.resolve(4192 * 1024 * 1024),
    totalBytes: () => 64 * GB,
  });
  assertEquals(base.length, 1, base.join(" | "));
  assert(!base[0]!.includes("did NOT get it"), base[0]);
  // `undefined` (no key) and `"default"` (the explicit "leave V8 alone") are
  // the same sentence as each other and as the no-deps call.
  for (const declared of [undefined, "default", ""] as const) {
    const said: string[] = [];
    await reportHeapCeiling({ warn: (m) => said.push(m) }, {
      limitBytes: () => Promise.resolve(4192 * 1024 * 1024),
      totalBytes: () => 64 * GB,
      declaredMaxHeap: declared,
    });
    assertEquals(said, base, `declared=${JSON.stringify(declared)}`);
  }
});

Deno.test("heap: a declared maxHeap this process DID get says nothing", async () => {
  // `am start` applied it. Repeating the number back is noise, and noise is
  // how loud stops working.
  const said: string[] = [];
  const log = { warn: (m: string) => said.push(m) };
  await reportHeapCeiling(log, {
    limitBytes: () => Promise.resolve(12288 * 1024 * 1024),
    totalBytes: () => 64 * GB,
    declaredMaxHeap: "12GB",
  });
  // …and a declaration BELOW what this process already has is not a shortfall.
  await reportHeapCeiling(log, {
    limitBytes: () => Promise.resolve(16384 * 1024 * 1024),
    totalBytes: () => 64 * GB,
    declaredMaxHeap: "2GB",
  });
  assertEquals(said, []);
});

Deno.test("heap: a typo'd maxHeap is said out loud, and never crashes the boot", async () => {
  // `parseMaxHeap` throws by design — but this reporter is observe-only and
  // awaited on the boot path, so a config typo must not take the app down.
  const said: string[] = [];
  await reportHeapCeiling({ warn: (m) => said.push(m) }, {
    limitBytes: () => Promise.resolve(4192 * 1024 * 1024),
    totalBytes: () => 8 * GB,
    declaredMaxHeap: "12 gigs",
  });
  assertEquals(said.length, 1, said.join(" | "));
  assert(said[0]!.includes("maxHeap"), said[0]);
  assert(said[0]!.includes("12 gigs"), said[0]);
});

Deno.test("heap: the stamp re-speaks when the declared ceiling changes", async () => {
  // The stamp is keyed on the numbers, and the declared ceiling is now one of
  // them: adding `maxHeap` to deno.json must make the warning news again.
  const dir = await tempDir("aio-heap-stamp-");
  try {
    const stampPath = `${dir}/.heap-notice`;
    const said: string[] = [];
    const log = { warn: (m: string) => said.push(m) };
    const run = (declaredMaxHeap?: string) =>
      reportHeapCeiling(log, {
        limitBytes: () => Promise.resolve(4192 * 1024 * 1024),
        totalBytes: () => 64 * GB,
        stampPath,
        declaredMaxHeap,
      });
    await run();
    await run(); // same numbers — said once per machine
    assertEquals(said.length, 1, said.join(" | "));
    await run("32GB"); // the app declared one: news
    assertEquals(said.length, 2, said.join(" | "));
    assert(said[1]!.includes("memory.maxHeap"), said[1]);
  } finally {
    await dropTempDir(dir);
  }
});
