// The framework's own component kit must not trip the framework's own dev
// warnings.
//
// `setDevMode(true)` turns on an a11y check that fires while a component's DOM
// is built. Seven `aio/ui` components tripped it, and every one of those
// warnings was addressed to an app author about markup they did not write and
// could not change:
//
//   <Table onRowClick>  → "<tr> has onClick but no keyboard handler" — and the
//                         row genuinely WAS mouse-only, so the warning was
//                         right and the fix was not the author's to make.
//   <Checkbox label>    → "<input> has no label association", about a checkbox
//                         wrapped in a <label> carrying the label they passed.
//   <Modal>/<Confirm>   → the same keyboard-handler warning about the scrim,
//                         whose keyboard route out is Escape (Modal installs
//                         it), not a keydown on a non-focusable div.
//
// A warning channel that fires on the framework's own output is the fastest way
// to teach people to ignore it. So it is a gate: render every kit component the
// way its own docs show, and require silence — with a control below proving the
// check still speaks when the app really did leave a control unnamed.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import {
  Avatar,
  Button,
  Card,
  Checkbox,
  Confirm,
  ConfirmButton,
  Field,
  Input,
  Markdown,
  Modal,
  Pagination,
  Row,
  Select,
  Spinner,
  Stack,
  Table,
  Textarea,
  ToastHost,
} from "../src/ui/mod.ts";

/** Mount `make` in dev mode and return every `[aio-dev]` line it printed. */
function devWarnings(make: () => unknown): string[] {
  const win = new Window({ url: "https://app.test/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.includes("[aio-dev]")) warns.push(line);
    else orig(...a);
  };
  // A fresh arm per case: the a11y reporter dedupes for the life of the mode.
  setDevMode(false);
  setDevMode(true);
  try {
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(host, make as () => never);
    _unmount(handle);
  } finally {
    setDevMode(false);
    console.warn = orig;
    win.happyDOM.close();
  }
  return warns;
}

/** Every kit component, as its own documentation renders it. */
const KIT: Array<[string, () => unknown]> = [
  ["Button", () => h(Button, { onClick: () => {} }, "Go")],
  ["Input", () => h(Input, { value: "", "aria-label": "Name" })],
  ["Textarea", () => h(Textarea, { value: "", "aria-label": "Body" })],
  [
    "Select",
    () =>
      h(Select, {
        "aria-label": "Kind",
        options: [{ value: "a", label: "A" }],
      }),
  ],
  ["Checkbox (labelled)", () => h(Checkbox, { checked: false, label: "On" })],
  [
    "Checkbox (bare)",
    () => h(Checkbox, { checked: false, "aria-label": "On" }),
  ],
  [
    "Field + Input",
    () => h(Field, { label: "Email" }, h(Input, { value: "" })),
  ],
  [
    "Table (clickable rows)",
    () =>
      h(Table, {
        columns: [{ key: "a", header: "A" }],
        rows: [{ a: 1 }],
        onRowClick: () => {},
      }),
  ],
  [
    "Table (plain)",
    () => h(Table, { columns: [{ key: "a" }], rows: [{ a: 1 }] }),
  ],
  ["Card", () => h(Card, { title: "T" }, "body")],
  ["Stack", () => h(Stack, {}, "a")],
  ["Row", () => h(Row, {}, "a")],
  [
    "Modal",
    () => h(Modal, { open: true, title: "T", onClose: () => {} }, "body"),
  ],
  ["Spinner", () => h(Spinner, {})],
  ["Avatar (initials)", () => h(Avatar, { name: "Ada" })],
  ["Avatar (image)", () => h(Avatar, { name: "Ada", src: "/a.png" })],
  ["Pagination", () => h(Pagination, { page: 2, pages: 5, onPage: () => {} })],
  [
    "Confirm",
    () =>
      h(Confirm, {
        open: true,
        message: "Sure?",
        onConfirm: () => {},
        onCancel: () => {},
      }),
  ],
  ["ConfirmButton", () => h(ConfirmButton, { onConfirm: () => {} }, "Delete")],
  ["ToastHost", () => h(ToastHost, {})],
  ["Markdown", () => h(Markdown, { source: "# t\n\n![a](/i.png)\n\n[l](/x)" })],
];

Deno.test("aio/ui: no kit component trips a framework dev warning", () => {
  const offenders: string[] = [];
  for (const [name, make] of KIT) {
    const warns = devWarnings(make);
    if (warns.length > 0) offenders.push(`${name}: ${warns.join(" | ")}`);
  }
  assertEquals(
    offenders,
    [],
    `these aio/ui components warn about their OWN markup, which the app ` +
      `author cannot change:\n  ${offenders.join("\n  ")}`,
  );
});

Deno.test("the a11y check still speaks when the APP left a control unnamed", () => {
  // The control: silence above must come from the kit being correct, not from
  // the check having been defanged.
  const warns = devWarnings(() => h(Input, { value: "" }));
  assertEquals(warns.length, 1, warns.join("\n"));
  assert(
    warns[0]!.includes("no label association"),
    `an unlabelled <Input> is the author's to fix and must still be ` +
      `reported: ${warns[0]}`,
  );
});

Deno.test("a clickable table row is operable from the keyboard", () => {
  // Not just quiet — actually reachable. The warning was RIGHT about <Table>.
  const win = new Window({ url: "https://app.test/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const hits: number[] = [];
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(
      host,
      () =>
        h(Table, {
          columns: [{ key: "a", header: "A" }],
          rows: [{ a: 1 }, { a: 2 }],
          onRowClick: (_r: Record<string, unknown>, i: number) => hits.push(i),
        }) as never,
    );
    const rows = host.querySelectorAll("tbody tr");
    assertEquals(rows.length, 2);
    const second = rows[1] as unknown as HTMLElement;
    assertEquals(
      second.getAttribute("tabindex"),
      "0",
      "a clickable row must be in the tab order",
    );
    for (const key of ["Enter", " "]) {
      const ev = new win.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      second.dispatchEvent(ev as unknown as Event);
      assert(
        (ev as unknown as Event).defaultPrevented,
        `${key === " " ? "Space" : key} must be consumed (Space would ` +
          `otherwise scroll the page)`,
      );
    }
    assertEquals(hits, [1, 1], "Enter and Space both activate the row");
    _unmount(handle);
  } finally {
    win.happyDOM.close();
  }
});
