// A component with a `<form>` must not report a false reconciler desync.
//
// This lives ALONE in its own file on purpose. happy-dom shares element
// prototypes between windows, so the moment any other test repairs them the
// process is repaired — and a test that shares a file with the unit test for
// the repair passes whether or not `testUI` wires it up. Measured: it did.
// The only honest gate is one whose file touches nothing but `testUI`.
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";

// The shape aio's own `examples/todo` has: static siblings around a form, with
// a trailing slot that changes node count. MEASURED before the repair:
// `<main> inside <App> ran out of DOM nodes at child 2 after diff — the child
// reconciler desynced`, signed off with "this is an aio bug; please report" —
// on a DOM that was in fact correct. The cause was `form.nextSibling` being
// `null` in happy-dom 17.6.3, which stops AIR's positional cursor dead.
const shown = signal(false);

const FormPage = () =>
  h("main", null, [
    h("h1", null, ["todos"]),
    h("form", { class: "row" }, [
      h("input", { placeholder: "what?", "aria-label": "what" }),
    ]),
    h("ul", null, []),
    // The trailing slot whose node count changes — `{cond && <div/>}`, the
    // most ordinary line in JSX, and the one the false warning blamed.
    shown.value ? h("div", { class: "footer" }, ["1 left"]) : null,
  ]);

// Collected at module scope: `testUI` registers its OWN `Deno.test`, so there
// is no enclosing body to install a capture in. It forwards, so a real warning
// is still visible in the run's output.
const WARNS: string[] = [];
const _origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  WARNS.push(a.map(String).join(" "));
  _origWarn(...a);
};

testUI(
  FormPage as never,
  "a <form> does not report a false desync",
  async (ui) => {
    const before = WARNS.length;
    await ui.settle();
    // The warning only fires on a DIFF, so the first render proves nothing.
    shown.set(true);
    await ui.settle();
    shown.set(false);
    await ui.settle();
    const desync = WARNS.slice(before).filter((w) => /desync/.test(w));
    assertEquals(
      desync.length,
      0,
      "AIR's positional cursor must step over a <form> — it reported:\n" +
        desync.join("\n"),
    );
    assert(
      ui.html().includes("<form") && ui.html().includes("todos"),
      `and the page still rendered its form: ${ui.html().slice(0, 200)}`,
    );
  },
);
