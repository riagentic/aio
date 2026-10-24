// Opening a `<Menu>` moves focus INTO it — on the renderer's own schedule.
//
// `openWith` queued `focusItem` as a microtask from inside the handler. The
// handler's signal writes are batched, so the render's flush is queued only
// after the handler returns — AFTER that microtask. The focus call ran
// against a list that did not exist yet, and opening by click, Enter or
// ArrowDown left focus on the trigger: the arrow keys then did nothing, and
// the menu's own keyboard contract ("open focuses the first item") was dead.
// `tests/ui-controls.test.ts` flushes by hand, which is why it never showed.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Menu } from "../src/ui/mod.ts";

const settle = () => new Promise((r) => setTimeout(r, 0));

async function withMenu(
  body: (trigger: HTMLElement, doc: Document, win: Window) => Promise<void>,
) {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const m = mount(root, () =>
    h(Menu, {
      trigger: "Actions",
      items: [{ id: "a", label: "A" }, { id: "b", label: "B" }, {
        id: "c",
        label: "C",
        disabled: true,
      }],
    }));
  try {
    await body(root.querySelector(".aio-menu__trigger")!, doc, win);
  } finally {
    _unmount(m);
    await closeWindow(win);
  }
}

const keydown = (win: Window, el: Element, key: string) =>
  el.dispatchEvent(
    new win.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }) as unknown as Event,
  );

Deno.test("Menu: a click opens it with focus on the first item", () =>
  withMenu(async (trigger, doc) => {
    trigger.focus();
    trigger.click();
    await settle();
    assertEquals(doc.activeElement?.textContent, "A");
  }));

Deno.test("Menu: ArrowDown opens on the first item, ArrowUp on the last enabled", () =>
  withMenu(async (trigger, doc, win) => {
    trigger.focus();
    keydown(win, trigger, "ArrowDown");
    await settle();
    assertEquals(doc.activeElement?.textContent, "A");
    keydown(win, doc.activeElement!, "Escape");
    await settle();
    assertEquals(doc.activeElement, trigger);
    keydown(win, trigger, "ArrowUp");
    await settle();
    assertEquals(doc.activeElement?.textContent, "B");
  }));
