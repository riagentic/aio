// A misspelled key INSIDE circuitBreaker / dispatchStorm / budgets /
// perfBudget / renderBudget (and inside a perfBudget.methods entry), or an
// unusable number there, booted in silence and the guard did nothing. Each
// booted through 1.0.24, so it is WARNED at boot — named, with the fix —
// and the app still boots.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { tuningBlockProblems } from "../src/server/config.ts";

function capture() {
  const out: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  for (const k of ["warn", "error", "log"] as const) {
    console[k] = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  }
  return { out, restore: () => Object.assign(console, orig) };
}

/** Boots with `extra`; returns the output. Fails if the boot is refused. */
async function bootWith(
  extra: Record<string, unknown>,
  methods: Record<string, unknown> = {
    bump(s: { n: number }) {
      s.n++;
    },
  },
  id = "tbk" + Math.random().toString(36).slice(2, 8),
): Promise<string[]> {
  _resetAioRuntime();
  const c = cell(id, { state: { n: 0 }, methods } as never);
  const cap = capture();
  try {
    const app = await aio.run({
      watch: false,
      appId: id + "-test",
      cells: [c],
      libraryMode: true,
      client: "server-only",
      dbPath: ":memory:",
      ...extra,
    } as never);
    await app.close();
  } finally {
    cap.restore();
    _resetAioRuntime();
  }
  return cap.out;
}

async function assertWarns(extra: Record<string, unknown>, ...words: string[]) {
  const out = await bootWith(extra);
  const line = out.find((l) => words.every((w) => l.includes(w)));
  assert(line, `no warning naming ${words.join(" + ")}:\n${out.join("\n")}`);
}

Deno.test("circuitBreaker { maxErorrs } boots and is warned with did-you-mean", () =>
  assertWarns(
    { circuitBreaker: { maxErorrs: 3 } },
    "maxErorrs",
    '"maxErrors"',
  ));
Deno.test("dispatchStorm { breakr } boots and is warned", () =>
  assertWarns({ dispatchStorm: { breakr: true } }, "breakr", '"breaker"'));
Deno.test("budgets { cellstate } boots and is warned", () =>
  assertWarns({ budgets: { cellstate: "1KB" } }, "cellstate", '"cellState"'));
Deno.test("perfBudget { reduc } boots and is warned", () =>
  assertWarns({ perfBudget: { reduc: 5 } }, "reduc", '"reduce"'));
Deno.test("renderBudget { stalness } boots and is warned", () =>
  assertWarns({ renderBudget: { stalness: 5 } }, "stalness", '"staleness"'));
Deno.test('circuitBreaker.window "1m" boots and is warned', () =>
  assertWarns(
    { circuitBreaker: { window: "1m", maxErrors: 3 } },
    "circuitBreaker.window",
    "60_000",
  ));
Deno.test("perfBudget.methods entry { timout } boots and is warned", async () => {
  const out = await bootWith(
    { perfBudget: { methods: { "tbkm:slow": { timout: 600_000 } } } },
    { async slow(_s: unknown) {} },
    "tbkm",
  );
  assert(
    out.some((l) => l.includes("timout") && l.includes('"timeout"')),
    out.join("\n"),
  );
});

Deno.test("tuningBlockProblems: numbers and entries", () => {
  const whats = tuningBlockProblems({
    circuitBreaker: { maxErrors: "3", window: -1 },
    perfBudget: {
      reduce: "fast",
      effect: 5,
      methods: { "a:b": { effect: -1, timeout: "never" }, "a:c": 5 },
    },
    renderBudget: { staleness: NaN, pendingPatches: 1.5 },
  }).map((p) => p.what);
  for (
    const w of [
      "circuitBreaker.maxErrors",
      "circuitBreaker.window",
      "perfBudget.reduce",
      'perfBudget.methods["a:b"].effect',
      'perfBudget.methods["a:b"].timeout',
      'perfBudget.methods["a:c"]',
      "renderBudget.staleness",
      "renderBudget.pendingPatches",
    ]
  ) {
    assert(
      whats.some((x) => x.startsWith(w)),
      `${w} not said:\n${whats.join("\n")}`,
    );
  }
});

Deno.test("tuningBlockProblems: every valid spelling is silent", () => {
  assertEquals(
    tuningBlockProblems({
      circuitBreaker: { maxErrors: 3, window: 60_000, onTrip: () => {} },
      dispatchStorm: { rate: 50, sustain: 2, breaker: true },
      budgets: { cellState: "1MB", broadcastRate: "20/s", payload: 1024 },
      perfBudget: {
        reduce: 100,
        effect: 5,
        methods: {
          "a:b": { effect: 5000, timeout: 600_000 },
          "a:c": { timeout: "warn" },
        },
      },
      renderBudget: { staleness: 300, pendingPatches: 10 },
    }),
    [],
  );
  assertEquals(tuningBlockProblems({ dispatchStorm: true }), []);
  assertEquals(tuningBlockProblems({ dispatchStorm: false }), []);
  assertEquals(tuningBlockProblems({}), []);
});
