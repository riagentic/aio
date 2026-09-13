// The kit's `<Select>` must behave like the `<select value={…}>` it wraps.
//
// `tests/vdom.test.ts` pins the raw control: choose an option, have the app
// REFUSE it (no state change), and the next render puts the control back where
// state says it is. That is what "controlled" means, and an app built on the
// kit has every right to expect it.
//
// `Select` set `selected` on each `<option>` and never passed `value` to the
// `<select>` at all. Setting `selected` on an option that is ALREADY the DOM's
// selection is a no-op, so a refused choice stayed on screen: the dropdown
// showed one thing and the app's state held another, with nothing to reconcile
// them. The renderer has the controlled-select machinery (it re-asserts the
// value after the options exist, and SSR marks the right option); the wrapper
// simply never handed it the value to assert.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { Select } from "../src/ui/mod.ts";

Deno.test("kit <Select>: a REFUSED choice is undone on the next render", async () => {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);

  const picked = signal("a");
  const tries = signal(0);
  const App = () =>
    h("div", null, [
      h(Select as never, {
        "aria-label": "s",
        value: picked.value,
        options: ["a", "b"],
        onChange: () => tries.set(tries.peek() + 1), // always refuse
      }),
      h("span", null, [`t:${tries.value}`]),
    ]);

  const handle = mount(root, App as never);
  try {
    const sel = root.querySelector("select") as HTMLSelectElement;
    assertEquals(sel.value, "a", "opens on the controlled value");

    sel.value = "b";
    sel.dispatchEvent(
      // deno-lint-ignore no-explicit-any
      new (win as any).Event("input", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();

    assertEquals(tries.peek(), 1, "the app heard the attempt");
    assertEquals(
      (root.querySelector("select") as HTMLSelectElement).value,
      "a",
      "and the control is back where STATE says it is — a refused choice " +
        "must not stay on screen",
    );
  } finally {
    _unmount(handle);
    _setDocument(null as never);
    await closeWindow(win);
  }
});

Deno.test("kit <Select>: a state change moves the control", async () => {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);

  const picked = signal("b");
  const App = () =>
    h(Select as never, {
      "aria-label": "s",
      value: picked.value,
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
    });

  const handle = mount(root, App as never);
  try {
    assertEquals(
      (root.querySelector("select") as HTMLSelectElement).value,
      "b",
      "the initial controlled value is NOT the browser's default first option",
    );
    picked.set("a");
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    assertEquals(
      (root.querySelector("select") as HTMLSelectElement).value,
      "a",
    );
  } finally {
    _unmount(handle);
    _setDocument(null as never);
    await closeWindow(win);
  }
});

// `selected` came off the options, so the SERVER render has to put it back —
// and it does, because `<select value>` is exactly what the SSR path reads
// (`ssrOpenSelect`/`ssrOptionProps`). Without this the change above would
// trade a client bug for a first-paint one, which is worse: the page would
// open on the wrong entry before any script ran.
Deno.test("kit <Select>: the SERVER marks the controlled option", async () => {
  const { renderToString } = await import("../src/air/vdom.ts");
  const html = renderToString(
    h(Select as never, {
      "aria-label": "s",
      value: "b",
      options: ["a", "b", "c"],
    }) as never,
  );
  const marked = [...html.matchAll(/<option[^>]*>/g)].map((m) => m[0]);
  assertEquals(marked.length, 3, `three options: ${html}`);
  assertEquals(
    marked.filter((t) => /\bselected\b/.test(t)).length,
    1,
    `exactly one option is marked selected: ${html}`,
  );
  assertEquals(
    /value="b"[^>]*\bselected\b|\bselected\b[^>]*value="b"/.test(marked[1]!),
    true,
    `and it is the one the value names: ${marked[1]}`,
  );
});
