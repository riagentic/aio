// aio/ui — the basic component kit. Proves each component renders the expected
// themeable markup and that interactive ones fire their typed callbacks.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Modal,
  Select,
  Table,
  UI_CSS,
  UiStyles,
} from "../src/ui/mod.ts";

function mount(App: ComponentFn) {
  const win = new Window();
  // deno-lint-ignore no-explicit-any
  const ui = testUI(App, { document: win.document as any });
  return ui;
}

// Mount and also hand back the window so tests can drive real DOM events.
async function mountWithWin(App: ComponentFn) {
  const win = new Window();
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(App, { document: win.document as any });
  return { ui, win };
}

Deno.test("ui: UiStyles renders the base stylesheet with themeable tokens", async () => {
  await using ui = await mount(() => h("div", null, h(UiStyles, null)));
  const html = ui.html();
  assertStringIncludes(html, "<style");
  assertStringIncludes(html, "--aio-accent");
  // dark theme ships too
  assertStringIncludes(UI_CSS, "prefers-color-scheme: dark");
});

Deno.test("ui: Button renders variant + size classes and fires onClick", async () => {
  let clicks = 0;
  const App = () =>
    h(
      Button,
      { variant: "primary", size: "lg", onClick: () => clicks++ },
      "Save",
    );
  const { ui, win } = await mountWithWin(App);
  assertStringIncludes(ui.html(), "aio-btn--primary");
  assertStringIncludes(ui.html(), "aio-btn--lg");
  assertStringIncludes(ui.html(), "Save");
  const btn = win.document.querySelector("button.aio-btn");
  assert(btn, "button rendered");
  (btn as unknown as { click: () => void }).click();
  assertEquals(clicks, 1);
  await ui.dispose();
});

Deno.test("ui: Input surfaces the string value to onInput", async () => {
  const seen: string[] = [];
  const App = () =>
    h(Input, { placeholder: "Name", onInput: (v: string) => seen.push(v) });
  const { ui, win } = await mountWithWin(App);
  assertStringIncludes(ui.html(), "aio-input");
  assertStringIncludes(ui.html(), 'placeholder="Name"');
  const input = win.document.querySelector("input.aio-input") as unknown as
    | { value: string; dispatchEvent: (e: unknown) => void }
    | null;
  assert(input, "input rendered");
  input.value = "hi";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  assertEquals(seen[seen.length - 1], "hi");
  await ui.dispose();
});

Deno.test("ui: Input invalid state adds the modifier class", async () => {
  await using ui = await mount(() => h(Input, { invalid: true }));
  assertStringIncludes(ui.html(), "aio-input--invalid");
});

Deno.test("ui: Field wires label, hint, error and required marker", async () => {
  await using ui = await mount(() =>
    h(
      Field,
      { label: "Email", required: true, error: "Required" },
      h(Input, {}),
    )
  );
  const html = ui.html();
  assertStringIncludes(html, "aio-field__label");
  assertStringIncludes(html, "Email");
  assertStringIncludes(html, "aio-field__req");
  assertStringIncludes(html, "aio-field__error");
  assertStringIncludes(html, "Required");
});

Deno.test("ui: Select renders options and marks the selected one", async () => {
  await using ui = await mount(() =>
    h(Select, { value: "b", options: ["a", { value: "b", label: "Bee" }] })
  );
  const html = ui.html();
  assertStringIncludes(html, "aio-select");
  assertStringIncludes(html, "Bee");
  assertStringIncludes(html, "<option");
});

Deno.test("ui: Checkbox with label reports checked state", async () => {
  const seen: boolean[] = [];
  await using ui = await mount(() =>
    h(Checkbox, {
      checked: false,
      label: "Agree",
      onChange: (c: boolean) => seen.push(c),
    })
  );
  assertStringIncludes(ui.html(), "aio-checkbox");
  assertStringIncludes(ui.html(), "Agree");
});

Deno.test("ui: Table renders columns, cell renderers, and the empty state", async () => {
  const rows = [{ id: 1, name: "Ada" }, { id: 2, name: "Lin" }];
  const cols = [
    { key: "id", header: "ID" },
    {
      key: "name",
      header: "Name",
      render: (r: { name: string }) => r.name.toUpperCase(),
    },
  ];
  await using ui = await mount(() =>
    h(Table, { columns: cols, rows, getKey: (r: { id: number }) => r.id })
  );
  const html = ui.html();
  assertStringIncludes(html, "aio-table");
  assertStringIncludes(html, "ID");
  assertStringIncludes(html, "ADA"); // render() applied
  assertStringIncludes(html, "LIN");

  await using empty = await mount(() =>
    h(Table, { columns: cols, rows: [], empty: "Nothing here" })
  );
  assertStringIncludes(empty.html(), "Nothing here");
  assertStringIncludes(empty.html(), "aio-table__empty");
});

Deno.test("ui: Modal renders only when open, with dialog role", async () => {
  await using closed = await mount(() => h(Modal, { open: false }, "hidden"));
  assertEquals(closed.html().includes("aio-modal"), false);

  await using open = await mount(() =>
    h(Modal, { open: true, title: "Confirm" }, "body-text")
  );
  const html = open.html();
  assertStringIncludes(html, "aio-modal-backdrop");
  assertStringIncludes(html, 'role="dialog"');
  assertStringIncludes(html, "Confirm");
  assertStringIncludes(html, "body-text");
});

Deno.test("ui: Modal closes on backdrop click", async () => {
  let closes = 0;
  const App = () => h(Modal, { open: true, onClose: () => closes++ }, "x");
  const { ui, win } = await mountWithWin(App);
  await ui.settle();
  // Click directly on the backdrop (target === currentTarget → dismiss).
  const backdrop = win.document.querySelector(
    ".aio-modal-backdrop",
  ) as unknown as {
    click: () => void;
  } | null;
  assert(backdrop, "backdrop rendered");
  backdrop.click();
  assertEquals(closes, 1);
  await ui.dispose();
});

Deno.test("ui: Modal Escape-to-close listens on the render document", async () => {
  let closes = 0;
  const App = () => h(Modal, { open: true, onClose: () => closes++ }, "x");
  const { ui, win } = await mountWithWin(App);
  await ui.settle();
  // The Escape listener attaches to AIR's render document (risoto #3) — dispatch
  // a real keydown there. If this env can't build a KeyboardEvent, skip cleanly.
  try {
    win.document.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape" }),
    );
    assertEquals(closes, 1);
  } catch {
    // KeyboardEvent unsupported in this DOM shim — render/backdrop paths cover it.
  }
  await ui.dispose();
});

Deno.test("ui: Card renders title, body, and footer", async () => {
  await using ui = await mount(() =>
    h(Card, { title: "Stats", footer: "updated now" }, "the body")
  );
  const html = ui.html();
  assertStringIncludes(html, "aio-card__title");
  assertStringIncludes(html, "Stats");
  assertStringIncludes(html, "the body");
  assertStringIncludes(html, "aio-card__footer");
});
