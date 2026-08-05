// Time travel's history is an OBSERVATION. Every column in it has to belong to
// the entry it is printed on.
//
// Two of them did not, and both failures were silent — the panel
// (`src/air/time-travel-panel.ts`) renders a per-entry timing and an error
// badge, and simply had nothing to draw:
//
//  • PERF. `buildOnPerf(tt, …)` captured the TTState BY VALUE at boot. `record()`
//    returns a NEW state object per action, so the closure kept writing into the
//    boot-time snapshot forever — whose one entry (`__init`) is shared by
//    reference with every later history. Result: every real action showed no
//    timing at all, and `__init` showed the timing of whatever ran LAST. The
//    identical stale-capture bug two functions above (`buildReportOpts`) had
//    already been fixed with a getter, with a comment explaining why.
//
//  • ERRORS. `buildReportOpts` decided whether to install `markError` by calling
//    its own getter at CONSTRUCTION time — and it is constructed before
//    time-travel exists, so the getter returned null, the shim was never
//    installed, and NO error ever reached a history entry in a running app.
//
// A dev inspector that quietly shows nothing is worse than one that is off:
// "no error on any entry" reads as "nothing failed".

import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { testServer } from "../src/testing/server-test.ts";
import { buildReportOpts } from "../src/server/aio-run-helpers.ts";
import { createTT, record } from "../src/diagnostics/time-travel.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

type Hist = {
  entries: {
    id: number;
    type: string;
    perf?: { reduce: number; effects: number };
    error?: { code: string; message: string };
  }[];
};

async function history(url: string): Promise<Hist> {
  const r = await fetch(`${url}/__aio/trojan/history`);
  const t = await r.text();
  assertEquals(r.status, 200, t);
  return JSON.parse(t) as Hist;
}

Deno.test("time travel: an action's timing is on that action's entry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ttat-p-" });
  try {
    const c = cell("ttp", {
      state: { n: 0 },
      methods: {
        slow(s: { n: number }) {
          const end = performance.now() + 8;
          while (performance.now() < end); // 8ms inside reduce
          s.n++;
        },
      },
    });
    await using srv = await testServer({
      cells: [c],
      baseDir: dir,
      appId: "ttat-p",
      diagnostics: { dev: { timeTravel: true } },
    } as Any);
    (c as Any).slow();
    await new Promise((r) => setTimeout(r, 50));

    const h = await history(srv.url);
    const slow = h.entries.find((e) => e.type === "ttp:slow");
    assert(slow, `no entry for the action at all: ${JSON.stringify(h)}`);
    assert(
      slow.perf,
      `the action that burned 8ms in reduce carries NO timing — ` +
        `every entry's perf went to a discarded boot snapshot: ${
          JSON.stringify(h)
        }`,
    );
    assert(
      slow.perf.reduce >= 5,
      `the timing on the entry must be THIS action's (~8ms), got ${slow.perf.reduce}ms`,
    );
    const init = h.entries.find((e) => e.type === "__init");
    assert(
      !init?.perf || init.perf.reduce < 5,
      `the synthetic __init entry is wearing another action's timing: ${
        JSON.stringify(init)
      }`,
    );
    _resetAioRuntime();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("time travel: a failing action's entry carries the error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ttat-e-" });
  try {
    const c = cell("tte", {
      state: { n: 0 },
      methods: {
        ok(s: { n: number }) {
          s.n++;
        },
        async boom(s: { n: number }) {
          await Promise.resolve();
          s.n++;
          throw new Error("kaboom");
        },
      },
    });
    await using srv = await testServer({
      cells: [c],
      baseDir: dir,
      appId: "ttat-e",
      diagnostics: { dev: { timeTravel: true } },
    } as Any);
    (c as Any).ok();
    await (c as Any).boom().catch(() => {});
    await new Promise((r) => setTimeout(r, 150));

    const h = await history(srv.url);
    const failed = h.entries.filter((e) => e.error);
    assert(
      failed.length > 0,
      `an action threw — the app counted the error — and no history entry ` +
        `shows it. markError was never wired: ${JSON.stringify(h)}`,
    );
    assert(
      failed.every((e) => e.type.startsWith("tte:")),
      `the error must land on the failing cell's entry: ${
        JSON.stringify(failed)
      }`,
    );
    assert(
      !h.entries.find((e) => e.type === "tte:ok")?.error,
      `the innocent action before it must not be marked: ${JSON.stringify(h)}`,
    );
    _resetAioRuntime();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// buildReportOpts is built BEFORE time travel exists — that is the whole point
// of taking a getter. Deciding once, at construction, from that getter is the
// same as not taking one.
Deno.test("buildReportOpts: markError works when TT appears AFTER construction", () => {
  let tt: ReturnType<typeof createTT<{ x: number }, { type: string }>> | null =
    null;
  const opts = buildReportOpts(
    { onError: undefined, getTT: () => tt, prod: false } as Any,
  );
  // …time travel is created later in boot, exactly as aio.ts does it.
  tt = createTT<{ x: number }, { type: string }>();
  tt = record(tt, { type: "c:m" }, { x: 1 });
  opts.tt?.markError({
    code: "REDUCE_ERROR" as never,
    message: "kaboom",
    cellName: "c",
  });
  assertEquals(
    tt.entries[tt.index]!.error?.message,
    "kaboom",
    "the error never reached the live history",
  );
});
