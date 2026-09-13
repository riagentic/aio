// Menu's two promises that never worked: opening it focuses the first item,
// and a click outside closes it. Both read the root element through a per-
// render `let`, and the renderer detaches a ref (null) before attaching the
// next render's — so once the menu re-rendered (opening it IS a re-render),
// every earlier closure saw `null`. The outside-click listener lives in the
// FIRST render's onMount, so it never closed anything; the focus microtask read
// the null too. The existing tests checked `aria-expanded` and never looked at
// focus or clicked outside.
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { Menu } from "../src/ui/controls.ts";
import { Modal } from "../src/ui/mod.ts";

const App = () =>
  h(
    "div",
    null,
    h("p", { id: "outside" }, "outside text"),
    h(Menu, {
      trigger: "Actions",
      items: [{ id: "edit", label: "Edit" }, { id: "del", label: "Delete" }],
    }),
  );

const activeText = (d: Document) => d.activeElement?.textContent ?? null;

testUI(
  App,
  "Menu: click on the trigger opens it with the first item focused",
  async (ui) => {
    ui.ActionsButton.click();
    await ui.settle();
    const d = ui.document as unknown as Document;
    assert(d.querySelector('[role="menu"]'), "the menu opened");
    assertEquals(d.activeElement?.getAttribute("role"), "menuitem");
    assertEquals(activeText(d), "Edit");
  },
);

testUI(
  App,
  "Menu: ArrowDown on a CLOSED trigger opens it and focuses the first item",
  async (ui) => {
    ui.ActionsButton.focus();
    ui.ActionsButton.press("ArrowDown");
    await ui.settle();
    const d = ui.document as unknown as Document;
    assert(d.querySelector('[role="menu"]'), "the menu opened");
    assertEquals(activeText(d), "Edit");
  },
);

testUI(
  App,
  "Menu: a pointerdown outside closes it (after it has re-rendered)",
  async (ui) => {
    ui.ActionsButton.click();
    await ui.settle();
    const d = ui.document as unknown as Document;
    assert(d.querySelector('[role="menu"]'), "open before the outside click");
    // deno-lint-ignore no-explicit-any
    const W = ui.window as any;
    d.querySelector("#outside")!.dispatchEvent(
      new W.PointerEvent("pointerdown", { bubbles: true }),
    );
    await ui.settle();
    assertEquals(
      d.querySelector('[role="menu"]'),
      null,
      "outside click closes",
    );
  },
);

testUI(
  () =>
    h(Menu, {
      trigger: "Actions",
      items: [{ id: "x", label: "X", disabled: true }, { id: "y", label: "Y" }],
    }),
  "Menu: a disabled first item is skipped when focusing on open",
  async (ui) => {
    ui.ActionsButton.click();
    await ui.settle();
    assertEquals(activeText(ui.document as unknown as Document), "Y");
  },
);

// An open Menu inside a Modal: the first Escape is the MENU's (it
// preventDefaults), the dialog stays. Escape on a CLOSED menu's trigger is not
// the menu's to take, so the dialog closes.
const dlg = signal(true);
testUI(
  () =>
    h(Modal as never, {
      open: dlg.value,
      title: "Row",
      onClose: () => dlg.set(false),
      children: h(Menu, {
        trigger: "Actions",
        items: [{ id: "a", label: "A" }],
      }),
    }),
  "Menu in a Modal: Escape closes the menu first, then the dialog",
  async (ui) => {
    const d = ui.document as unknown as Document;
    // deno-lint-ignore no-explicit-any
    const W = ui.window as any;
    const esc = (el: Element) =>
      el.dispatchEvent(
        new W.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    (d.querySelector(".aio-menu__trigger") as HTMLElement).click();
    await ui.settle();
    assert(d.querySelector('[role="menu"]'), "menu open");
    esc(d.activeElement!);
    await ui.settle();
    assertEquals(d.querySelector('[role="menu"]'), null, "menu closed");
    assertEquals(dlg.peek(), true, "…and the dialog around it did not");
    esc(d.activeElement!);
    await ui.settle();
    assertEquals(dlg.peek(), false, "Escape on the closed trigger closes it");
  },
);
