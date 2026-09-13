/** @jsxImportSource aio */
// A fragment whose first child re-rendered ON ITS OWN is still diffed from
// where it really starts.
//
// A container's `_dom` is refreshed only when the container is diffed. A
// component that hands its children through unchanged (`<Outlet>` does exactly
// that) re-renders beside children that ALSO re-render themselves, and when
// the first child's node is replaced first (`null` placeholder → `<p>`), the
// fragment still points at the detached node. Its start anchor then came out
// null — "the region starts at the parent's first child" — so the fragment was
// diffed from the `<h1>` BEFORE it. Measured before the fix, on the shape
// below:
//
//   a  <h1>t</h1><p class="a">A</p>a<!---->b<i>x</i><footer>f</footer>
//      (want <h1>t</h1><p class="a">A</p><!---->a<i>x</i><footer>f</footer>)
//
// a stray text node per toggle, plus "A text child was diffed against a <P>"
// and "<Component> inside <Out> holds the wrong node at child 0". On the docs'
// own nested-route example (index + `:id` inside `<Outlet>`) the DOM happened
// to survive and only the tripwire fired — telling the author to file a bug.
import { assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { Fragment, h } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";
import { navigate, Outlet, Route } from "../src/air.ts";

// Collected at module scope: `testUI` registers its OWN `Deno.test`. It
// forwards, so a real warning is still visible in the run's output.
const WARNS: string[] = [];
const _origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  WARNS.push(a.map(String).join(" "));
  _origWarn(...a);
};
const reconcilerWarnings = (from: number) =>
  WARNS.slice(from).filter((w) =>
    /desync|diffed against|without its DOM position/.test(w)
  );

const which = signal("a");
function A() {
  return which.value === "a" ? <p class="a">A</p> : null;
}
function B() {
  return which.value === "b" ? <p class="b">B</p> : null;
}
function Out({ children }: { children?: unknown[] }) {
  const w = which.value;
  return h(
    Fragment,
    null,
    ...(children as never[]),
    w,
    w === "a" ? h("i", null, "x") : null,
  );
}
function Toggle() {
  return (
    <section>
      <h1>t</h1>
      <Out>
        <A />
        <B />
      </Out>
      <footer>f</footer>
    </section>
  );
}

const html = (sel: string) =>
  (globalThis as { document?: Document }).document!.querySelector(sel)!
    .innerHTML.replace(/ data-component="[^"]*"/g, "");

testUI(
  Toggle as never,
  "fragment: children re-rendered on their own do not move the region start",
  async (ui) => {
    const before = WARNS.length;
    await ui.settle();
    const want = {
      a: '<h1>t</h1><p class="a">A</p><!---->a<i>x</i><footer>f</footer>',
      b: '<h1>t</h1><!----><p class="b">B</p>b<!----><footer>f</footer>',
    };
    for (const v of ["b", "a", "b", "a", "b"] as const) {
      which.set(v);
      await ui.settle();
      assertEquals(html("section"), want[v], `after → ${v}`);
    }
    assertEquals(reconcilerWarnings(before), []);
  },
);

const tick = signal(0);
function Index() {
  return <p class="idx">index {tick.value}</p>;
}
function User() {
  return <p class="user">user {tick.value}</p>;
}
function Layout() {
  return (
    <section>
      <h1>Users</h1>
      <Outlet />
      <footer>f</footer>
    </section>
  );
}
function Routed() {
  return (
    <main>
      <Route path="/users" element={<Layout />}>
        <Route index element={<Index />} />
        <Route path=":id" element={<User />} />
      </Route>
    </main>
  );
}

testUI(
  Routed as never,
  "nested routes: index ⇄ :id inside <Outlet> report no desync",
  async (ui) => {
    const before = WARNS.length;
    const steps: Array<[() => void, string]> = [
      [() => navigate("/users"), "index 0"],
      [() => tick.set(1), "index 1"],
      [() => navigate("/users/42"), "user 1"],
      [() => tick.set(2), "user 2"],
      [() => navigate("/users"), "index 2"],
      [() => navigate("/users/9"), "user 2"],
    ];
    for (const [act, text] of steps) {
      act();
      await ui.settle();
      const s = html("section");
      assertEquals(
        s.replace(/<!---->/g, ""),
        `<h1>Users</h1><p class="${
          text.startsWith("index") ? "idx" : "user"
        }">${text}</p><footer>f</footer>`,
      );
    }
    assertEquals(reconcilerWarnings(before), []);
  },
);
