// The in-process boot (standalone-air: bootCells / testCell / testUI, the
// Android WebView) passed the app's `perfBudget` through raw, so dev's
// one-frame reduce budget never applied there: a 40 ms reduce that the dev
// server reports passed the harness silently — two boot paths, two answers.
// Both now go through `perfBudgetFor` (aipro §10 follow-up).
import { assert } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

const burn = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* busy */ }
};

async function said(
  fn: () => Promise<void>,
): Promise<string> {
  const out: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  const grab = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.warn = grab;
  console.error = grab;
  console.log = grab;
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return out.join("\n");
}

for (
  const [name, perfBudget] of [
    ["sdbnone", undefined],
    ["sdbmethods", { methods: { "x:y": { effect: 60 } } }],
  ] as const
) {
  Deno.test(
    `in-process dev boot holds reduce to one frame (perfBudget: ${
      JSON.stringify(perfBudget)
    })`,
    async () => {
      const c = cell(name, {
        state: { n: 0 },
        methods: {
          slow(s) {
            burn(40);
            s.n++;
          },
        },
      });
      const out = await said(async () => {
        const h = await bootCells([c], { perfBudget });
        try {
          // deno-lint-ignore no-explicit-any
          await (c as any).slow();
          await h.settle();
        } finally {
          h.dispose();
        }
      });
      assert(/reduce exceeded budget: [\d.]+ms > 16ms/.test(out), out);
    },
  );
}
