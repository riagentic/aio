// Three small things the kit got wrong, each visible to a user.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { renderToString } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { _resetModalStack, Modal, Table } from "../src/ui/mod.ts";
import { Progress } from "../src/ui/controls.ts";

// ── Escape closes the TOP modal, not every modal ─────────────────────────
//
// Every open modal added its OWN document keydown listener, so one Escape ran
// all of them: a confirm dialog opened over a settings dialog took both away
// with one key, and the user landed two screens back from where they meant to
// be. A browser's own `<dialog>` closes the top of the stack.
Deno.test("Modal: one Escape closes only the innermost dialog", async () => {
  _resetModalStack();
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);

  const outer = signal(true);
  const inner = signal(true);
  const App = () =>
    h("div", null, [
      h(Modal as never, {
        open: outer.value,
        title: "Settings",
        onClose: () => outer.set(false),
        children: "outer body",
      }),
      h(Modal as never, {
        open: inner.value,
        title: "Really?",
        onClose: () => inner.set(false),
        children: "inner body",
      }),
    ]);

  const handle = mount(root, App as never);
  try {
    assertEquals(
      root.querySelectorAll('[role="dialog"]').length,
      2,
      "both dialogs are open",
    );
    doc.dispatchEvent(
      // deno-lint-ignore no-explicit-any
      new (win as any).KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();

    assertEquals(inner.peek(), false, "the innermost dialog closed");
    assertEquals(
      outer.peek(),
      true,
      "…and the one behind it did NOT — one key, one dialog",
    );
    assertEquals(root.querySelectorAll('[role="dialog"]').length, 1);

    // A second Escape now takes the one that is left.
    doc.dispatchEvent(
      // deno-lint-ignore no-explicit-any
      new (win as any).KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    assertEquals(outer.peek(), false, "a second Escape closes the next one");
  } finally {
    _unmount(handle);
    _resetModalStack();
    _setDocument(null as never);
    await closeWindow(win);
  }
});

// ── the number beside the bar agrees with the bar ────────────────────────
//
// `<progress>` clamps a value outside [0, max] — that is what the element
// does. The text beside it did not: `value=150 max=100` drew a full bar and
// printed "150%", and a negative value printed "-20%" beside an empty one.
Deno.test("Progress: the label never contradicts the bar", () => {
  const pct = (value: number, max = 100) =>
    renderToString(
      h(Progress as never, {
        value,
        max,
        showValue: true,
        label: "p",
      }) as never,
    );
  assertStringIncludes(pct(150), ">100%<");
  assertStringIncludes(pct(-20), ">0%<");
  assertStringIncludes(pct(42), ">42%<");
  assertStringIncludes(pct(5, 10), ">50%<");
});

// ── an empty table still has a cell ──────────────────────────────────────
//
// `colspan="0"` is not a valid span: the attribute's minimum is 1, and
// browsers disagree about what 0 means. A Table with no columns declared is
// exactly the shape whose empty state matters most.
Deno.test("Table: the empty row spans at least one column", () => {
  const html = renderToString(
    h(Table as never, { columns: [], rows: [] }) as never,
  );
  assert(
    !/colspan="0"/i.test(html),
    `colspan="0" is not a valid span: ${html}`,
  );
  assertStringIncludes(html, "No rows");

  const withCols = renderToString(
    h(Table as never, {
      columns: [{ key: "a", header: "A" }, { key: "b", header: "B" }],
      rows: [],
    }) as never,
  );
  // Case-insensitive on purpose: SSR emits the prop's own spelling, and an
  // HTML parser lowercases attribute names, so `colSpan="2"` and `colspan="2"`
  // reach the DOM as the same attribute. Verified against a real parse.
  assert(
    /colspan="2"/i.test(withCols),
    `the empty row spans both declared columns: ${withCols}`,
  );
});
