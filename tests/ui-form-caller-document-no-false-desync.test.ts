// A `<form>` among siblings must not report a false desync when `testUI` is
// handed the caller's OWN document — report 9b §4.
//
// happy-dom 17.6.3 answers `form.nextSibling === null` for a form that has
// siblings, and AIR's positional cursor walks siblings. `testUI` repaired that
// on the window it creates, and `testComponent` repaired the caller's document,
// but `testUI(App, { document })` did neither: the report's shape — `<main>`
// holding an h1, a form, a p and a button, re-rendered twice — printed
// `<main> inside <App> ran out of DOM nodes at child 2 after diff` on a DOM that
// was correct.
//
// ALONE in its own file on purpose, like `ui-form-no-false-desync.test.ts`:
// happy-dom shares element prototypes between windows, so any other test that
// builds a `testUI` window first repairs this one too, and the gate would pass
// with or without the fix.
import { assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { closeWindow } from "../src/testing/close-window.ts";

const left = signal(1495);

const App = () =>
  h("main", null, [
    h("h1", null, [String(left.value)]),
    h("form", null, [h("input", { "aria-label": "task" })]),
    h("p", null, [`${left.value} left`]),
    h("button", { type: "button" }, ["go"]),
  ]);

// Module scope: `testUI` owns the lifecycle, and a real warning must still be
// visible in the run's output, so this forwards.
const WARNS: string[] = [];
const _origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  WARNS.push(a.map(String).join(" "));
  _origWarn(...a);
};

Deno.test("testUI({ document }): a <form> among siblings does not report a false desync", async () => {
  const spec = "happy-dom";
  const hd = await import(spec);
  const win = new hd.Window({ url: "http://localhost/" });
  try {
    const ui = await testUI(App as never, { document: win.document });
    try {
      await ui.settle();
      const before = WARNS.length;
      // The tripwire only fires on a DIFF, so the first render proves nothing.
      left.set(1496);
      await ui.settle();
      left.set(1497);
      await ui.settle();
      const desync = WARNS.slice(before).filter((w) => /desync/.test(w));
      assertEquals(
        desync,
        [],
        "AIR's cursor must step past the <form> on the caller's document",
      );
      assertEquals(
        ui.html(),
        '<main><h1>1497</h1><form><input aria-label="task"></form>' +
          '<p>1497 left</p><button type="button">go</button></main>',
      );
    } finally {
      await ui.dispose();
    }
  } finally {
    await closeWindow(win);
  }
});
