// testUI: Back/Forward is a same-document traversal, as in a browser.
//
// happy-dom 17.6.3 treats `history.back()` between two `pushState` entries as
// a whole-document navigation, refuses it on a detached `Window`, and falls
// back to rewriting `location`: the URL moved, no `popstate` fired, and
// `history.state` still answered the entry it left. A routed app's Back
// button therefore changed the address and left the old page on screen —
// and for an `aio/air` app without cells the router's `popstate` listener was
// never attached to the harness window at all (it attaches at import, before
// testUI creates one). Both are pinned here, against the browser contract.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { navigate, Route, routePath } from "../src/air.ts";

function A() {
  return <div class="page">a</div>;
}
function B() {
  return <div class="page">b</div>;
}
function App() {
  return (
    <div>
      <Route path="/a" element={<A />} />
      <Route path="/b" element={<B />} />
      <span class="where">{routePath.value}</span>
    </div>
  );
}
const pageOf = (html: string) =>
  html.match(/class="page"[^>]*>([^<]*)</)?.[1] ?? null;
// deno-lint-ignore no-explicit-any
const g = globalThis as any;

// `cells: []` boots no runtime at all — exactly where the listener went
// missing, since only the standalone boot re-attached it to a new window.
const NO_CELLS = { cells: [] };

testUI(
  App,
  "history.back() re-renders a routed aio/air app with no cells",
  NO_CELLS,
  async (ui) => {
    navigate("/a");
    await ui.settle();
    navigate("/b");
    await ui.settle();
    assertEquals(pageOf(ui.html()), "b");
    g.history.back();
    await ui.settle();
    assertEquals(g.location.pathname, "/a");
    assertEquals(pageOf(ui.html()), "a");
    g.history.forward();
    await ui.settle();
    assertEquals(pageOf(ui.html()), "b");
  },
);

testUI(
  App,
  "a second mount (a new window) still follows Back",
  NO_CELLS,
  async (ui) => {
    navigate("/a");
    await ui.settle();
    navigate("/b");
    await ui.settle();
    navigate(-1);
    await ui.settle();
    assertEquals(pageOf(ui.html()), "a");
  },
);

testUI(
  App,
  "traversal follows the browser contract: async, popstate+state, bounded, hashchange",
  async (ui) => {
    const w = ui.window;
    const events: string[] = [];
    const states: unknown[] = [];
    w.addEventListener("popstate", (e: Event) => {
      events.push("popstate:" + g.location.pathname + g.location.hash);
      states.push((e as Event & { state: unknown }).state);
    });
    w.addEventListener("hashchange", () => events.push("hashchange"));
    const base = g.history.length;
    g.history.pushState({ n: 1 }, "", "/a");
    g.history.pushState({ n: 2 }, "", "/b");
    assertEquals(g.history.length, base + 2);
    assertEquals(events, [], "pushState never fires popstate");

    g.history.back();
    // A traversal is a queued task: code right after back() still sees the old
    // entry, exactly as in a browser.
    assertEquals(g.location.pathname, "/b");
    await ui.settle();
    assertEquals(g.location.pathname, "/a");
    assertEquals(g.history.state, { n: 1 });
    assertEquals(states, [{ n: 1 }]);

    // Two queued steps apply in order, each relative to where the last landed.
    g.history.back();
    g.history.forward();
    await ui.settle();
    assertEquals(g.location.pathname, "/a");

    // Past either end: nothing happens, no event.
    const before = events.length;
    g.history.go(-(g.history.length + 5));
    await ui.settle();
    assertEquals(events.length, before);
    assertEquals(g.location.pathname, "/a");

    // A push after a back truncates the forward entries.
    g.history.pushState(null, "", "/c");
    assertEquals(g.history.length, base + 2);
    g.history.forward();
    await ui.settle();
    assertEquals(g.location.pathname, "/c");

    // Fragment-only traversal fires hashchange after popstate.
    g.history.pushState(null, "", "/c#x");
    events.length = 0;
    g.history.back();
    await ui.settle();
    assertEquals(events, ["popstate:/c", "hashchange"]);
    assert(!g.location.hash);
  },
);

const nav = cell("testui-history-traversal", {
  state: { n: 0 },
  methods: {
    inc(s: { n: number }) {
      s.n++;
    },
  },
});

testUI(
  App,
  "with cells (standalone runtime booted) Back still re-renders",
  async (ui) => {
    navigate("/a");
    await ui.settle();
    navigate("/b");
    await ui.settle();
    g.history.back();
    await ui.settle();
    assertEquals(pageOf(ui.html()), "a");
    await ui.expectCell(nav, (c) => c.n === 0);
  },
);
