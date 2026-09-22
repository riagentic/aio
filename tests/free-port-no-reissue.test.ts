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
  withSlice("29180-29183", () => {
    const busy = Deno.listen({ port: 29181, hostname: "127.0.0.1" });
    let issued: number[];
    try {
      issued = [freePort(), freePort(), freePort()];
    } finally {
      busy.close(); // 29181 is now free, and was never issued
    }
    // The SET, not the sequence. Where the cursor starts is deliberately
    // pid-dependent (see `sliceStart`), so pinning the order here would pin
    // this process's pid — a test that passes on one machine and not the
    // next, for a reason nobody could act on.
    assertEquals(
      [...issued].sort((a, b) => a - b),
      [29180, 29182, 29183],
      "the cursor must hand out every free port and skip the busy one",
    );
    assertEquals(
      new Set(issued).size,
      3,
      "the same port was handed out twice in one process",
    );
    // The cursor has wrapped. Two ports are free: one whose caller is between
    // servers (already issued) and 29181, which nobody was ever given. Only
    // the second one is a correct answer.
    assertEquals(
      freePort(),
      29181,
      "freePort re-issued a port it had already handed out: the caller that " +
        "holds it will fail to listen, and the failure names the PRODUCT",
    );
  });
});

Deno.test("freePort: a port held OPEN is skipped, not handed out", () => {
  withSlice("29150-29152", () => {
    const held = Deno.listen({ port: 29150, hostname: "127.0.0.1" });
    try {
      const a = freePort(), b = freePort();
      assert(a !== 29150 && b !== 29150, "a port in use was handed out");
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
  withSlice("29160-29161", () => {
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
// Two processes cannot be run from a unit test cheaply, so what is pinned is
// the property that makes them differ: the first port depends on the pid.
Deno.test("two processes do not start walking the slice at the same port", async () => {
  const slice = "31000-31799";
  const first = 31000;
  // Ask two REAL processes, because the pid is the whole mechanism and this
  // process only has one.
  const ask = async () => {
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--no-lock",
        `const { freePort } = await import("${
          new URL("../src/testing/server-test.ts", import.meta.url).href
        }");` +
        `console.log(freePort());`,
      ],
      env: { ...Deno.env.toObject(), [SLICE]: slice, NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout).trim();
    assert(r.success, `child failed: ${new TextDecoder().decode(r.stderr)}`);
    const n = Number(out.split("\n").at(-1));
    assert(Number.isInteger(n), `child printed no port: ${out}`);
    return n;
  };
  const ports = await Promise.all([ask(), ask(), ask(), ask()]);
  for (const p of ports) {
    assert(p >= first && p <= 31799, `${p} is outside the slice`);
  }
  // Not "all different" — two pids CAN be congruent modulo the slice size, and
  // a test that demands otherwise would flake for a reason nobody could act
  // on. What must not happen is every process starting at `first`, which is
  // what made the collision certain rather than unlikely.
  assert(
    new Set(ports).size > 1 || ports[0] !== first,
    `every process started at ${first} — siblings are walking in lockstep, ` +
      `which is exactly the arrangement that failed recipe 14: ${ports}`,
  );
});
