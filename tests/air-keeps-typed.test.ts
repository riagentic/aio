// When a render leaves a person's typed text in a control, and when it puts
// the control back on its prop — every row is what v1.0.19-beta did.
//
// `<input name="q" value={initial}>` with no handler, read through `FormData`
// on submit, is a field apps use as "uncontrolled with a starting value". In
// every 1.0 release a re-render with the same props left the typed text
// there, because such a vnode was static and two equal static vnodes skip the
// prop pass. That was an accident of an optimisation; `_keepsTyped`
// (vdom-create.ts) is the rule now, and this table is what it must answer.
// The line it says is a row of tests/prod-says-renderer.test.ts.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _diff, _render, h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { signal } from "../src/state/signal.ts";

type El = HTMLInputElement;
type View = (n: number) => ReturnType<typeof h>;
const fn = () => {};
const sig = signal("b");
const ref = { current: null };

const KEPT: [string, View, string?][] = [
  ["bare", () => h("input", { value: "b" })],
  [
    "string props beside it",
    () => h("input", { name: "q", type: "text", class: "x", value: "b" }),
  ],
  [
    "in a form with onSubmit, next to text that changes",
    (n) =>
      h(
        "form",
        { onSubmit: fn },
        h("input", { name: "q", value: "b" }),
        h("span", null, "n" + n),
      ),
  ],
  [
    "in a parent with nothing dynamic",
    () => h("p", { class: "r" }, h("input", { value: "b" }), h("i", null)),
  ],
  [
    "a style object of primitives",
    () => h("input", { value: "b", style: { color: "red" } }),
  ],
  ["textarea", () => h("textarea", { value: "b" }), "textarea"],
  ["checkbox, false", () => h("input", { type: "checkbox", checked: false })],
  ["checkbox, true", () => h("input", { type: "checkbox", checked: true })],
  ["defaultValue", () => h("input", { defaultValue: "b" })],
  ["defaultValue that changes", (n) => h("input", { defaultValue: "b" + n })],
  [
    "defaultChecked",
    () => h("input", { type: "checkbox", defaultChecked: false }),
  ],
];

const RESET: [string, View, string?][] = [
  ["another prop changes", (n) => h("input", { value: "b", class: "c" + n })],
  ["its value changes", (n) => h("input", { value: "b" + n })],
  ["a key", () => h("div", null, h("input", { key: "k", value: "b" }))],
  ["a ref", () => h("input", { value: "b", ref })],
  [
    "a handler for another event",
    () => h("input", { value: "b", onFocus: fn }),
  ],
  ["onInput", () => h("input", { value: "b", onInput: fn })],
  ["a class array", () => h("input", { value: "b", class: ["a"] })],
  ["a signal value", () => h("input", { value: sig })],
  [
    "a select with labelled options",
    () =>
      h(
        "select",
        { value: "b" },
        h("option", { value: "b" }, "B"),
        h("option", { value: "c" }, "C"),
      ),
    "select",
  ],
];

const shown = (el: El) =>
  el.type === "checkbox" ? String(el.checked) : el.value;

async function drive(view: View, sel = "input") {
  const win = new Window({ url: "https://localhost" });
  try {
    const doc = win.document as unknown as Document;
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    let prev = view(0);
    _render(host, prev, null, { doc });
    const el = host.querySelector(sel) as unknown as El;
    const first = el.checked;
    const out: { typed: string; after: string; prop: string }[] = [];
    for (let n = 1; n <= 2; n++) {
      if (el.type === "checkbox") el.checked = !first;
      else if (sel === "select") el.value = "c";
      else el.value += "~";
      const typed = shown(el);
      const next = view(n);
      _diff(host, next, prev, { doc });
      prev = next;
      assertEquals(host.querySelector(sel) as unknown, el, "the same node");
      const fresh = doc.createElement("main");
      _render(fresh, view(n), null, { doc });
      const prop = shown(fresh.querySelector(sel) as unknown as El);
      out.push({ typed, after: shown(el), prop });
    }
    _diff(host, null, prev, { doc });
    return out;
  } finally {
    await closeWindow(win);
  }
}

for (const [name, view, sel] of KEPT) {
  Deno.test(`typed text is KEPT across a render: ${name}`, async () => {
    const rows = await drive(view, sel);
    assertEquals(rows.length, 2, "both renders were driven");
    for (const r of rows) {
      assertEquals(r.after, r.typed);
      assert(r.after !== r.prop, "the row typed something the prop is not");
    }
  });
}

for (const [name, view, sel] of RESET) {
  Deno.test(`a render puts the control back on its prop: ${name}`, async () => {
    const rows = await drive(view, sel);
    assertEquals(rows.length, 2, "both renders were driven");
    for (const r of rows) {
      assertEquals(r.after, r.prop);
      assert(r.typed !== r.prop, "the row typed something the prop is not");
    }
  });
}

Deno.test("typed text is KEPT: a form read with FormData on submit, re-rendered while it is typed into", async () => {
  const win = new Window({ url: "https://localhost" });
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    const root = doc.createElement("main");
    doc.body.appendChild(root);
    const ticks = signal(0);
    const App = () =>
      h(
        "form",
        { onSubmit: fn },
        h("input", { name: "q", value: "initial" }),
        h("input", { name: "ok", type: "checkbox", checked: false }),
        h("output", null, String(ticks.value)),
      );
    const handle = mount(root as never, App as never);
    const q = root.querySelector("[name=q]") as unknown as El;
    const ok = root.querySelector("[name=ok]") as unknown as El;
    for (let i = 1; i <= 3; i++) {
      q.value += "x";
      ok.checked = true;
      ticks.set(i);
      await new Promise<void>((r) => setTimeout(r, 0));
      assertEquals(root.querySelector("output")!.textContent, String(i));
    }
    const data = new win.FormData(
      root.querySelector("form") as never,
    ) as unknown as FormData;
    assertEquals([data.get("q"), data.get("ok")], ["initialxxx", "on"]);
    _unmount(handle);
  } finally {
    await closeWindow(win);
  }
});

Deno.test("defaultValue / defaultChecked: the server writes them, hydrate keeps them, no render writes them again", async () => {
  const App = () =>
    h(
      "p",
      null,
      h("input", { name: "q", defaultValue: "start" }),
      h("input", { name: "ok", type: "checkbox", defaultChecked: true }),
      h("textarea", { defaultValue: "note" }),
    );
  const html = renderToString(h(App as never, null));
  assert(html.includes('value="start"'), html);
  assert(/<input[^>]*name="ok"[^>]* checked/.test(html), html);
  assert(html.includes(">note</textarea>"), html);
  assert(!/default/i.test(html), html);
  const win = new Window({ url: "https://localhost" });
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    const root = doc.createElement("main");
    doc.body.appendChild(root);
    root.innerHTML = html;
    const [q, ok] = Array.from(
      root.querySelectorAll("input"),
    ) as unknown as El[];
    const note = root.querySelector("textarea") as unknown as El;
    const handle = hydrate(root as never, App as never);
    assertEquals(
      root.querySelector("input") as unknown,
      q,
      "hydrated in place",
    );
    assertEquals([q!.value, ok!.checked, note.value], ["start", true, "note"]);
    _unmount(handle);
  } finally {
    await closeWindow(win);
  }
});
