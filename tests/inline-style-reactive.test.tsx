import { assert } from "@std/assert";
import { cell } from "../mod.ts";
import {
  _resetCellRegistry,
  bindCellReactive,
} from "../src/state/cell-reactive.ts";
import { _resetSignals, getCellSignal } from "../src/state/state-signals.ts";
import { testUI } from "../src/cell-test.ts";
import { bindCell } from "../mod.ts";

// A cell-dependent inline `style={{}}` is REACTIVE — on both read paths.
//
// History worth keeping: it genuinely froze at mount once, and the warning
// outlived the fix. The stale advice ("convert it to a class") cost a real app
// repeated debugging sessions (risoto, 2026-07-26), so the behavior is pinned
// here on both paths instead of described in prose.
const bx = cell("bx", {
  state: { w: 10 },
  methods: {
    noop(s: { w: number }) {
      s.w = s.w;
    },
  },
});

function App() {
  return (
    <div t="styled" style={{ width: bx.w + "px" }} class={"w" + bx.w}>x</div>
  );
}

Deno.test("browser binding: inline style follows a signal-backed cell read", async () => {
  _resetCellRegistry();
  _resetSignals();
  bindCellReactive(bx);
  await using ui = await testUI(App);
  const before = ui.html();
  getCellSignal("bx").set({ w: 77 });
  await ui.settle();
  const after = ui.html();
  console.log("BEFORE:", before.slice(0, 160));
  console.log("AFTER :", after.slice(0, 160));
  assert(after.includes("77px"), `style did not follow the cell: ${after}`);
});

// The other path: state-store binding (what testUI/server rendering use).
const sx = cell("sx", {
  state: { w: 10 },
  methods: {
    grow(s: { w: number }) {
      s.w = 42;
    },
  },
});

Deno.test("store binding: inline style follows a cell read", async () => {
  let state: Record<string, unknown> = { sx: { w: 10 } };
  bindCell(
    sx,
    (a) => {
      if (a.type === "sx:grow") state = { sx: { w: 42 } };
      return Promise.resolve();
    },
    () => state,
  );
  await using ui = await testUI(() => <div style={{ width: sx.w + "px" }} />);
  assert(ui.html().includes("10px"), ui.html());
});

// ── Semantic markers never reach the DOM (either renderer) ──

Deno.test("the `t` marker is not a DOM attribute — SSR and client agree", async () => {
  const { renderToString } = await import("../src/air/vdom-ssr.ts");
  const html = renderToString(<button t="save" class="btn">Save</button>);
  assert(!html.includes('t="save"'), `SSR leaked the marker: ${html}`);
  assert(html.includes('class="btn"'), `real attributes still render: ${html}`);

  // …and the client renderer agrees, so a DOM-probing tool sees the same thing
  // before and after hydration.
  await using ui = await testUI(() => (
    <button t="save" class="btn">
      Save
    </button>
  ));
  const dom = ui.html();
  assert(!dom.includes('t="save"'), `client DOM leaked the marker: ${dom}`);
  assert(dom.includes('class="btn"'), dom);
});
