// The live proxy's JS semantics are in good shape — a randomized differential
// fuzzer extended with 29 new ops (sort with a comparator, intra-array
// aliasing, `toSpliced`/`with`/`flatMap` write-through, `Object.fromEntries`
// round-trips, writes from `every`/`reduce` callbacks) found nothing across 6
// seeds × 200 rounds. Every divergence that remains is at the COMMIT boundary:
// what a value BECOMES when it lands, and what is said about it.
//
// The three shapes here were all silent:
//   * an ACCESSOR assigned into state survives a sync commit. `Object.freeze`
//     keeps the getter, so `isFrozen` is true while every read returns a
//     different value — committed state that changes with no write, no patch
//     and no broadcast, so what a client receives depends on when
//     serialization happened. `deepFreeze` names typed arrays, Dates,
//     Maps/Sets and class instances one by one and said nothing about this.
//   * the async path CLONES what it installs, which flattens both an accessor
//     and a class instance — the quieter half of the divergence was also the
//     one with no warning at all.
//   * a cyclic value took the async write path down with "Maximum call stack
//     size exceeded" after ~330 ms of recursion (long enough to trip the
//     effect budget on the way), where the sync twin refuses immediately and
//     by name.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { testCell } from "../src/testing/cell-test.ts";
import { _unfreezableWarned, deepFreeze } from "../src/state/immutable.ts";
import { log } from "../src/diagnostics/logger-api.ts";

/** Every `[aio]` warning `fn` produced. */
function warnings(fn: () => void): string[] {
  const out: string[] = [];
  const orig = log.warn;
  _unfreezableWarned.clear();
  (log as { warn: unknown }).warn = (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    (log as { warn: unknown }).warn = orig;
    _unfreezableWarned.clear();
  }
  return out;
}

Deno.test("deepFreeze names an ACCESSOR — the one shape freezing keeps alive", () => {
  let n = 0;
  const said = warnings(() => {
    deepFreeze({
      plain: 1,
      get live() {
        return ++n;
      },
    });
  });
  assert(
    said.some((w) => w.includes("accessor") && w.includes("live")),
    `no accessor warning: ${JSON.stringify(said)}`,
  );
  // …and it still names the shapes it already knew about.
  assert(
    warnings(() => deepFreeze({ d: new Date() })).some((w) =>
      w.includes("Date")
    ),
  );
  assert(
    warnings(() => deepFreeze({ m: new Map() })).some((w) => w.includes("Map")),
  );
  // A plain object says nothing — the channel must not cry wolf.
  assertEquals(warnings(() => deepFreeze({ a: 1, b: { c: [1, 2] } })), []);
});

const cyc = cell("cbs_cyc", {
  state: { o: {} as Record<string, unknown>, n: 0 },
  methods: {
    syncPut(s: { o: Record<string, unknown> }) {
      const a: Record<string, unknown> = { n: 1 };
      a.self = a;
      s.o = a;
    },
    async asyncPut(s: { o: Record<string, unknown> }) {
      const a: Record<string, unknown> = { n: 1 };
      a.self = a;
      s.o = a;
    },
  },
});

testCell(
  cyc,
  "a cyclic value is refused the same way by both kinds",
  async (t) => {
    const errs: string[] = [];
    const started = Date.now();
    for (const m of ["syncPut", "asyncPut"] as const) {
      try {
        await (t.send as Record<string, () => Promise<unknown>>)[m]!();
        errs.push(`${m}: NO THROW`);
      } catch (e) {
        errs.push(`${m}: ${(e as Error).message}`);
      }
    }
    for (const e of errs) {
      assertStringIncludes(e, "circular references", `wrong refusal: ${e}`);
    }
    // …and immediately: the old async path burned ~330ms recursing first.
    assert(
      Date.now() - started < 2000,
      `the refusal took ${Date.now() - started}ms — it is still recursing`,
    );
  },
);
