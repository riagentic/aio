// a field report #5 — "testUI does not drain nested async dispatch".
//
// `ui.up.click()` → cell `up()` → `await files.open(parent)` (a nested
// dispatch) left the UI showing the OLD directory after settle(): the harness
// drained the outer call, went HTML-quiet in the gap, and called it settled.
// settle() now awaits the pending method calls themselves (bounded by the
// iteration budget, so a deliberately long-running stream still cannot wedge
// it).
import { assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";

type Nav = { dir: string; entries: string[] };

const fs = cell("nested-fs", {
  state: { dir: "/home/u/docs", entries: ["a.txt"] } as Nav,
  methods: {
    async open(s: Nav, dir: string) {
      // Async on purpose: the nested call must actually be IN FLIGHT when the
      // outer one returns, or the test would pass on the old harness too.
      await new Promise((r) => setTimeout(r, 60));
      s.dir = dir;
      s.entries = dir === "/home/u" ? ["docs/", "pics/"] : ["a.txt"];
    },
  },
});

const nav = cell("nested-nav", {
  state: { ups: 0 },
  methods: {
    up(s: { ups: number }) {
      s.ups += 1;
      const parent = fs.dir.split("/").slice(0, -1).join("/") || "/";
      // Fire-and-forget on purpose: an AWAITED nested call is covered by the
      // outer call's own completion — the gap is a dispatch the outer method
      // set in motion but did not await. settle() must still drain it.
      void fs.open(parent);
    },
  },
});

function App() {
  void nav.ups;
  return (
    <div>
      <div class="path">{fs.dir}</div>
      <button t="up" onClick={() => nav.up()}>Up</button>
    </div>
  );
}

testUI(App, "settle drains a nested async dispatch", async (ui) => {
  assertStringIncludes(ui.html(), "/home/u/docs");
  ui.up.click();
  await ui.settle();
  // Before the fix this still read "/home/u/docs" — the outer `up()` had
  // returned, the inner `open()` had not landed, and HTML quiescence in that
  // gap counted as settled.
  assertStringIncludes(ui.html(), 'class="path">/home/u<');
});
