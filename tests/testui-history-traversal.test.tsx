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

// happy-dom 20.14.5 queues a `hashchange` for every URL write that moves the
// fragment — `pushState`/`replaceState` included, for which a browser fires
// none. Measured raw: `pushState(null, "", "/b#x")` → one `hashchange`. A
// router that pushes `/list#top` heard its own navigation back as an event.
testUI(
  App,
  "pushState/replaceState never fire hashchange; a real fragment change still does",
  async (ui) => {
    const w = ui.window;
    const seen: string[] = [];
    w.addEventListener(
      "hashchange",
      (e: Event) => {
        const h = e as Event & { oldURL: string; newURL: string };
        seen.push(`${new URL(h.oldURL).hash}>${new URL(h.newURL).hash}`);
      },
    );
    g.history.pushState(null, "", "/h#x");
    g.history.replaceState(null, "", "/h#y");
    g.history.replaceState(null, "", "/h");
    await ui.settle();
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(seen, [], "the History API fires no hashchange");

    // The same pair again, this time from the address itself: it arrives —
    // and the one `pushState` owes right after it is still dropped.
    g.location.hash = "x";
    g.history.pushState(null, "", "/h#z");
    await ui.settle();
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(seen, [">#x"]);

    // A traversal across a fragment: exactly one, the browser's.
    g.history.pushState(null, "", "/k");
    g.history.pushState(null, "", "/k#q");
    g.history.back();
    await ui.settle();
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(seen, [">#x", "#q>"]);
  },
);

// A fragment navigation made OUTSIDE the History API — `location.hash = …`,
// a click on `<a href="#a">` (which `<Link>` leaves to the browser) — is a
// new session-history entry with no state. The shim kept its own entry list
// and never heard of it, so `back()` skipped the entry the app was on and
// went one too far.
testUI(
  App,
  "location.hash = … is a history entry: back() lands on the pushState before it",
  async (ui) => {
    const w = ui.window;
    const events: string[] = [];
    w.addEventListener(
      "popstate",
      () => events.push("popstate:" + g.location.pathname + g.location.hash),
    );
    w.addEventListener("hashchange", (e: Event) => {
      const h = e as Event & { oldURL: string; newURL: string };
      events.push(
        `hashchange:${new URL(h.oldURL).hash}>${new URL(h.newURL).hash}`,
      );
    });
    const tick = async () => {
      await ui.settle();
      await new Promise((r) => setTimeout(r, 0));
    };
    g.history.pushState({ n: 0 }, "", "/o");
    g.history.pushState({ n: 1 }, "", "/p");
    const base = g.history.length;
    g.location.hash = "#a";
    assertEquals(g.history.length, base + 1);
    assertEquals(g.history.state, null, "a fragment entry carries no state");
    g.location.hash = "#a"; // the same fragment: no navigation, no entry
    assertEquals(g.history.length, base + 1);
    await tick();
    assertEquals(events, ["hashchange:>#a"]);

    g.history.back();
    await tick();
    assertEquals(g.location.pathname + g.location.hash, "/p");
    assertEquals(g.history.state, { n: 1 });
    assertEquals(events, ["hashchange:>#a", "popstate:/p", "hashchange:#a>"]);

    g.history.forward();
    await tick();
    assertEquals(g.location.pathname + g.location.hash, "/p#a");
    assertEquals(g.history.state, null);

    // A fragment navigation after a back truncates the forward entries.
    g.history.back();
    await tick();
    g.location.hash = "#b";
    assertEquals(g.history.length, base + 1);
    g.history.go(-2);
    await tick();
    assertEquals(g.location.pathname + g.location.hash, "/o");
    assertEquals(g.history.state, { n: 0 });
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
