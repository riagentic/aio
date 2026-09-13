// Five kit components at the edges of their input: a clickable Table row with
// controls inside it, uncontrolled Tabs whose active tab went away, a Tooltip
// around one focusable element, a toast meant to stay, and a Pagination whose
// page is out of range.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import type { VNode } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import {
  _resetToasts,
  Button,
  Pagination,
  Table,
  toast,
  ToastHost,
} from "../src/ui/mod.ts";
import { type TabItem, Tabs, Tooltip } from "../src/ui/controls.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function withDom(
  app: () => VNode,
  body: (t: { win: Any; doc: Any; root: Any; flush: () => void }) => void,
): Promise<void> {
  const win = new Window({ url: "http://localhost/" }) as Any;
  const doc = win.document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const handle = mount(root, app as never) as Any;
  try {
    handle._flush();
    body({ win, doc, root, flush: () => handle._flush() });
  } finally {
    _unmount(handle);
    await closeWindow(win);
  }
}

Deno.test("Table: Enter/Space inside a control in a clickable row is the control's, not the row's", async () => {
  const opened: string[] = [];
  await withDom(() =>
    h(Table as never, {
      columns: [
        { key: "name" },
        {
          key: "note",
          render: () => h("input", { id: "note", "aria-label": "Note" }),
        },
        { key: "act", render: () => h("button", { id: "act" }, "Delete") },
      ],
      rows: [{ name: "alpha" }],
      onRowClick: (r: Any) => opened.push(r.name),
    }), ({ win, root }) => {
    const kd = (el: Any, key: string) => {
      const e = new win.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(e);
      return e;
    };
    let e = kd(root.querySelector("#note"), " ");
    assert(!e.defaultPrevented, "a space typed into the input is kept");
    e = kd(root.querySelector("#act"), "Enter");
    assert(!e.defaultPrevented, "Enter on the button still presses it");
    assertEquals(opened, [], "neither opened the row");
    e = kd(root.querySelector("tr.aio-tr--click"), "Enter");
    assert(e.defaultPrevented);
    assertEquals(opened, ["alpha"], "Enter on the row itself opens it");
  });
});

Deno.test("Tabs (uncontrolled): removing the active tab falls back to the first enabled tab", async () => {
  const tabs = signal<TabItem[]>([
    { id: "a", label: "A", children: "panel a" },
    { id: "b", label: "B", children: "panel b" },
  ]);
  await withDom(() => h(Tabs, { tabs: tabs.value }), ({ root, flush }) => {
    tabs.set([
      { id: "x", label: "X", disabled: true, children: "panel x" },
      { id: "b", label: "B", children: "panel b" },
      { id: "c", label: "C", children: "panel c" },
    ]);
    flush();
    const sel = [...root.querySelectorAll('[role="tab"]')].map((t: Any) =>
      `${t.textContent}:${t.getAttribute("aria-selected")}:${
        t.getAttribute("tabindex")
      }`
    );
    assertEquals(sel, ["X:false:-1", "B:true:0", "C:false:-1"]);
    assertEquals(
      root.querySelector('[role="tabpanel"]').textContent,
      "panel b",
    );
  });
});

Deno.test("Tooltip: aria-describedby goes on a single element child", () => {
  const one = renderToString(
    h(Tooltip, { text: "Deletes forever", children: h("button", null, "Del") }),
  );
  const id = /id="(aio-tip-[^"]+)"/.exec(one)![1];
  assert(
    one.includes(`<button aria-describedby="${id}">Del</button>`),
    `describedby on the focusable child: ${one}`,
  );
  assert(
    !one.includes(`class="aio-tip__trigger" aria-describedby`),
    "not also on the wrapper",
  );
  // An existing description is kept, the tooltip's appended.
  const merged = renderToString(
    h(Tooltip, {
      text: "t",
      children: h("button", { "aria-describedby": "hint" }, "B"),
    }),
  );
  assert(/aria-describedby="hint aio-tip-[^"]+"/.test(merged), merged);
  // A component (the documented `<Tooltip><Button>`) is handed the attribute;
  // the wrapper keeps its own in case a component does not forward it.
  const comp = renderToString(
    h(Tooltip, { text: "t", children: h(Button as never, null, "Purge") }),
  );
  assert(/<button aria-describedby="aio-tip-[^"]+"/.test(comp), comp);
  assert(
    /class="aio-tip__trigger" aria-describedby="aio-tip-/.test(comp),
    comp,
  );
  // Text (no element) keeps the wrapper form.
  const text = renderToString(h(Tooltip, { text: "t", children: "plain" }));
  assert(
    /class="aio-tip__trigger" aria-describedby="aio-tip-/.test(text),
    text,
  );
});

Deno.test("toast: a duration of Infinity or past the 32-bit timer limit stays until dismissed", async () => {
  _resetToasts();
  const count = () =>
    (renderToString(h(ToastHost as never, {})).match(/aio-toast__msg/g) ?? [])
      .length;
  try {
    toast("forever", { duration: Infinity });
    const dismiss = toast("25 days", { duration: 25 * 24 * 3600 * 1000 });
    toast("short", { duration: 1 });
    await new Promise((r) => setTimeout(r, 40));
    assertEquals(count(), 2, "only the 1ms toast went away");
    dismiss();
    assertEquals(count(), 1, "a sticky toast still dismisses");
  } finally {
    _resetToasts();
  }
});

Deno.test("Pagination: out-of-range page — enabled buttons fire, targets are clamped", async () => {
  const got: number[] = [];
  await withDom(() =>
    h(Pagination as never, {
      page: 9,
      pages: 3,
      onPage: (p: number) => got.push(p),
    }), ({ root }) => {
    const prev = root.querySelector('[aria-label="Previous page"]');
    const next = root.querySelector('[aria-label="Next page"]');
    assert(!prev.hasAttribute("disabled"), "Previous leads back into range");
    prev.click();
    next.click();
    assertEquals(got, [3, 3], "every enabled button reports an in-range page");
  });

  const edge: number[] = [];
  await withDom(() =>
    h(Pagination as never, {
      page: 3,
      pages: 2.5, // total / perPage without the ceil — 3 pages
      onPage: (p: number) => edge.push(p),
    }), ({ root }) => {
    const labels = [...root.querySelectorAll("button")].map((b: Any) =>
      `${b.getAttribute("aria-label")}${
        b.hasAttribute("disabled") ? "(disabled)" : ""
      }`
    );
    assertEquals(labels, [
      "Previous page",
      "Page 1",
      "Page 2",
      "Page 3",
      "Next page(disabled)",
    ]);
    root.querySelector('[aria-label="Previous page"]').click();
    assertEquals(edge, [2]);
  });
});
