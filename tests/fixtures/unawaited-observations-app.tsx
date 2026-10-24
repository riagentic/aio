// A test MODULE run as a child by tests/harness-unawaited-observation.test.ts:
// each block makes one mistake a new developer makes, and the parent reads
// which test failed, with what. Not a `*.test.*` file, so the suite does not
// run it directly.
import { assertEquals } from "@std/assert";
import { cell } from "../../src/state/cell.ts";
import { testCell } from "../../src/testing/cell-test.ts";
import { testUI } from "../../src/testing/ui-test.ts";

const tally = cell("unawaitedtally", {
  state: { n: 0 },
  methods: {
    inc(s) {
      s.n++;
    },
  },
});

function App() {
  return (
    <main>
      <span>{tally.n}</span>
      <button type="button" t="bump" onClick={() => tally.inc()}>+</button>
    </main>
  );
}

// `ui.expectCell` without `await`: must fail THIS test, not a later one.
testUI(App, "ui-unawaited-expect", (ui) => {
  ui.bump.click();
  ui.expectCell(tally, (s) => s.n === 5);
});

testUI(App, "ui-next-is-clean", async (ui) => {
  ui.bump.click();
  await ui.expectCell(tally, (s) => s.n === 1);
});

// A plain read right after a queued click: the failure says the click had
// not run yet.
testUI(App, "ui-read-before-queue", (ui) => {
  ui.bump.click();
  assertEquals(tally.n, 1);
});

// `t.expect.rejects` without `await`, on a call that does NOT refuse.
testCell(tally, "cell-unawaited-rejects", (t) => {
  t.expect.rejects(() => t.send.inc(), /never/);
});

testCell(tally, "cell-next-is-clean", async (t) => {
  await t.send.inc();
  t.expect.state((s) => s.n === 1);
});
