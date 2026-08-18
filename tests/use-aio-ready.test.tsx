// `useAio().ready` — has a full state frame landed yet?
//
// Before it has, every slice reads `undefined`, and every app wrote the same
// guard against that window by picking one arbitrary slice to stand in for it
// (`if (!state.core) return <Loading/>`) — a gate that breaks the day that
// slice legitimately empties. The runtime knows the answer; this is it.
import { assertEquals } from "@std/assert";
import { cell } from "aio";
import { useAio } from "aio/air";
import { testUI } from "aio/testing";

const app = cell("ready-probe", {
  state: { n: 1 },
  methods: {
    bump(s) {
      s.n++;
    },
  },
});

function App() {
  const { ready, state } = useAio<{ "ready-probe": { n: number } }>();
  if (!ready) return <div t="gate">loading</div>;
  return <div t="gate">n={String(state["ready-probe"]?.n)}</div>;
}

testUI(
  App,
  "ready is true once state has arrived — including locally",
  (ui) => {
    // The standalone runtime testUI/bootCells use publishes a full frame at
    // boot, so a component gating on `ready` must not sit on a spinner in every
    // UI test. A readiness flag that is only ever true against a real server
    // would be worse than none.
    assertEquals(ui.gate.text, "n=1");
  },
);

testUI(App, "ready stays true across dispatches", async (ui) => {
  await ui.expectCell(app, (s: { n: number }) => s.n === 1);
  app.bump();
  await ui.settle();
  assertEquals(ui.gate.text, "n=2");
});
