// Modal: the Tab trap's edges are tab STOPS, not the ends of the focusable
// query. It wrapped only when focus was ON the query's last element, so a
// dialog ending in a RadioGroup (one stop: the checked radio — the query's last
// element is an unchecked one) or with an open Menu last (items are
// tabIndex=-1) let Tab walk out to the page; Shift+Tab had the mirror hole.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import type { VNode } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _resetModalStack, Menu, Modal } from "../src/ui/mod.ts";
import { RadioGroup } from "../src/ui/controls.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function run(
  app: () => VNode,
  body: (t: {
    doc: Any;
    root: Any;
    key: (el: Any, key: string, init?: Record<string, unknown>) => Any;
    settle: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  _resetModalStack();
  const win = new Window({ url: "http://localhost/" }) as Any;
  const doc = win.document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const handle = mount(root, app as never) as Any;
  const settle = async () => {
    handle._flush();
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
  };
  const key = (el: Any, k: string, init: Record<string, unknown> = {}) => {
    const e = new win.KeyboardEvent("keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    el.dispatchEvent(e);
    return e;
  };
  try {
    await settle();
    await body({ doc, root, key, settle });
  } finally {
    _unmount(handle);
    _resetModalStack();
    await closeWindow(win);
  }
}

const opts = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

Deno.test("Modal trap: a trailing RadioGroup's checked radio is the last stop — Tab wraps", async () => {
  await run(() =>
    h(Modal as never, {
      open: true,
      title: "Pick",
      onClose: () => {},
      children: h(
        "div",
        null,
        h("input", { id: "first", "aria-label": "First" }),
        h(RadioGroup as never, { name: "pick", value: "a", options: opts }),
      ),
    }), async ({ doc, root, key }) => {
    const checked = root.querySelector('input[value="a"]');
    checked.focus();
    const e = key(checked, "Tab");
    assert(e.defaultPrevented, "Tab off the dialog's last stop is taken");
    assertEquals(doc.activeElement?.id, "first", "…and wraps to the first");
  });
});

Deno.test("Modal trap: a leading RadioGroup's checked radio is the first stop — Shift+Tab wraps to the last", async () => {
  await run(() =>
    h(Modal as never, {
      open: true,
      title: "Pick",
      onClose: () => {},
      children: h(
        "div",
        null,
        h(RadioGroup as never, { name: "pick", value: "b", options: opts }),
        h("button", { id: "last" }, "Done"),
      ),
    }), async ({ doc, root, key }) => {
    const checked = root.querySelector('input[value="b"]');
    checked.focus();
    const e = key(checked, "Tab", { shiftKey: true });
    assert(e.defaultPrevented, "Shift+Tab off the first stop is taken");
    assertEquals(doc.activeElement?.id, "last");
    // Wrapping forward INTO a group lands on its checked radio.
    key(doc.activeElement, "Tab");
    assertEquals(doc.activeElement, checked, "Tab wraps to the checked radio");
  });
});

Deno.test("Modal trap: focus on an open Menu's item (tabIndex=-1) last in the dialog — Tab wraps", async () => {
  await run(() =>
    h(Modal as never, {
      open: true,
      title: "Actions",
      onClose: () => {},
      children: h(
        "div",
        null,
        h("input", { id: "first", "aria-label": "First" }),
        h(Menu as never, {
          trigger: "More",
          items: [{ id: "x", label: "Export" }, { id: "y", label: "Copy" }],
        }),
      ),
    }), async ({ doc, root, key, settle }) => {
    const trigger = root.querySelector(".aio-menu__trigger");
    trigger.focus();
    key(trigger, "ArrowDown");
    await settle();
    const item = doc.activeElement;
    assert(item && item !== trigger && root.contains(item), "an item focused");
    assertEquals(item.getAttribute("tabindex"), "-1");
    const e = key(item, "Tab");
    assert(e.defaultPrevented, "Tab from the menu item is taken");
    assertEquals(doc.activeElement?.id, "first");
  });
});

Deno.test("Modal trap: Tab in the middle — even inside a group — stays the browser's", async () => {
  await run(() =>
    h(Modal as never, {
      open: true,
      title: "Pick",
      onClose: () => {},
      children: h(
        "div",
        null,
        h("input", { id: "first", "aria-label": "First" }),
        h(RadioGroup as never, { name: "pick", value: "a", options: opts }),
        h("button", { id: "last" }, "Done"),
      ),
    }), async ({ root, key }) => {
    const checked = root.querySelector('input[value="a"]');
    checked.focus();
    assert(!key(checked, "Tab").defaultPrevented);
    assert(!key(checked, "Tab", { shiftKey: true }).defaultPrevented);
  });
});
