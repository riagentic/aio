// `freePort()` must not hand the same port to two callers in one process.
//
// How this was found, which is the only reason it is believable: the full
// suite failed ~20 `am-cli` tests with
//
//     Error: port 20000 already in use — something else is listening on it
//
// and `20000` is the first port of shard 0's slice. `tests/am.test.ts` took
// its port once at module load and started/stopped its server per test, so in
// between the port was genuinely FREE — and the allocator, having wrapped
// around the whole slice, handed that same port to another file, which kept
// it. The next `withTrojanServer` then could not listen. It reads as a product
// bug and it is a harness one.
//
// "Free right now" and "free for the caller to KEEP" are two questions, and
// the allocator was answering the first while its callers asked the second.
// Both halves are fixed: `am.test.ts` takes a port per server, and this — no
// port is issued twice while an unissued one remains. It needs a whole shard
// to reproduce in the wild, so it is pinned here at the unit.

import { assert, assertEquals } from "@std/assert";
import { _resetPortSlice, freePort } from "../src/testing/server-test.ts";

const SLICE = "AIO_TEST_PORT_SLICE";

// The ports these cases pin must be ports NO other process can hold. Under the
// shard runner every port in 20000–32767 belongs to some shard's slice, so a
// fixed number here is another shard's port, and it failed exactly that way
// (AddrInUse on 29181, a neighbour shard's server). The top of THIS process's
// own slice is ours alone: files in a shard run one after another, and the
// resource sanitizer closes every listener between tests. With no slice (one
// `deno test` run) nothing else is allocating, and a fixed base is fine.
const OWN = (() => {
  const m = /^(\d+)-(\d+)$/.exec(Deno.env.get(SLICE) ?? "");
  return m ? Number(m[2]) - 15 : 29150;
})();
/** `n` consecutive ports starting `at` places into this file's own block. */
const range = (at: number, n: number) => `${OWN + at}-${OWN + at + n - 1}`;

/** Run `fn` with the slice env set, restoring whatever was there. The suite
 *  itself runs WITH a slice (the shard runner sets one), so this cannot just
 *  delete it afterwards. */
function withSlice<T>(value: string, fn: () => T): T {
  const had = Deno.env.get(SLICE);
  Deno.env.set(SLICE, value);
  _resetPortSlice();
  try {
    return fn();
  } finally {
    if (had === undefined) Deno.env.delete(SLICE);
    else Deno.env.set(SLICE, had);
    _resetPortSlice();
  }
}

Deno.test("freePort: a port already issued is not handed out again", () => {
  // The discriminating case, and it took a second try to write: the cursor
  // alone gives distinct ports until it WRAPS, so a test that just asks for
  // n ports out of n proves nothing — the first version of this test stayed
  // green with the fix removed.
  //
  // What has to happen for the bug is what happened in the suite: the cursor
  // passes a port that is busy, that port is later released, and the cursor
  // wraps. Now there is a free UNISSUED port and a free ISSUED one (the file
  // that holds it stopped its server between tests). The old allocator took
  // the issued one.
  withSlice(range(0, 4), () => {
    const busy = Deno.listen({ port: OWN + 1, hostname: "127.0.0.1" });
    let issued: number[];
    try {
      issued = [freePort(), freePort(), freePort()];
    } finally {
      busy.close(); // OWN + 1 is now free, and was never issued
    }
    // The SET, not the sequence. Where the cursor starts is deliberately
    // pid-dependent (see `sliceStart`), so pinning the order here would pin
    // this process's pid — a test that passes on one machine and not the
    // next, for a reason nobody could act on.
    assertEquals(
      [...issued].sort((a, b) => a - b),
      [OWN, OWN + 2, OWN + 3],
      "the cursor must hand out every free port and skip the busy one",
    );
    assertEquals(
      new Set(issued).size,
      3,
      "the same port was handed out twice in one process",
    );
    // The cursor has wrapped. Two ports are free: one whose caller is between
    // servers (already issued) and OWN + 1, which nobody was ever given. Only
    // the second one is a correct answer.
    assertEquals(
      freePort(),
      OWN + 1,
      "freePort re-issued a port it had already handed out: the caller that " +
        "holds it will fail to listen, and the failure names the PRODUCT",
    );
  });
});

Deno.test("freePort: a port held OPEN is skipped, not handed out", () => {
  withSlice(range(4, 3), () => {
    const held = Deno.listen({ port: OWN + 4, hostname: "127.0.0.1" });
    try {
      const a = freePort(), b = freePort();
      assert(a !== OWN + 4 && b !== OWN + 4, "a port in use was handed out");
      assert(a !== b);
    } finally {
      held.close();
    }
  });
});

Deno.test("freePort: an exhausted slice DEGRADES, it does not throw", () => {
  // The deliberate limit of the rule. A reused port is a rare flake; a suite
  // that cannot start a server at all is not, so once every port has been
  // issued the allocator goes back to "free right now" rather than failing.
  withSlice(range(7, 2), () => {
    const first = new Set([freePort(), freePort()]);
    assertEquals(first.size, 2, "both distinct while unissued ones remain");
    const third = freePort();
    assert(first.has(third), "an exhausted slice reuses rather than throwing");
  });
});

Deno.test("freePort: with no slice it still answers a real free port", () => {
  // The other arm — a single `deno test` run with no shard runner around it.
  const had = Deno.env.get(SLICE);
  Deno.env.delete(SLICE);
  try {
    const p = freePort();
    assert(p > 1024, `${p} is not a usable port`);
    Deno.listen({ port: p, hostname: "127.0.0.1" }).close();
  } finally {
    if (had !== undefined) Deno.env.set(SLICE, had);
  }
});

// ── and the SECOND way the same port reaches two holders ────────────────────
//
// The test above is about one process. This is about two, and it is the one
// that actually failed: a slice is inherited through the environment, so every
// process a test spawns draws from the SAME range.
// `tests/cookbook-recipes.test.ts` spawns `deno test --parallel`, whose four
// workers are four sibling processes — each with its own empty `_issued` set
// and its own cursor. All starting at `first` means all handing out the same
// ports in the same order, so the collision is not a race that sometimes
// happens, it is the arrangement. It surfaced as recipe 14 dying on
// `port 24256 already in use` while recipe 15 held it.
//
// What is pinned is the property that makes them differ: the first port
// depends on the pid. Asked of REAL processes (the pid is the whole mechanism,
// and this process only has one), on ports only this file uses, and made
// DETERMINISTIC: the old version asked "not every child started at `first`",
// which a start pinned to `first` passed whenever `first` happened to be busy
// (the walker then moved every child to `first + 1` alike).
//
// Each child chooses its slice size AFTER it knows its pid — the largest of
// 7…2 that does NOT divide it — so the pid-spread start is provably not
// `first`, and the port it prints must be exactly `first + pid % n`. A start
// that ignores the pid prints `first` and goes red, every run.
Deno.test("two processes do not start walking the slice at the same port", async () => {
  const first = OWN + 9; // OWN + 9 … OWN + 15: seven ports, this file's own
  const ask = async () => {
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--no-lock",
        `const n = [7, 6, 5, 4, 3, 2].find((k) => Deno.pid % k !== 0) ?? 7;` +
        `Deno.env.set(${
          JSON.stringify(SLICE)
        }, \`${first}-\${${first} + n - 1}\`);` +
        `const { freePort } = await import("${
          new URL("../src/testing/server-test.ts", import.meta.url).href
        }");` +
        `console.log(JSON.stringify({ pid: Deno.pid, n, port: freePort() }));`,
      ],
      env: { ...Deno.env.toObject(), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout).trim();
    assert(r.success, `child failed: ${new TextDecoder().decode(r.stderr)}`);
    return JSON.parse(out.split("\n").at(-1)!) as {
      pid: number;
      n: number;
      port: number;
    };
  };
  // One after another: two children bind-checking the same port at the same
  // instant would push one of them on, and the exact-start assertion with it.
  const kids = [];
  for (let i = 0; i < 4; i++) kids.push(await ask());
  assertEquals(kids.length, 4);
  for (const k of kids) {
    assertEquals(
      k.port,
      first + (k.pid % k.n),
      `pid ${k.pid} on ${first}-${first + k.n - 1} must start at ` +
        `first + pid % n — a start that ignores the pid walks every sibling ` +
        `in lockstep, the arrangement that failed recipe 14`,
    );
  }
  // Only a pid divisible by 420 (every size 7…2) can start at `first`.
  assert(
    kids.some((k) => k.port !== first),
    `every process started at ${first}: ${JSON.stringify(kids)}`,
  );
});
