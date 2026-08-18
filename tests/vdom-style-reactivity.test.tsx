// Cell-driven style objects must track state like sibling text (RIS-9).
//
// A wallet's field report (alpha59) hit a style object that froze at mount
// while sibling text kept updating, and worked around it with a class binding.
// Neither its shape (`style={{ width: cell.pct }}`) nor the ternary variant
// reproduces on alpha61 — this file is the pin that keeps it that way, because
// the _static vnode optimisation is exactly the machinery that once shipped
// the freeze class (RIS-3.3), and "a primitive that came from reactive state"
// is invisible to a static-props heuristic by construction.
import { assertEquals } from "@std/assert";
import { cell } from "aio";
import { testUI } from "aio/testing";

const ui2 = cell("ris9b", {
  state: { on: false },
  methods: {
    flip(s) {
      s.on = !s.on;
    },
  },
});

function App() {
  return (
    <div>
      {/* the reported shape: a ternary spread into the style object */}
      <div
        t="box"
        style={{ ...(ui2.on ? { color: "red" } : { color: "blue" }) }}
      >
        static child
      </div>
      <div t="box2" style={ui2.on ? { color: "red" } : { color: "blue" }}>
        static child
      </div>
    </div>
  );
}

testUI(App, "ternary style objects follow cell state", async (ui) => {
  const el = (n: string) => (ui[n].info._el as unknown as HTMLElement).style;
  assertEquals(el("box").color, "blue");
  assertEquals(el("box2").color, "blue");
  await ui2.flip();
  await ui.settle();
  assertEquals(el("box").color, "red", "spread ternary");
  assertEquals(el("box2").color, "red", "direct ternary");
});

const bar = cell("ris9a", {
  state: { pct: 10, label: "a" },
  methods: {
    grow(s) {
      s.pct = 90;
      s.label = "b";
    },
  },
});

function Meter() {
  return (
    <div>
      <div t="meter" style={{ width: `${bar.pct}px`, height: "4px" }}>x</div>
      <span t="lab">{bar.label}</span>
    </div>
  );
}

testUI(
  Meter,
  "an interpolated style value updates with the cell",
  async (ui) => {
    const el = () => ui.meter.info._el as unknown as HTMLElement;
    assertEquals(el().style.width, "10px");
    await bar.grow();
    await ui.settle();
    assertEquals(ui.lab.text, "b");
    assertEquals(el().style.width, "90px");
  },
);
