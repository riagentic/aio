// Modal: which dialog Escape belongs to, and where focus goes.
//
// The Escape stack was MOUNT order, so a dialog opened over another one that
// happened to mount first sat below it; a non-dismissable dialog on top was
// skipped, so Escape closed the dialog BEHIND "Saving…"; and the handler ignored
// `defaultPrevented` and `isComposing`. Focus was never managed at all, though
// the docs said it "comes for free": opening left focus on the page behind,
// Tab walked out of the dialog, closing dropped focus on <body>.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import type { VNode } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { _resetModalStack, ConfirmButton, Modal } from "../src/ui/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function setup() {
  _resetModalStack();
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as Any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win: win as Any, doc, root };
}

async function run(
  app: () => VNode,
  body: (t: {
    doc: Any;
    root: Any;
    key: (el: Any, key: string, init?: Record<string, unknown>) => Any;
    settle: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const { win, doc, root } = setup();
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

Deno.test("Modal stack: Escape closes the most recently OPENED dialog, not the last mounted", async () => {
  const confirm = signal(false), settings = signal(false);
  await run(() =>
    h(
      "div",
      null,
      h(Modal as never, {
        open: confirm.value,
        title: "Really delete?",
        onClose: () => confirm.set(false),
        children: "c",
      }),
      h(Modal as never, {
        open: settings.value,
        title: "Settings",
        onClose: () => settings.set(false),
        children: "s",
      }),
    ), async ({ doc, key, settle }) => {
    settings.set(true);
    await settle();
    confirm.set(true); // mounted FIRST, opened LAST → on top
    await settle();
    key(doc, "Escape");
    await settle();
    assertEquals(confirm.peek(), false, "the dialog opened last closed");
    assertEquals(settings.peek(), true, "the one behind it stayed");
  });
});

Deno.test("Modal stack: a non-dismissable top dialog BLOCKS Escape", async () => {
  const editor = signal(true), saving = signal(false);
  await run(() =>
    h(
      "div",
      null,
      h(Modal as never, {
        open: editor.value,
        title: "Editor",
        onClose: () => editor.set(false),
        children: "e",
      }),
      h(Modal as never, {
        open: saving.value,
        title: "Saving",
        dismissable: false,
        onClose: () => saving.set(false),
        children: "wait",
      }),
    ), async ({ doc, key, settle }) => {
    saving.set(true);
    await settle();
    key(doc, "Escape");
    await settle();
    assertEquals(saving.peek(), true, "non-dismissable stays");
    assertEquals(editor.peek(), true, "…and Escape did not reach the editor");
  });
});

Deno.test("Modal: Escape already handled (defaultPrevented) or mid-IME does not close", async () => {
  const open = signal(true);
  await run(() =>
    h(Modal as never, {
      open: open.value,
      title: "T",
      onClose: () => open.set(false),
      children: h("input", { id: "name", "aria-label": "Name" }),
    }), async ({ root, key, settle }) => {
    const input = root.querySelector("#name");
    key(input, "Escape", { isComposing: true });
    await settle();
    assertEquals(open.peek(), true, "Escape during composition is the IME's");
    input.addEventListener("keydown", (e: Any) => e.preventDefault(), {
      once: true,
    });
    key(input, "Escape");
    await settle();
    assertEquals(open.peek(), true, "a handled Escape is not the dialog's");
    key(input, "Escape");
    await settle();
    assertEquals(open.peek(), false, "a plain Escape still closes");
  });
});

Deno.test("Modal focus: moves in on open, Tab wraps inside, returns to the opener on close", async () => {
  const open = signal(false);
  await run(() =>
    h(
      "div",
      null,
      h("button", { id: "open-btn", onClick: () => open.set(true) }, "Open"),
      h("button", { id: "behind" }, "Behind"),
      h(Modal as never, {
        open: open.value,
        title: "Dialog",
        onClose: () => open.set(false),
        children: h(
          "div",
          null,
          h("input", { id: "first", "aria-label": "First" }),
          h("button", { id: "skip", tabIndex: -1 }, "Not tabbable"),
          h("button", { id: "last" }, "Last"),
        ),
      }),
    ), async ({ doc, root, key, settle }) => {
    const opener = root.querySelector("#open-btn");
    opener.focus();
    opener.click();
    await settle();
    assert(root.querySelector('[role="dialog"]'), "dialog open");
    assertEquals(doc.activeElement?.id, "first", "focus moved into the dialog");

    root.querySelector("#last").focus();
    let e = key(doc.activeElement, "Tab");
    assert(e.defaultPrevented, "Tab on the last element is taken");
    assertEquals(doc.activeElement?.id, "first", "…and wraps to the first");
    e = key(doc.activeElement, "Tab", { shiftKey: true });
    assert(e.defaultPrevented);
    assertEquals(doc.activeElement?.id, "last", "Shift+Tab wraps backwards");
    e = key(doc.activeElement, "Tab", { shiftKey: true });
    assert(!e.defaultPrevented, "Tab in the middle is the browser's");

    // Focus that escaped the dialog is pulled back in on the next Tab.
    root.querySelector("#behind").focus();
    key(doc.activeElement, "Tab");
    assertEquals(doc.activeElement?.id, "first");

    key(doc.activeElement, "Escape");
    await settle();
    assertEquals(root.querySelector('[role="dialog"]'), null, "closed");
    assertEquals(doc.activeElement?.id, "open-btn", "focus went back");
  });
});

Deno.test("Modal focus: a dialog with nothing focusable focuses itself", async () => {
  const open = signal(false);
  await run(() =>
    h(Modal as never, {
      open: open.value,
      title: "Info",
      children: "Just text",
    }), async ({ doc, root, key, settle }) => {
    open.set(true);
    await settle();
    const box = root.querySelector('[role="dialog"]');
    assertEquals(doc.activeElement, box);
    assertEquals(box.getAttribute("tabindex"), "-1");
    const e = key(box, "Tab");
    assert(e.defaultPrevented, "Tab has nowhere to go but the dialog");
    assertEquals(doc.activeElement, box);
  });
});

Deno.test("Confirm focus: ConfirmButton's dialog takes focus (Cancel first) and gives it back", async () => {
  await run(() =>
    h(ConfirmButton as never, {
      confirm: "Delete it?",
      onConfirm: () => {},
      children: "Delete",
    }), async ({ doc, root, settle }) => {
    const btn = root.querySelector("button");
    btn.focus();
    btn.click();
    await settle();
    const box = root.querySelector('[role="dialog"]');
    assert(box, "confirm open");
    assert(box.contains(doc.activeElement), "focus is inside the dialog");
    assertEquals(doc.activeElement?.textContent, "Cancel");
    doc.activeElement.click();
    await settle();
    assertEquals(root.querySelector('[role="dialog"]'), null);
    assertEquals(doc.activeElement, root.querySelector("button"));
  });
});
