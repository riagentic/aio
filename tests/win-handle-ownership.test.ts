// A handle VALUE is not a handle. Windows recycles the number the instant it
// is closed, so anything that captured a value and acts on it LATER — the
// `drain()` timeout in win-pipe.ts, the `GetOverlappedResult` after an
// awaited completion packet — can cancel, close or read the result of an
// unrelated handle that some other part of the process opened in between.
//
// The Win32 half of that defect cannot be run here, and is NOT claimed to be
// verified. The OWNERSHIP half can be: `HandleTable` is the rule that decides
// whether a captured value still means what it meant, and it is pure.
//
// The file also pins the property that makes it load-bearing in win-pipe.ts:
// after `close()` runs, no deferred path may act on that value again.
import { assert, assertEquals } from "@std/assert";
import { HandleTable } from "../src/server/handle-table.ts";

Deno.test("HandleTable: a recycled value is not the same handle", () => {
  const t = new HandleTable();
  const a = t.claim(0x1234n, "pipe conn A");
  assert(t.isLive(a));
  // A's owner closes it: the number goes back to the kernel.
  assertEquals(t.release(a), true);
  assert(!t.isLive(a), "a released slot owns nothing");
  // …and the kernel hands the SAME number to something else.
  const b = t.claim(0x1234n, "pipe conn B");
  assert(t.isLive(b));
  assert(
    !t.isLive(a),
    "the OLD slot must not come back to life because its value did — this " +
      "is the whole defect: a drain timeout closing B believing it is A",
  );
  assertEquals(
    t.release(a),
    false,
    "a stale slot must never release (i.e. never close) the value it lost",
  );
  assert(t.isLive(b), "and B must be untouched by A's attempt");
});

Deno.test("HandleTable: release is idempotent and closes at most once", () => {
  const t = new HandleTable();
  const a = t.claim(7n, "conn");
  assertEquals(t.release(a), true);
  assertEquals(t.release(a), false);
  assertEquals(t.release(a), false);
  assertEquals(t.size, 0);
});

Deno.test("HandleTable: `with` is the deferred path's only safe door", () => {
  const t = new HandleTable();
  const a = t.claim(99n, "conn");
  const seen: bigint[] = [];
  assertEquals(t.with(a, (v) => (seen.push(v), "acted"), "skipped"), "acted");
  t.release(a);
  t.claim(99n, "someone else"); // the value, recycled
  assertEquals(
    t.with(a, (v) => (seen.push(v), "acted"), "skipped"),
    "skipped",
    "a deferred use of a lost value must not run at all",
  );
  assertEquals(seen, [99n], "the stale use must not have touched the value");
});

Deno.test("HandleTable: a value claimed twice over is LOUD, never silent", () => {
  const warnings: string[] = [];
  const t = new HandleTable((m) => warnings.push(m));
  const a = t.claim(42n, "conn A");
  // No release: aio lost track of it. The kernel cannot hand out a live
  // value, so this can only be our own bookkeeping bug.
  const b = t.claim(42n, "conn B");
  assertEquals(warnings.length, 1, `expected one warning, got ${warnings}`);
  const w = warnings[0] ?? "";
  assert(
    w.includes("conn A") && w.includes("conn B"),
    `the warning must name both claimants: ${w}`,
  );
  assert(t.isLive(b), "the kernel-confirmed claim wins");
  assert(!t.isLive(a), "and the lost one owns nothing");
  assertEquals(
    t.release(a),
    false,
    "the lost slot must not be able to close the new owner's handle",
  );
});

Deno.test("HandleTable: generations are unique across values", () => {
  const t = new HandleTable();
  const gens = new Set<number>();
  for (let i = 0n; i < 200n; i++) {
    const s = t.claim(i % 5n, "h"); // heavy reuse of five values
    gens.add(s.gen);
    if (i % 2n === 0n) t.release(s);
  }
  assertEquals(gens.size, 200, "no two claims may share a generation");
});

// The Win32 half cannot run here, so the thing that CAN be checked on every
// OS is that win-pipe.ts still routes every handle through the table. The
// type system already carries most of it — `finishOverlapped` takes an
// `Owned`, so a bare value cannot be passed — but nothing stops a future edit
// from calling `closeHandle(o.h)` straight, which is exactly the close of a
// possibly-recycled value this whole mechanism exists to prevent.
Deno.test("win-pipe: no handle is closed except through a released claim", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/win-pipe.ts", import.meta.url),
  );
  const lines = src.split("\n");
  // Every raw close, and the claim-release that must gate it. `closeOwned` is
  // the gate itself; the other two sites release inline, a few lines above.
  const closes: number[] = [];
  lines.forEach((l, i) => {
    if (/\bcloseHandle\(/.test(l) && !/function closeHandle/.test(l)) {
      closes.push(i);
    }
  });
  assert(closes.length > 0, "the close sites must still exist to be guarded");
  for (const i of closes) {
    // Walk back to the head of the enclosing function: the release must be in
    // the SAME body, not merely somewhere above.
    let guarded = false;
    const body: string[] = [];
    for (let j = i; j >= 0; j--) {
      const l = lines[j] ?? "";
      body.unshift(l);
      if (/handles\.release\(|function closeOwned/.test(l)) {
        guarded = true;
        break;
      }
      // A function or method HEAD at file or class indent — the body ends
      // here. Never tested against the close line itself, which sits at the
      // same indent as a method head.
      if (
        j < i &&
        /^(export )?(async )?function |^ {2}(async )?[a-z#][\w#]*\(.*\) *\{/
          .test(l)
      ) break;
    }
    assert(
      guarded,
      `win-pipe.ts:${i + 1} closes a handle without first releasing its ` +
        `claim in the same body — on Windows that value may already belong ` +
        `to something else:\n${body.join("\n")}`,
    );
  }
  // …and the post-await result read stays gated by a claim rather than by a
  // raw value: `finishOverlapped` is the only place a completed operation is
  // turned into a byte count the caller trusts.
  assert(
    /async function finishOverlapped\(\s*o: Owned,/.test(src),
    "finishOverlapped must take an Owned (handle + claim), never a bare " +
      "Handle — the value it was started with may be someone else's by the " +
      "time its completion packet arrives",
  );
});
