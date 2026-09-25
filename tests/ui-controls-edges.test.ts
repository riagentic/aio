// Three kit controls that broke a promise at the edge of their input:
//
//  • <Skeleton> (one line) dropped every escape-hatch attribute — `id`,
//    `data-*`, `aria-*`, `title` — that the kit's `Common` props promise
//    every component passes through. The multi-line form kept them.
//  • <Tabs> built DOM ids straight from tab ids, which are app data. A tab id
//    with a space ("General settings") made `aria-labelledby` an IDREF LIST
//    of two ids that do not exist, so the panel had no accessible name.
//  • The tooltip bubble centred itself with a PHYSICAL `translateX(-50%)`
//    from a LOGICAL `inset-inline-start: 50%`. In RTL the inset flips to the
//    right edge and the translate does not, so the bubble sat a full width
//    off to the side of its trigger.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, mount } from "../src/air/aio-renderer.ts";
import { _resetControlIds, Skeleton, Tabs } from "../src/ui/controls.ts";
import { UI_CSS } from "../src/ui/styles.ts";

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _resetControlIds();
  return { doc, root, cleanup: () => closeWindow(win) };
}

function render(root: Element, app: () => ReturnType<typeof h>): () => void {
  const handle = mount(root as HTMLElement, app) as { _flush?: () => void };
  const flush = () => handle._flush?.();
  flush();
  return flush;
}

function key(el: Element, k: string): void {
  const doc = el.ownerDocument!;
  const ev = new (doc.defaultView as unknown as {
    KeyboardEvent: typeof KeyboardEvent;
  }).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
}

Deno.test("Skeleton: one line keeps the escape-hatch attributes, like many lines do", async () => {
  const { root, cleanup } = setup();
  const attrs = { id: "sk", "data-kind": "row", title: "loading" };
  for (const lines of [1, 3]) {
    root.innerHTML = "";
    render(root, () => h(Skeleton, { lines, ...attrs }));
    const el = root.firstElementChild!;
    assert(el, `lines=${lines}: rendered`);
    for (const [k, v] of Object.entries(attrs)) {
      assertEquals(el.getAttribute(k), v, `lines=${lines}: ${k}`);
    }
  }
  await cleanup();
});

Deno.test("Tabs: a tab id with spaces still names the panel and still arrows", async () => {
  const { root, doc, cleanup } = setup();
  const seen: string[] = [];
  const ids = ["General settings", "a%20b", "a b"];
  const flush = render(root, () =>
    h(Tabs, {
      label: "Settings",
      tabs: ids.map((id) => ({ id, label: id, children: `panel ${id}` })),
      onChange: (id: string) => seen.push(id),
    }));
  const tabs = [...root.querySelectorAll('[role="tab"]')] as HTMLElement[];
  assertEquals(tabs.length, 3);
  const domIds = tabs.map((t) => t.id);
  for (const id of domIds) {
    assert(!/\s/.test(id), `a DOM id is one token: ${id}`);
  }
  assertEquals(new Set(domIds).size, 3, "distinct tab ids stay distinct");
  const panel = root.querySelector('[role="tabpanel"]')!;
  const by = panel.getAttribute("aria-labelledby")!;
  assertEquals(by.split(/\s+/).length, 1, `one IDREF, not a list: ${by}`);
  assertEquals(doc.getElementById(by), tabs[0], "and it resolves to the tab");
  key(tabs[0]!, "ArrowRight");
  flush();
  assertEquals(seen, ["a%20b"]);
  assertEquals(doc.activeElement, tabs[1], "roving focus follows");
  await cleanup();
});

Deno.test("Tooltip: the bubble's centring offset is on the same axis side as its translate", () => {
  // `translateX(-50%)` is physical — it always shifts LEFT — so the offset it
  // undoes must be physical too: `left: 50%`. A logical inset flips in RTL.
  const rule = /\.aio-tip__bubble\s*\{([^}]*)\}/.exec(UI_CSS);
  assert(rule, "the bubble rule exists");
  assert(/translateX\(-50%\)/.test(rule[1]!), "it centres with a translate");
  const decls = [...UI_CSS.matchAll(/\.aio-tip__bubble\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!).join(";");
  assert(
    !/inset-inline-start\s*:\s*50%/.test(decls),
    "a logical inset under a physical translate is off-centre in RTL",
  );
  assert(/(^|[;\s])left\s*:\s*50%/.test(decls), "centred from the left edge");
});
