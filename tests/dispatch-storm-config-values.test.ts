// dispatchStorm's numbers were never checked: `rate: "200/s"` compared as NaN
// (the guard was OFF), and `rate: 0` made every action type "storm" — with
// `breaker`, dropped forever. Both still boot (the compatibility rule), are
// WARNED at boot, and the detector reads an unusable value as its default.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import {
  createStormDetector,
  STORM_DEFAULTS,
  stormConfigProblems,
} from "../src/diagnostics/dispatch-storm.ts";

async function bootOutput(dispatchStorm: unknown): Promise<string[]> {
  _resetAioRuntime();
  const id = "dsc" + Math.random().toString(36).slice(2, 8);
  const c = cell(id, {
    state: { n: 0 },
    methods: {
      bump(s) {
        s.n++;
      },
    },
  });
  const orig = { warn: console.warn, error: console.error, log: console.log };
  const out: string[] = [];
  for (const k of ["warn", "error", "log"] as const) {
    console[k] = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  }
  try {
    const app = await aio.run({
      watch: false,
      appId: id + "-test",
      cells: [c],
      libraryMode: true,
      client: "server-only",
      dbPath: ":memory:",
      dispatchStorm,
    } as never);
    await app.close();
  } finally {
    Object.assign(console, orig);
    _resetAioRuntime();
  }
  return out;
}

Deno.test('rate "200/s": warned at boot, and a 1000/s storm is still named', async () => {
  let t = 0;
  const storms: unknown[] = [];
  const d = createStormDetector({
    rate: "200/s" as unknown as number,
    sustain: 2,
    breaker: true,
    onStorm: (i) => storms.push(i),
    now: () => t,
  });
  for (let sec = 0; sec < 10; sec++) {
    for (let i = 0; i < 1000; i++) {
      d.track("x:loop");
      t += 1;
    }
  }
  assert(storms.length > 0, "the default rate was not used");
  const out = await bootOutput({ rate: "200/s", breaker: true });
  assert(
    out.some((l) => l.includes("dispatchStorm.rate") && l.includes('"200/s"')),
    out.join("\n"),
  );
});

Deno.test("rate 0 + breaker: warned at boot, and an idle action is never dropped", async () => {
  let t = 0;
  const d = createStormDetector({
    rate: 0,
    sustain: 2,
    breaker: true,
    now: () => t,
  });
  const results: boolean[] = [];
  for (let sec = 0; sec < 6; sec++) {
    results.push(d.track("ui:click"));
    t += 1500;
  }
  assert(!results.includes(false), `dropped: ${results}`);
  const out = await bootOutput({ rate: 0, breaker: true });
  assert(
    out.some((l) => l.includes("dispatchStorm.rate is 0")),
    out.join("\n"),
  );
});

Deno.test("stormConfigProblems: each bad value named, valid ones silent", () => {
  assertEquals(
    stormConfigProblems({ rate: 50, sustain: 3, breaker: false }),
    [],
  );
  assertEquals(stormConfigProblems(true), []);
  assertEquals(stormConfigProblems(undefined), []);
  const p = stormConfigProblems({ rate: NaN, sustain: 1.5, breaker: "false" });
  assertEquals(p.length, 3);
  assert(p[0]!.includes(`default ${STORM_DEFAULTS.rate}`));
  assert(p[1]!.includes(`default ${STORM_DEFAULTS.sustain}`));
  assert(p[2]!.includes("breaker"));
  assertEquals(stormConfigProblems("on").length, 1);
});

Deno.test("a valid rate is honoured exactly as before", () => {
  let t = 0;
  const storms: unknown[] = [];
  const d = createStormDetector({
    rate: 5,
    sustain: 1,
    onStorm: (i) => storms.push(i),
    now: () => t,
  });
  for (let i = 0; i < 6; i++) d.track("a:b");
  t += 1000;
  d.track("a:b");
  assertEquals(storms.length, 1);
});
