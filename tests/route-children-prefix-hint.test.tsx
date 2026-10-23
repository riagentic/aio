// `<Route path="/"><Home/></Route>` — a page written as children where
// `element=` belongs — is a layout PREFIX by the documented rule, so it
// rendered on every page with nothing said (a field report). Dev now names it
// once when it renders somewhere the element form would not have; the
// matching itself is unchanged, and real layouts stay quiet.
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { navigate, Outlet, Route } from "../src/air.ts";
import type { VChild } from "../src/air/vdom.ts";

function Home() {
  return <div class="page">home</div>;
}
function About() {
  return <div class="page">about</div>;
}
function Nested(): VChild {
  return <Route path="x" element={<About />} />;
}
function App() {
  return (
    <div>
      <Route path="/">
        <Home />
      </Route>
      <Route path="/about" element={<About />} />
      <Route path="/layout">
        <section>
          <Route path="a" element={<About />} />
        </section>
      </Route>
      <Route path="/sub" element={<Outlet />}>
        <Nested />
      </Route>
    </div>
  );
}

const NO_CELLS = { cells: [] };
const hints = (calls: unknown[][]) =>
  calls.map((a) => String(a[0])).filter((m) => m.includes("<Route path="));

testUI(
  App,
  "children with no <Route> warn once, matching unchanged",
  NO_CELLS,
  async (ui) => {
    const calls: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => calls.push(a);
    try {
      navigate("/");
      await ui.settle();
      assertEquals(
        hints(calls),
        [],
        "at its own path the element form matches too",
      );

      navigate("/about");
      await ui.settle();
      assert(ui.html().includes("home"), "the prefix match still renders");
      const said = hints(calls);
      assertEquals(said.length, 1, said.join("\n"));
      assert(said[0]!.includes("element={<Page/>}"), said[0]);
      assert(said[0]!.includes('"/about"'), said[0]);

      navigate("/layout/a");
      await ui.settle();
      navigate("/sub/x");
      await ui.settle();
      navigate("/about");
      await ui.settle();
      assertEquals(hints(calls).length, 1, "once, and layouts stay quiet");
    } finally {
      console.warn = orig;
    }
  },
);
