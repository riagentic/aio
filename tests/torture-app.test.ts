// torture-app.test.ts — an in-process app exercising UNUSUAL-but-legal cell
// patterns the author's own apps never hit: huge array state, 10-level nesting,
// 50-cell fan-out with a diamond call graph, async self-recursion, until()
// interleaving, cancelOn in both the sync prefix and mid-await, own/schedule
// churn, and hostile unicode payloads. Boots a REAL server per test via
// aio.run({ libraryMode: true }) — no mocks, sanitizers on.
//
// Contract: this file never edits src/. A red assertion here is a framework
// finding, not a test to weaken.
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { aio } from "../src/server/aio.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { sleep, until } from "../src/state/async-helpers.ts";
import { own } from "../src/state/own.ts";
import { schedule } from "../src/state/schedule.ts";

// ── Boot helper ─────────────────────────────────────────────────────

type App = Awaited<ReturnType<typeof aio.run>>;

async function boot(appId: string, cells: unknown[]): Promise<App> {
  return await aio.run({
    cells: cells as never,
    appId,
    libraryMode: true,
    persist: false,
    client: "server-only",
  });
}

const settle = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

// ── 1. One big array: 10k objects, splice/sort/reverse ──────────────

Deno.test("torture: 10k-object array state — splice/sort/reverse stay consistent, dispatch sane", async () => {
  _resetAioRuntime();
  type Row = { id: number; name: string; score: number };
  const big = cell("t-big", {
    state: { rows: [] as Row[] },
    methods: {
      seed(s, n: number) {
        for (let i = 0; i < n; i++) {
          s.rows.push({ id: i, name: `row-${i}`, score: (i * 7919) % 1000 });
        }
      },
      spliceRange(s, start: number, del: number, insert: number) {
        const add: Row[] = Array.from({ length: insert }, (_, i) => ({
          id: 100_000 + start + i,
          name: `ins-${start + i}`,
          score: 5000 + i,
        }));
        s.rows.splice(start, del, ...add);
      },
      sortByScore(s) {
        s.rows.sort((a, b) => a.score - b.score || a.id - b.id);
      },
      reverse(s) {
        s.rows.reverse();
      },
    },
  });
  const app = await boot("torture-big", [big]);
  const rows = () => (app.getState() as any)["t-big"].rows as Row[];
  try {
    const t0 = performance.now();
    await big.seed(10_000);
    await settle();
    const seedMs = performance.now() - t0;
    assertEquals(rows().length, 10_000);
    assert(seedMs < 10_000, `10k seed dispatch took ${seedMs}ms`);

    await big.spliceRange(5_000, 100, 50); // -100 +50
    await settle();
    assertEquals(rows().length, 9_950);
    assertEquals(rows()[5_000]!.name, "ins-5000", "splice landed in place");

    const t1 = performance.now();
    await big.sortByScore();
    await settle();
    const sortMs = performance.now() - t1;
    assert(sortMs < 10_000, `10k sort dispatch took ${sortMs}ms`);
    const sorted = rows();
    for (let i = 1; i < sorted.length; i++) {
      assert(
        sorted[i - 1]!.score <= sorted[i]!.score,
        `sort broke at index ${i}`,
      );
    }
    assertEquals(
      sorted[sorted.length - 1]!.score,
      5049,
      "spliced-in max score sorted last",
    );

    await big.reverse();
    await settle();
    const rev = rows();
    assertEquals(rev[0]!.score, 5049, "reverse flipped the order");
    for (let i = 1; i < rev.length; i++) {
      assert(rev[i - 1]!.score >= rev[i]!.score, `reverse broke at ${i}`);
    }
    assertEquals(rev.length, 9_950, "no rows lost across mutations");
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

// ── 2. Deeply nested state: 10 levels, leaf writes via long paths ───

Deno.test("torture: 10-level nested state — leaf mutations via long paths keep siblings intact", async () => {
  _resetAioRuntime();
  const deep = cell("t-deep", {
    state: {
      l1: {
        sib: "s1",
        l2: {
          sib: "s2",
          l3: {
            sib: "s3",
            l4: {
              sib: "s4",
              l5: {
                sib: "s5",
                l6: {
                  sib: "s6",
                  l7: {
                    sib: "s7",
                    l8: {
                      sib: "s8",
                      l9: { sib: "s9", l10: { value: 0, tag: "leaf" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    methods: {
      setLeaf(s, v: number) {
        s.l1.l2.l3.l4.l5.l6.l7.l8.l9.l10.value = v;
      },
      renameMid(s, v: string) {
        s.l1.l2.l3.l4.l5.sib = v;
      },
    },
  });
  const app = await boot("torture-deep", [deep]);
  const root = () => (app.getState() as any)["t-deep"];
  try {
    for (let i = 1; i <= 20; i++) await deep.setLeaf(i);
    await settle();
    const leaf = root().l1.l2.l3.l4.l5.l6.l7.l8.l9.l10;
    assertEquals(leaf.value, 20, "leaf 10 levels down holds the last write");
    assertEquals(leaf.tag, "leaf", "untouched leaf sibling preserved");
    assertEquals(root().l1.sib, "s1");
    assertEquals(root().l1.l2.l3.l4.l5.l6.l7.l8.sib, "s8");

    await deep.renameMid("mid!");
    await settle();
    assertEquals(root().l1.l2.l3.l4.l5.sib, "mid!");
    assertEquals(
      root().l1.l2.l3.l4.l5.l6.l7.l8.l9.l10.value,
      20,
      "leaf survives an unrelated mid-level write",
    );
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

// ── 3. 50 cells: 1→10 fan-out + diamond call pattern ────────────────

Deno.test("torture: 50 cells — fan-out to 10 + diamond A→(B,C)→D all settle, no deadlock", async () => {
  _resetAioRuntime();
  const workers = Array.from({ length: 45 }, (_, i) =>
    cell(`t-w${i}`, {
      state: { n: 0 },
      methods: {
        bump(s, by = 1) {
          s.n += by;
        },
      },
    }));

  const dD = cell("t-dD", {
    state: { hits: 0 },
    methods: {
      leaf(s) {
        s.hits += 1;
      },
    },
  });
  const dB = cell("t-dB", {
    state: { ran: 0 },
    methods: {
      async mid(s) {
        s.ran += 1;
        await dD.leaf();
      },
    },
  });
  const dC = cell("t-dC", {
    state: { ran: 0 },
    methods: {
      async mid(s) {
        s.ran += 1;
        await dD.leaf();
      },
    },
  });
  const dA = cell("t-dA", {
    state: { done: false },
    methods: {
      async start(s) {
        await Promise.all([dB.mid(), dC.mid()]);
        s.done = true;
      },
    },
  });
  const coord = cell("t-coord", {
    state: { rounds: 0 },
    methods: {
      async fanout(s) {
        // Direct calling: one method drives 10 other cells.
        await Promise.all(
          workers.slice(0, 10).map((w) => (w as any).bump(2)),
        );
        s.rounds += 1;
      },
    },
  });

  const app = await boot("torture-50", [
    ...workers,
    dA,
    dB,
    dC,
    dD,
    coord,
  ]);
  const slice = (name: string) => (app.getState() as any)[name];
  try {
    await coord.fanout();
    await coord.fanout();
    await dA.start();
    await settle();

    assertEquals(slice("t-coord").rounds, 2);
    for (let i = 0; i < 10; i++) {
      assertEquals(slice(`t-w${i}`).n, 4, `worker ${i} got both fan-outs`);
    }
    for (let i = 10; i < 45; i++) {
      assertEquals(slice(`t-w${i}`).n, 0, `worker ${i} untouched`);
    }
    assertEquals(slice("t-dA").done, true, "diamond apex settled");
    assertEquals(slice("t-dB").ran, 1);
    assertEquals(slice("t-dC").ran, 1);
    assertEquals(slice("t-dD").hits, 2, "shared base hit by both legs");
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

// ── 4. Async self-recursion + until() interleaving on ONE cell ──────

Deno.test("torture: async method calls ITSELF (bounded) — call count exact, state converges", async () => {
  _resetAioRuntime();
  const rec: any = cell("t-rec", {
    state: { calls: 0, floor: -1 },
    methods: {
      async grow(s, remaining: number) {
        s.calls += 1;
        s.floor = remaining;
        if (remaining > 0) {
          await sleep(1);
          await rec.grow(remaining - 1); // self-dispatch through the surface
        }
      },
    },
  });
  const app = await boot("torture-rec", [rec]);
  try {
    await rec.grow(25);
    await settle();
    const s = (app.getState() as any)["t-rec"];
    assertEquals(s.calls, 26, "25 recursive hops + the root call");
    assertEquals(s.floor, 0, "recursion bottomed out at 0");
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

Deno.test("torture: two async methods on the SAME cell interleave via until() — deterministic final state", async () => {
  _resetAioRuntime();
  const duo = cell("t-duo", {
    state: { flag: false, log: [] as string[] },
    methods: {
      async waitThenMark(s) {
        await until(() => s.flag, { timeoutMs: 3000, intervalMs: 2 });
        s.log.push("waiter");
      },
      async raiseThenMark(s) {
        await sleep(15);
        s.flag = true;
        s.log.push("raiser");
      },
    },
  });
  const app = await boot("torture-duo", [duo]);
  try {
    const a = duo.waitThenMark(); // blocks on live state via until()
    const b = duo.raiseThenMark(); // flips the flag mid-flight
    await Promise.all([a, b]);
    await settle();
    const s = (app.getState() as any)["t-duo"];
    assertEquals(
      s.log,
      ["raiser", "waiter"],
      "raiser commits first, waiter wakes on the LIVE flag — always this order",
    );
    assertEquals(s.flag, true);
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

// ── 5. cancelOn during the sync prefix vs during an await ───────────

Deno.test("torture: cancelOn fires from the method's OWN sync prefix — state stays consistent", async () => {
  _resetAioRuntime();
  const canc: any = cell("t-canc-sync", {
    state: { syncSteps: 0, outcome: "idle", stops: 0 },
    cancelOn: { work: ["t-canc-sync:stop"] },
    methods: {
      stop(s) {
        s.stops += 1;
      },
      async work(s: any) {
        s.syncSteps += 1; // sync prefix begins
        canc.stop(); // re-entrant dispatch DURING the sync prefix
        await sleep(5); // first suspension — abort observable after here
        if (s.$signal?.aborted) {
          s.outcome = "cancelled-sync-path";
          return;
        }
        s.outcome = "completed";
      },
    },
  });
  const app = await boot("torture-canc-sync", [canc]);
  try {
    await canc.work();
    await settle();
    const s = (app.getState() as any)["t-canc-sync"];
    assertEquals(s.syncSteps, 1, "sync prefix ran exactly once");
    assertEquals(s.stops, 1, "the re-entrant stop committed");
    assertEquals(
      s.outcome,
      "cancelled-sync-path",
      "abort raised by the sync prefix is visible after the first await",
    );
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

Deno.test("torture: cancelOn fires DURING an await — abort observed, no partial writes after", async () => {
  _resetAioRuntime();
  const canc: any = cell("t-canc-await", {
    state: { phase: "idle", tail: 0 },
    cancelOn: { work: ["t-canc-await:stop"] },
    methods: {
      stop(s) {
        s.phase = "stopping";
      },
      async work(s: any) {
        s.phase = "working";
        await sleep(25); // stop() lands inside this window
        if (s.$signal?.aborted) {
          s.phase = "cancelled";
          return;
        }
        s.phase = "done";
        s.tail += 1;
      },
    },
  });
  const app = await boot("torture-canc-await", [canc]);
  try {
    const p = canc.work();
    await sleep(8);
    await canc.stop();
    await p;
    await settle();
    const s = (app.getState() as any)["t-canc-await"];
    assertEquals(s.phase, "cancelled", "mid-await abort taken");
    assertEquals(s.tail, 0, "no writes past the abort check");

    // Same method with NO cancel completes — both paths are deterministic.
    await canc.work();
    await settle();
    assertEquals(
      (app.getState() as any)["t-canc-await"].phase,
      "done",
      "uncancelled run completes normally",
    );
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

// ── 6. schedule + own churn: 100 acquire/release cycles, no leak ────

Deno.test("torture: own.set + schedule churn 100× — every disposer runs, no timer leaks (sanitizers on)", async () => {
  _resetAioRuntime();
  let acquired = 0;
  let disposed = 0;
  const res = cell("t-res", {
    state: { cycles: 0 },
    methods: {
      noop(_s) {},
      cycle(s): any[] {
        s.cycles += 1;
        return [
          // Replace semantics: previous disposer must run before the new factory.
          own.set("t-res:slot", () => {
            acquired += 1;
            return () => {
              disposed += 1;
            };
          }),
          // Same id ⇒ replaces the pending timer instead of stacking 100 of them.
          schedule.after("t-res:tick", 60_000, {
            type: "t-res:noop",
            payload: { args: [] },
          }),
        ];
      },
      release(_s): any[] {
        return [own.dispose("t-res:slot"), schedule.cancel("t-res:tick")];
      },
    },
  });
  const app = await boot("torture-own", [res]);
  try {
    for (let i = 0; i < 100; i++) await res.cycle();
    await settle();
    assertEquals(
      (app.getState() as any)["t-res"].cycles,
      100,
      "all 100 cycles committed",
    );
    assertEquals(acquired, 100, "factory ran every cycle");
    assertEquals(disposed, 99, "each re-acquire disposed its predecessor");

    await res.release();
    await settle();
    assertEquals(disposed, 100, "explicit release freed the last slot");
    // The leak assertion is the test's OWN exit: sanitizers are on, so a
    // schedule timer surviving release()+close() fails this test loudly.
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

// ── 7. Hostile strings as state values ──────────────────────────────

Deno.test("torture: hostile strings — emoji/RTL/null bytes/1MB survive dispatch + selector reads", async () => {
  _resetAioRuntime();
  const ZWJ_FAMILY = "👩‍👩‍👧‍👦"; // multi-codepoint ZWJ sequence
  const RTL = "‫مرحبا שלום‬ mixed ‮evil‬";
  const NULLS = "null\u0000byte\u0000tail";
  const MEGA = "𝔘".repeat(262_144) + "end"; // ~1MB in UTF-16 units (surrogate pairs)
  const uni: any = cell("t-uni", {
    state: { text: "", list: [] as string[] },
    selectors: {
      textUnits: (s: { text: string }) => s.text.length,
      lastEntry: (s: { text: string; list: string[] }) =>
        s.list[s.list.length - 1] ?? "",
    },
    methods: {
      setText(s, v: string) {
        s.text = v;
      },
      push(s, v: string) {
        s.list.push(v);
      },
    },
  });
  const app = await boot("torture-uni", [uni]);
  const slice = () => (app.getState() as any)["t-uni"];
  try {
    for (const v of [ZWJ_FAMILY, RTL, NULLS]) {
      await uni.setText(v);
      await uni.push(v);
      await settle(10);
      assertEquals(slice().text, v, "value round-trips dispatch byte-exact");
      assertEquals(uni.textUnits(), v.length, "selector reads hostile value");
      assertEquals(uni.lastEntry(), v, "list selector sees the pushed value");
    }
    assertEquals(slice().list.length, 3);

    const t0 = performance.now();
    await uni.setText(MEGA);
    await settle(10);
    const megaMs = performance.now() - t0;
    assertEquals(slice().text.length, MEGA.length, "1MB string intact");
    assert(slice().text.endsWith("end"), "1MB string not truncated");
    assertEquals(uni.textUnits(), MEGA.length, "selector over 1MB string");
    assert(megaMs < 10_000, `1MB dispatch took ${megaMs}ms`);

    // Earlier hostile values are still there — the big write clobbered nothing.
    assertEquals(slice().list[2], NULLS, "null bytes preserved in the list");
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});
