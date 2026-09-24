// A render given its own route (`renderToString(v, { route })`) reads the
// signal graph under a READ SCOPE (state/signal.ts, "Read scope"). The one
// promise that makes that safe: a scoped read changes NOTHING the global side
// observes — no effect, watch or peek sees a different value, runs a
// different number of times, or runs in a different order.
//
// Hand-written probes found three ways to break it in three review rounds (a
// scoped read recomputing a computed's GLOBAL slot; an effect created in a
// render subscribing to the render's branch; a trackedMemo hit linking a
// subscriber to an unsettled computed) — and this fuzzer a fourth (a render
// nested in an effect, subscribed to a global computed that branched
// elsewhere). This is the structural answer: a seeded differential. Each
// program is a random op sequence over one graph — chains, a diamond,
// conditional deps, an equality cut, a throwing computed, computeds that
// branch on the route, trackedMemos (one throwing via a computed, one on a
// signal), effects, watches, batch, peek, untrack, global route writes — run
// twice:
//
//   plain   the global ops alone;
//   scoped  the same ops, with explicit-route renders (renderToString, and two
//           renderToStreams pulled in turn) reading the same graph between
//           them, every effect/watch CREATED INSIDE a render, and renders
//           NESTED in an effect (directly, or through a computed).
//
// The global logs — every effect and watch value, in execution order across
// effects, and every global read — must be identical; every read a render
// makes must equal a fresh evaluation of the graph under that render's route;
// and after every op, each live effect's tracked values (a nested render's
// under its route) must equal a fresh evaluation — no subscriber left behind.
//
//   FUZZ_SEED=<n>   replay one program (printed on failure)
//   FUZZ_ROUNDS=<n> how many programs (default 400; the soak lane runs 2000)
import { assertEquals, assertThrows } from "@std/assert";
import {
  _enterReadScope,
  _scopedWalksNow,
  _trackEnd,
  _trackStart,
  batch,
  computed,
  effect,
  signal,
  trackedMemo,
  untrack,
} from "../src/state/signal.ts";
import { watch } from "../src/state/watch.ts";
import { h, routePath } from "../src/air.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import type { VNode } from "../src/air/vdom-types.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x5c09e);
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 400, 1);
const ONE = Deno.env.get("FUZZ_SEED") !== undefined;

/** Seeded PRNG (mulberry32). */
function rng(seed: number): (k: number) => number {
  let a = seed >>> 0;
  return (k) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * k);
  };
}

// ── the graph, as pure functions (the oracle evaluates the same ones) ──────
type G = (i: number) => number;
type C = (i: number) => number;
type R = () => string;
const F: ((g: G, r: R, c: C) => number)[] = [
  (g) => g(0) + g(1), //                                       c0 chain root
  (g, _r, c) => g(3) % 2 ? c(0) : g(2), //                     c1 conditional
  (_g, _r, c) => Math.floor(c(0) / 3), //                      c2 equality cut
  (_g, _r, c) => c(1) * 10 + c(2), //                          c3 diamond
  (g, _r, c) => { //                                           c4 throws
    const v = g(2);
    if (v % 5 === 4) throw new Error("c4");
    return v + c(2);
  },
  (g, r, c) => r() === "/" ? c(0) : g(2) + 100, //             c5 route branch
  (_g, r, c) => r().length * 1000 + c(5), //                   c6 route chain
  (g, r, c) => r() === "/a" ? c(4) : g(1), //                  c7 route → throw
];
const MEMO = (k: number, g: G, r: R, c: C) =>
  c(k % F.length) + g(k % 4) + (k === 5 ? r().length : 0);
/** A memo that throws on a SIGNAL value (MEMO over c4 throws via a computed). */
const TMEMO = (k: number, g: G, _r: R, c: C) => {
  const v = g(1) + k;
  if (v % 4 === 3) throw new Error("t");
  return v + c(k);
};
const ROUTES = ["/", "/a", "/bb"];

/** A fresh evaluation of reader `i` under `route`, from current values. */
function oracle(get: G, route: string, reader: Reader): string {
  const c = (i: number): number => F[i]!(get, () => route, c);
  try {
    return String(reader.pure(get, () => route, c));
  } catch {
    return "E";
  }
}

type Reader = {
  name: string;
  live: () => unknown;
  pure: (g: G, r: R, c: C) => unknown;
  /** A tracked read: a subscriber that made it is re-run when it changes. */
  tracked: boolean;
  memo?: boolean;
};

/** A live subscriber whose last values must equal the oracle after every
 *  op: an effect (global route) or an effect/computed rendering a page given
 *  its own route (`route`). Catches a subscriber the graph stopped reaching. */
type Watched = {
  id: number;
  picks: number[];
  route: string | null;
  vals: string[];
};

/** What the scoped runs actually exercised — asserted non-zero, so a
 *  generator that stopped reaching an op cannot go green on nothing. */
const exercised = {
  scopedReads: 0,
  inRenderCreates: 0,
  streams: 0,
  memoReads: 0, //        an effect read a trackedMemo
  inRenderMemoEffects: 0, // … and was created inside a render
  watches: 0,
  nestedRenders: 0, //    a route render inside a tracking frame
  memoRecovers: 0, //     a subscriber saw a memo throw, then its value again
};

/** One program, run plain or scoped; its global log. */
async function program(seed: number, scoped: boolean): Promise<string[]> {
  const rand = rng(seed);
  const log: string[] = [];
  const s = [signal(0), signal(1), signal(2), signal(3)];
  const cs: { value: number; peek(): number }[] = [];
  for (let i = 0; i < F.length; i++) {
    cs.push(
      computed(() =>
        F[i]!((k) => s[k]!.value, () => routePath.value, (j) => cs[j]!.value)
      ),
    );
  }
  const memo = trackedMemo((k: number) =>
    MEMO(k, (j) => s[j]!.value, () => routePath.value, (j) => cs[j]!.value)
  );
  const tmemo = trackedMemo((k: number) =>
    TMEMO(k, (j) => s[j]!.value, () => routePath.value, (j) => cs[j]!.value)
  );
  const readers: Reader[] = [];
  for (let i = 0; i < F.length; i++) {
    const pure = (_g: G, _r: R, c: C) => c(i);
    readers.push({
      name: `c${i}`,
      live: () => cs[i]!.value,
      pure,
      tracked: true,
    });
    readers.push({
      name: `p${i}`,
      live: () => cs[i]!.peek(),
      pure,
      tracked: false,
    });
    readers.push({
      name: `u${i}`,
      live: () => untrack(() => cs[i]!.value),
      pure,
      tracked: false,
    });
  }
  for (const k of [0, 3, 4, 5, 7]) {
    readers.push({
      name: `m${k}`,
      live: () => memo(k),
      pure: (g, r, c) => MEMO(k, g, r, c),
      tracked: true,
      memo: true,
    });
  }
  for (const k of [1, 6]) {
    readers.push({
      name: `t${k}`,
      live: () => tmemo(k),
      pure: (g, r, c) => TMEMO(k, g, r, c),
      tracked: true,
      memo: true,
    });
  }
  readers.push({
    name: "route",
    live: () => routePath.value,
    pure: (_g, r) => r(),
    tracked: true,
  });
  const read = (r: Reader): string => {
    try {
      return String(r.live());
    } catch {
      return "E";
    }
  };
  const get: G = (k) => s[k]!.peek();
  const stops: (() => void)[] = [];
  const mismatches: string[] = [];
  const watched: Watched[] = [];
  /** Every live subscriber is up to date: each TRACKED value it last saw is
   *  what a fresh evaluation gives now (an untracked one may lag — by design). */
  const checkWatched = (step: number) => {
    for (const w of watched) {
      const route = w.route ?? routePath.peek();
      w.picks.forEach((i, at) => {
        const r = readers[i]!;
        if (!r.tracked) return;
        const want = oracle(get, route, r);
        if (w.vals[at] !== want) {
          mismatches.push(
            `step ${step}: subscriber ${w.id} (${
              w.route ?? "global"
            }) ${r.name} is stale: ${w.vals[at]}, want ${want}`,
          );
        }
      });
    }
  };
  /** A memo value a subscriber saw: counts a throw, then a recovery. */
  const sawMemo = (w: Watched, i: number, val: string, threw: Set<number>) => {
    if (!scoped || !readers[i]!.memo) return;
    exercised.memoReads++;
    if (val === "E") threw.add(i);
    else if (threw.delete(i)) exercised.memoRecovers++;
  };

  /** A component reading `picks` in its render, each checked against the
   *  oracle for `route` — the scoped half of the contract. */
  const Reads = (p: { picks: number[]; route: string }) => {
    const got = p.picks.map((i) => read(readers[i]!));
    exercised.scopedReads += got.length;
    const want = p.picks.map((i) => oracle(get, p.route, readers[i]!));
    if (got.join() !== want.join()) {
      mismatches.push(
        `${p.route}: ${
          p.picks.map((i) => readers[i]!.name)
        } got ${got} want ${want}`,
      );
    }
    return h("i", null, got.join(","));
  };
  /** Create `make()` globally (plain) or inside a render (scoped). A
   *  creation that throws (a watch over a computed that throws right now)
   *  is logged the same in both. */
  const create = (id: number, make: () => () => void, route: string) => {
    try {
      if (!scoped) return void stops.push(make());
      exercised.inRenderCreates++;
      renderToString(
        h(() => {
          stops.push(make());
          return h("b", null, "x");
        }, null) as VNode,
        { route },
      );
    } catch {
      log.push(`x${id}`);
    }
  };

  routePath.set("/");
  try {
    for (let step = 0; step < 40; step++) {
      if (mismatches.length) break;
      if (step > 0) checkWatched(step - 1);
      const op = rand(12);
      // Every draw happens in BOTH runs, so the programs stay in step.
      const a = rand(4), v = rand(9), b = rand(4), w = rand(9);
      const route = ROUTES[rand(ROUTES.length)]!;
      const route2 = ROUTES[rand(ROUTES.length)]!;
      const picks = [rand(readers.length), rand(readers.length)];
      const picks2 = [rand(readers.length), rand(readers.length)];
      const id = step;
      if (op < 3) s[a]!.set(v);
      else if (op === 3) {
        batch(() => {
          s[a]!.set(v);
          s[b]!.set(w);
        });
      } else if (op === 4) routePath.set(route);
      else if (op === 5) {
        const w: Watched = { id, picks, route: null, vals: [] };
        const threw = new Set<number>();
        let inRender = false;
        create(
          id,
          () => {
            inRender = scoped;
            watched.push(w);
            return effect(() => {
              w.vals = picks.map((i) => read(readers[i]!));
              for (const [at, i] of picks.entries()) {
                sawMemo(w, i, w.vals[at]!, threw);
              }
              log.push(`e${id}:${w.vals}`);
            });
          },
          route,
        );
        if (inRender && picks.some((i) => readers[i]!.memo)) {
          exercised.inRenderMemoEffects++;
        }
      } else if (op === 6) {
        if (scoped) exercised.watches++;
        const target = cs[picks[0]! % F.length]!;
        create(
          id,
          () =>
            watch(
              target as never,
              (x: unknown) => void log.push(`w${id}:${x}`),
            ),
          route,
        );
      } else if (op === 7) {
        log.push(`g${id}:${picks.map((i) => read(readers[i]!))}`);
      } else if (op === 11) {
        // A route render NESTED in a tracking frame: an effect rendering a
        // page directly, or reading a computed that renders it. Its frame is a
        // SUBSCRIBER opened under the render's read scope — what it touched
        // must be linked globally, or a later write never re-renders it.
        if (!scoped) continue;
        exercised.nestedRenders++;
        const w: Watched = { id, picks, route, vals: [] };
        const threw = new Set<number>();
        const render = () => {
          const html = renderToString(h(Reads, { picks, route }) as VNode, {
            route,
          });
          return html.replace(/^<i>|<\/i>$/g, "");
        };
        const page = a % 2 ? computed(render) : null;
        watched.push(w);
        stops.push(effect(() => {
          const html = page ? page.value : render();
          w.vals = html === "" ? [] : html.split(",");
          for (const [at, i] of picks.entries()) {
            sawMemo(w, i, w.vals[at] ?? "", threw);
          }
        }));
      } else if (op < 10) {
        if (!scoped) continue;
        if (op === 8) {
          renderToString(h(Reads, { picks, route }) as VNode, { route });
        } else {
          // Two streams, pulled in turn: interleaved renders, two routes.
          const page = (ps: number[], rt: string) =>
            h(
              "div",
              null,
              h(Reads, { picks: ps, route: rt }),
              h(Reads, { picks: [...ps].reverse(), route: rt }),
            ) as VNode;
          const s1 = renderToStream(page(picks, route), undefined, { route });
          const s2 = renderToStream(page(picks2, route2), undefined, {
            route: route2,
          });
          exercised.streams += 2;
          let d1 = false, d2 = false;
          while (!d1 || !d2) {
            if (!d1) d1 = (await s1.next()).done === true;
            if (!d2) d2 = (await s2.next()).done === true;
          }
        }
      } else {
        // A render that ALSO writes: a signal set from a component mid-render
        // flushes the global effects right there.
        if (!scoped) {
          s[a]!.set(v);
          continue;
        }
        renderToString(
          h(() => {
            s[a]!.set(v);
            return h(Reads, { picks, route });
          }, null) as VNode,
          { route },
        );
      }
    }
    checkWatched(40);
    log.push(`final:${readers.map(read)}`);
  } finally {
    for (const stop of stops) stop();
    routePath.set("/");
  }
  if (mismatches.length) {
    throw new Error(
      `scoped reads disagree with the oracle:\n${mismatches.join("\n")}`,
    );
  }
  return log;
}

// One fixed name (the mutation ledger names it); the seed and the round count
// are in every failure message instead.
Deno.test("signal scope differential: scoped reads never change what the global side observes", async () => {
  const first = SEED;
  const count = ONE ? 1 : ROUNDS;
  let ran = 0;
  for (let i = 0; i < count; i++) {
    const seed = (first + i) >>> 0;
    const plain = await program(seed, false);
    let scoped: string[];
    try {
      scoped = await program(seed, true);
    } catch (e) {
      throw new Error(`FUZZ_SEED=${seed}: ${(e as Error).message}`);
    }
    assertEquals(
      scoped,
      plain,
      `FUZZ_SEED=${seed}: the global log changed because renders read the graph`,
    );
    ran++;
  }
  assertEquals(ran, count);
  // Every count must be non-zero — one replayed seed need not reach them all.
  if (!ONE) {
    assertEquals(
      exercised.scopedReads > count &&
        Object.values(exercised).every((n) => n > 0),
      true,
      JSON.stringify(exercised),
    );
  }
});

// A subscriber other than an effect (the client renderer's component frame is
// one) that tracks from inside a read scope must be subscribed to what the
// scope's evaluation read — a computed it touched may be unsettled globally,
// linked to nothing, so no later write would reach it through that computed.
// For a computed read and for a trackedMemo hit alike.
Deno.test("signal scope: a subscriber frame opened under a read scope is linked to the global graph", () => {
  for (const via of ["computed", "trackedMemo"] as const) {
    const src = signal(1);
    const dbl = computed(() => src.value * 2); // never read globally
    const memo = trackedMemo((k: number) => dbl.value + k);
    const prev = _enterReadScope({});
    let deps: Set<unknown>;
    try {
      deps = _trackStart();
      try {
        assertEquals(via === "computed" ? dbl.value : memo(0), 2);
      } finally {
        _trackEnd(deps as never);
      }
    } finally {
      _enterReadScope(prev);
    }
    let fired = 0;
    const sub = { execute: () => void fired++ };
    for (const d of deps) {
      (d as { _subscribers: Set<unknown> })._subscribers.add(sub);
    }
    src.set(2);
    assertEquals(fired > 0, true, `${via}: the write never reached it`);
    assertEquals(dbl.peek(), 4);
  }
});

// Found by the differential: the global computed a subscriber holds may branch
// elsewhere (on the route) — a write to what the RENDER'S branch read must
// still re-run a render nested in an effect.
Deno.test("signal scope: a render nested in an effect re-runs when what its route's branch read changes", () => {
  for (const via of ["computed", "trackedMemo"] as const) {
    const a = signal(1), b = signal(10);
    const c = computed(() => routePath.value === "/x" ? b.value : a.value);
    const memo = trackedMemo((k: number) => c.value + k);
    const out: string[] = [];
    const Page = () =>
      h("i", null, String(via === "computed" ? c.value : memo(0)));
    const stop = effect(() => {
      out.push(renderToString(h(Page, null) as VNode, { route: "/x" }));
    });
    try {
      b.set(11);
    } finally {
      stop();
    }
    assertEquals(out, ["<i>10</i>", "<i>11</i>"], via);
  }
});

// A scoped read of a computed that threw re-evaluates it, as a global read
// does — even with nothing it read to change (what it threw on is not a signal).
Deno.test("signal scope: a computed that threw is re-evaluated on its next scoped read", () => {
  for (const scope of [null, {}]) {
    let fail = true;
    const c = computed(() => {
      if (fail) throw new Error("not yet");
      return 1;
    });
    const prev = _enterReadScope(scope);
    try {
      assertThrows(() => c.value, Error, "not yet");
      fail = false;
      assertEquals(c.value, 1, scope ? "scoped" : "global");
    } finally {
      _enterReadScope(prev);
    }
  }
});

// A subscriber frame reading many computeds over one shared subtree walks
// each scoped entry once — not once per reader (1000 readers over 200 mids
// over 2000 leaves was 1000× the subtree) — and still hears every leaf.
Deno.test("signal scope: a subscriber frame walks each scoped entry once", () => {
  const leaves = Array.from({ length: 2000 }, (_, i) => signal(i));
  const mids = Array.from({ length: 200 }, (_, j) =>
    computed(() => {
      let s = 0;
      for (let i = j * 10; i < j * 10 + 10; i++) s += leaves[i]!.value;
      return s;
    }));
  const root = computed(() => mids.reduce((x, m) => x + m.value, 0));
  const readers = Array.from(
    { length: 1000 },
    () => computed(() => root.value),
  );
  const entries = readers.length + 1 + mids.length;
  let runs = 0, total = 0;
  const before = _scopedWalksNow();
  const stop = effect(() => {
    runs++;
    const prev = _enterReadScope({});
    try {
      total = readers.reduce((x, r) => x + r.value, 0);
    } finally {
      _enterReadScope(prev);
    }
  });
  try {
    assertEquals(_scopedWalksNow() - before, entries, "one walk per entry");
    leaves[1999]!.set(0);
    assertEquals(runs, 2, "a leaf write re-runs it");
    assertEquals(total, readers.length * (1999 * 2000 / 2 - 1999));
    assertEquals(_scopedWalksNow() - before, 2 * entries);
  } finally {
    stop();
  }
});

// `untrack` inside a render opens a throwaway frame; marking it scoped keeps a
// scoped read from walking its whole subtree into a frame nobody keeps.
Deno.test("signal scope: untrack inside a render walks nothing", () => {
  const leaves = Array.from({ length: 50 }, (_, i) => signal(i));
  const sum = computed(() => leaves.reduce((x, s) => x + s.value, 0));
  let got = 0;
  const before = _scopedWalksNow();
  const stop = effect(() => {
    const prev = _enterReadScope({});
    try {
      got = untrack(() => sum.value);
    } finally {
      _enterReadScope(prev);
    }
  });
  try {
    assertEquals(got, 50 * 49 / 2);
    assertEquals(_scopedWalksNow() - before, 0, "untrack walked a subtree");
  } finally {
    stop();
  }
});
