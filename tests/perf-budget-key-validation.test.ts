// llama-master #15: `perfBudget.methods` is resolved at dispatch by exact
// `cell:method` string, with no boot check. An app declared 17 per-method budgets
// adopting the feature and one — `builds:installRelease` — named no method that
// exists. It had never applied to anything, and nothing would ever have said so:
// the symptom is a perf violation naming the METHOD, which sends you to read the
// method instead of the config.
//
// Same class as `strictCells` one layer up: configuration that silently governs
// nothing. The cells and their method names are in hand at aio.run(), so this is
// cheap to catch there.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const builds = cell("pbk-builds", {
  state: { n: 0 },
  methods: {
    start(s: { n: number }) {
      s.n++;
    },
    async scan(s: { n: number }) {
      await Promise.resolve();
      s.n++;
    },
  },
});

Deno.test("perfBudget: a key naming a real method is accepted", async () => {
  await using srv = await testServer({
    cells: [builds],
    perfBudget: { methods: { "pbk-builds:start": { effect: 1000 } } },
  });
  assert(srv.app, "boots normally");
});

Deno.test("perfBudget: an unknown method warns, naming the siblings", async () => {
  const warnings: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  for (const k of ["warn", "error", "log"] as const) {
    console[k] = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
  }
  try {
    await using _srv = await testServer({
      cells: [builds],
      // The exact shape of the real mistake: a method that lives inside another.
      perfBudget: {
        methods: { "pbk-builds:installRelease": { effect: 1000 } },
      },
    });
  } finally {
    Object.assign(console, orig);
  }
  const said = warnings.join("\n");
  assert(
    said.includes("pbk-builds:installRelease"),
    `must name the dead budget: ${said || "(silence)"}`,
  );
  assert(
    said.includes("start") && said.includes("scan"),
    `and list what the cell DOES have, so the typo is obvious: ${said}`,
  );
});

Deno.test("perfBudget: strictCells turns the warning into a boot failure", async () => {
  await assertRejects(
    () =>
      testServer({
        cells: [builds],
        strictCells: true,
        perfBudget: { methods: { "pbk-builds:nope": { effect: 1000 } } },
      }),
    Error,
    "pbk-builds:nope",
    "an app that asked for strict gets a hard stop, like strictCells itself",
  );
});

Deno.test("perfBudget: a key for an unknown CELL is caught too", async () => {
  // The framework logger picks its own sink; capture them all so the assertion
  // is about the message reaching a developer.
  const warnings: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  for (const k of ["warn", "error", "log"] as const) {
    console[k] = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
  }
  try {
    await using _srv = await testServer({
      cells: [builds],
      perfBudget: { methods: { "no-such-cell:start": { effect: 1000 } } },
    });
  } finally {
    Object.assign(console, orig);
  }
  assertEquals(
    warnings.join("\n").includes("no-such-cell:start"),
    true,
  );
});
