// A `worker: true` cell and the same cell in-isolate must answer a random
// method sequence identically: every return value, every error's
// message/name/code, the committed state after each step, and the health row
// (`errors`, `enabled`, `status`, whether a `lastAction` is known) — with
// breaker trips and `cells.disable`/`enable` interleaved.
//
// Found by it: a worker cell's health row said `lastAction: undefined` for the
// whole life of the app — its calls never reach the owner's reduce, which is
// where the row is written — while the same cell in-isolate named its last
// call (`/__aio/health` shows that field).
import { assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { wdiff } from "./fixtures/worker-differential-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-differential-app.ts");
const W = wdiff as unknown as Record<string, (...a: unknown[]) => unknown>;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Health = {
  name: string;
  errors: number;
  enabled: boolean;
  status?: string;
  lastAction?: string;
};

const OPS: [string, (r: () => number) => unknown[]][] = [
  ["inc", (r) => [r() % 7 - 2]],
  ["push", (r) => [r() % 50]],
  ["setKey", (r) => [
    ["a", "b", "c"][r() % 3],
    [1, "s", null, { z: 1 }, [1, 2]][r() % 5],
  ]],
  ["del", (r) => [["a", "b", "c"][r() % 3]]],
  ["truncate", (r) => [r() % 4]],
  ["splice", (r) => [r() % 3]],
  ["unshift", (r) => [r() % 9]],
  ["reverse", () => []],
  ["sort", () => []],
  ["setUndef", () => []],
  ["delUndef", () => []],
  ["append", (r) => ["ab".slice(r() % 2)]],
  ["prepend", () => ["p"]],
  ["nestPush", (r) => [r() % 5]],
  ["nestReplace", () => []],
  ["retObj", () => []],
  ["retList", () => []],
  ["big", () => []],
  ["boom", () => []],
  ["noop", () => []],
  ["asyncInc", (r) => [r() % 5]],
  ["asyncBoom", () => []],
  ["asyncBig", () => []],
  ["disable", () => []],
  ["enable", () => []],
];

/** xorshift32 — the same sequence for both runs of a seed. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}

async function run(real: boolean, seed: number) {
  await using srv = await testServer({
    cells: [wdiff],
    ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
    circuitBreaker: { maxErrors: 4 },
  });
  const cells = (srv.app as unknown as {
    cells: {
      health(): Health[];
      disable(n: string): void;
      enable(n: string): void;
    };
  }).cells;
  const r = rng(seed);
  const trace: unknown[] = [];
  for (let i = 0; i < 80; i++) {
    const [m, args] = OPS[r() % OPS.length]!;
    const a = args(r);
    let out: unknown;
    try {
      if (m === "disable") {
        cells.disable("wdiff");
        out = "disabled";
        // A worker cell's reset lands one round trip later, by design.
        await tick(60);
      } else if (m === "enable") {
        cells.enable("wdiff");
        out = "enabled";
      } else out = { ok: await W[m]!(...a) };
    } catch (e) {
      const x = e as Error & { code?: unknown };
      out = { err: x.message, name: x.name, code: x.code };
    }
    await tick(5);
    const h = cells.health().find((h) => h.name === "wdiff")!;
    trace.push({
      i,
      m,
      a,
      out,
      state: JSON.parse(
        JSON.stringify((srv.state() as { wdiff: unknown }).wdiff),
      ),
      h: {
        errors: h.errors,
        enabled: h.enabled,
        status: h.status,
        // Which action is named differs by design (the in-isolate reduce
        // names an async method's internal commit); that one is known must not.
        knowsLast: h.lastAction !== undefined,
      },
    });
  }
  return trace;
}

for (const seed of [9, 12, 16, 21]) {
  Deno.test(`worker differential fuzz: seed ${seed} answers as in-isolate`, async () => {
    const inIsolate = await run(false, seed);
    const real = await run(true, seed);
    assertEquals(inIsolate.length, 80);
    for (let i = 0; i < inIsolate.length; i++) {
      assertEquals(real[i], inIsolate[i], `step ${i}`);
    }
  });
}

Deno.test("worker differential fuzz: a worker cell's health names the method it last ran", async () => {
  await using srv = await testServer({
    cells: [wdiff],
    workers: "real",
    workerEntry: ENTRY,
  });
  const cells = (srv.app as unknown as { cells: { health(): Health[] } })
    .cells;
  await W.inc!(1);
  const h = cells.health().find((h) => h.name === "wdiff")!;
  assertEquals(h.lastAction, "wdiff:inc");
});
