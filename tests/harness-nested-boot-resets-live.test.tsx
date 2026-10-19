// A harness booted while an earlier one is still live RESETS the live one.
//
// The in-process harnesses run ONE runtime. A nested or overlapping `testUI`
// (or `bootCells`) re-boots every cell from its declared state, so the live
// harness's state goes back to initial, its onDestroy runs, its schedules and
// owned resources are dropped — and it does NOT get them back when the later
// harness closes. Found by mounting two testUIs side by side: the outer mount's
// `n` went 2 → 0 with nothing said, and the repo's own nested-mount tests only
// passed because their outer state was still 0. Until the runtime is
// per-instance, the reset is said, naming where the live harness was booted.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { bootCells } from "../src/testing/cell-test.ts";

type S = { n: number };
const c = cell("nested-live", {
  state: { n: 0 },
  methods: {
    inc(s: S) {
      s.n++;
    },
  },
});
const C = c as unknown as S & { inc(): Promise<void> };
const App = () => <div>{String(C.n)}</div>;
const Other = () => <span>other</span>;

const captureWarns = () => {
  const said: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => said.push(a.map(String).join(" "));
  return { said, restore: () => console.warn = real };
};

Deno.test("testUI nested in a live testUI: the reset of the live mount is said", async () => {
  await using ui = await testUI(App as never);
  await C.inc();
  await C.inc();
  await ui.settle();
  assertEquals(C.n, 2);
  const w = captureWarns();
  try {
    await using _inner = await testUI(Other as never);
  } finally {
    w.restore();
  }
  const hit = w.said.find((s) => s.includes("still live"));
  assert(hit, `no warning for the reset live mount:\n${w.said.join("\n")}`);
  assertStringIncludes(hit, "harness-nested-boot-resets-live.test.tsx");
  // The fact the warning states: the outer mount's state was reset.
  assertEquals(C.n, 0);
});

Deno.test("bootCells over a live bootCells: said; a sequential pair is not", async () => {
  const w = captureWarns();
  try {
    const a = await bootCells([c]);
    a.dispose();
    const b = await bootCells([c]);
    assertEquals(w.said.filter((s) => s.includes("still live")), []);
    const d = await bootCells([c]);
    d.dispose();
    b.dispose();
  } finally {
    w.restore();
  }
  assertEquals(w.said.filter((s) => s.includes("still live")).length, 1);
});
