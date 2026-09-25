// A `<select>` whose `value` prop goes away shows what a FRESH render of the
// new props shows — its `selected` option, else the first enabled one.
//
// The diff assigned `select.value = ""`, which matches no option: a
// single-select went BLANK, a state no fresh render of the same props ever
// produces, so the page and a reload of it disagreed about the choice.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _diff, _render, h } from "../src/air/vdom.ts";

Deno.test("removing a select's value prop restores the default selection a fresh render shows", async () => {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    const shapes = [
      () => [
        h("option", { value: "x", disabled: true }, "X"),
        h("option", { value: "y" }, "Y"),
        h("option", { value: "z" }, "Z"),
      ],
      () => [
        h("option", { value: "y" }, "Y"),
        h("option", { value: "z", selected: true }, "Z"),
      ],
    ];
    assertEquals(shapes.length, 2);
    for (const opts of shapes) {
      const host = doc.createElement("div");
      const a = h("select", { value: "y" }, ...opts());
      _render(host, a, null, { doc });
      _diff(host, h("select", null, ...opts()), a, { doc });
      const fresh = doc.createElement("div");
      _render(fresh, h("select", null, ...opts()), null, { doc });
      const inc = host.firstChild as HTMLSelectElement;
      const want = fresh.firstChild as HTMLSelectElement;
      assertEquals(inc.selectedIndex, want.selectedIndex);
      assertEquals(inc.value, want.value);
    }
  } finally {
    await closeWindow(win);
  }
});
