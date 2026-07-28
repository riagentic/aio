// llama.md wishlist #1 — "the big one, and it bit me three times today".
//
// A cell whose state comes from the MACHINE (telemetry, a device, the clock)
// made its UI untestable: "does a stranded CPU-only placement get called out",
// "does the tuner refuse before the memory reading lands" either ran against
// whatever the developer's GPU was doing that second, or didn't run. That report
// ended up deriving the expectation at runtime and asserting whichever branch the
// hardware chose — a real test, but a much weaker one, and the interesting branch
// is precisely the one that doesn't fire on your box.
//
// `{ seed }` pins the state before the first render; `ui.seed()` moves it
// mid-test. An unknown cell name throws, because a silently-ignored seed looks
// like a pinned fixture while testing nothing at all.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

type HW = { gpus: string[]; vramMb: number; probed: boolean };

const hw = cell("hw-seed", {
  state: { gpus: [], vramMb: 0, probed: false } as HW,
  methods: {
    // In the real app this shells out to nvidia-smi — the whole problem.
    probe(s: HW) {
      s.probed = true;
    },
  },
});

function App() {
  const advice = hw.gpus.length === 0
    ? "CPU only — no GPU found"
    : hw.vramMb < 8000
    ? `${hw.gpus.length} GPU, low VRAM`
    : `${hw.gpus.length} GPU, ${hw.vramMb}MB`;
  return <div class="advice">{advice}</div>;
}

const advice = (ui: { html(): string }) =>
  ui.html().match(/class="advice"[^>]*>([^<]*)</)?.[1];

Deno.test("seed: pins machine-dependent state before the first render", async () => {
  await using ui = await testUI(App, {
    seed: { "hw-seed": { gpus: ["rtx4090"], vramMb: 24000 } },
  });
  assertEquals(
    advice(ui),
    "1 GPU, 24000MB",
    "the FIRST render already sees the fixture — not a re-render after it",
  );
  // Unseeded fields keep their declared defaults (per-cell shallow merge).
  assertEquals(ui.fullState(hw), {
    gpus: ["rtx4090"],
    vramMb: 24000,
    probed: false,
  });
});

Deno.test("seed: the branch that never fires on this machine is testable", async () => {
  // The point of the whole feature: assert the low-VRAM path without owning a
  // low-VRAM GPU.
  await using ui = await testUI(App, {
    seed: { "hw-seed": { gpus: ["gtx1060"], vramMb: 6000 } },
  });
  assertEquals(advice(ui), "1 GPU, low VRAM");
});

Deno.test("seed: no seed means the cell's declared initial state", async () => {
  await using ui = await testUI(App);
  assertEquals(advice(ui), "CPU only — no GPU found");
});

Deno.test("seed: ui.seed() moves state mid-test, and the UI reacts", async () => {
  await using ui = await testUI(App, { seed: { "hw-seed": { gpus: [] } } });
  assertEquals(advice(ui), "CPU only — no GPU found");

  // A device appears — the flow this exists for.
  ui.seed({ "hw-seed": { gpus: ["a100"], vramMb: 80000 } });
  await ui.settle();
  assertEquals(advice(ui), "1 GPU, 80000MB");
});

Deno.test("seed: methods still run against the seeded state", async () => {
  await using ui = await testUI(App, {
    seed: { "hw-seed": { gpus: ["rtx4090"], vramMb: 24000 } },
  });
  await hw.probe();
  await ui.settle();
  assertEquals(
    ui.fullState(hw),
    { gpus: ["rtx4090"], vramMb: 24000, probed: true },
    "a seed is a starting state, not a freeze",
  );
});

Deno.test("seed: an unknown cell name throws, listing what booted", async () => {
  let err: Error | null = null;
  try {
    await testUI(App, { seed: { "hw-typo": { gpus: [] } } });
  } catch (e) {
    err = e as Error;
  }
  assert(err, "a seed that matches no cell must not be silently ignored");
  assertStringIncludes(err.message, "hw-typo");
  assertStringIncludes(err.message, "hw-seed");
});
