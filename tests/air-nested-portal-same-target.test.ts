// A Portal nested inside another Portal with the SAME target — a dropdown
// inside a modal, both rendered into `document.body` — keeps the two regions
// apart.
//
// The outer portal appended its children to the target one by one; the inner
// portal, built while the outer was still being built, appended its own region
// in between. The regions interleaved, and every positional walk over the
// outer region counted the inner's nodes as its own: a text sibling's update
// was written in front of the dropdown while the old text stayed, and closing
// the modal left that text in the body for good.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, Portal } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

Deno.test("nested same-target portals never interleave — updates land in place and unmount leaves nothing", async () => {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    const T = doc.createElement("section");
    doc.body.appendChild(T);
    const open = signal(false);
    const menu = signal(true);
    const foot = signal<string | null>("f1");
    const inner = signal(false);
    const extra = signal<string[]>([]);
    const T2 = doc.createElement("aside");
    doc.body.appendChild(T2);
    const tgt = signal(T);
    const Dialog = () =>
      h(
        Portal,
        { target: tgt.value },
        h(
          "div",
          { class: "dialog" },
          menu.value
            ? h(Portal, { target: tgt.value }, h("ul", null, "menu"))
            : null,
        ),
        // A portal as a DIRECT child of the region, too.
        inner.value ? h(Portal, { target: tgt.value }, "inner") : null,
        foot.value,
        h("i", null, "end"),
        // Unkeyed on purpose: new tail rows are placed at the region's END.
        extra.value.map((x) =>
          x.startsWith("p")
            ? h(Portal, { target: tgt.value }, x)
            : h("b", null, x)
        ),
      );
    const App = () => h("main", null, open.value ? h(Dialog, null) : null);
    const hostOf = () => {
      const el = doc.createElement("div");
      doc.body.appendChild(el);
      return el;
    };
    const handle = mount(hostOf(), App as ComponentFn);
    handle._flush();
    const text = () => tgt.value.textContent;
    const steps: [() => void, string][] = [
      [() => open.set(true), "f1endmenu"],
      [() => foot.set("f2"), "f2endmenu"],
      [() => foot.set(null), "endmenu"],
      [() => inner.set(true), "endmenuinner"],
      [() => foot.set("f3"), "f3endmenuinner"],
      [() => menu.set(false), "f3endinner"],
      [() => open.set(false), ""],
      // Mounted in ONE pass with everything on.
      [() => (menu.set(true), open.set(true)), "f3endmenuinner"],
      [() => foot.set("f4"), "f4endmenuinner"],
      // A nested region created by the same diff that fills a sibling slot
      // after it.
      [() => (inner.set(false), foot.set(null)), "endmenu"],
      [() => (inner.set(true), foot.set("f5")), "f5endmenuinner"],
      // The whole region moves to another target in one diff.
      [() => tgt.set(T2), "f5endmenuinner"],
      [() => foot.set("f6"), "f6endmenuinner"],
      // With the region LAST in its target, a nested region and a sibling
      // after it are created by the same diff.
      [() => (menu.set(false), inner.set(false)), "f6end"],
      [() => extra.set(["a", "p1", "x"]), "f6endaxp1"],
      [() => extra.set(["a", "p1", "x", "y"]), "f6endaxyp1"],
      [() => extra.set(["a"]), "f6enda"],
      [() => open.set(false), ""],
    ];
    assertEquals(steps.length, 18);
    for (const [act, want] of steps) {
      act();
      handle._flush();
      assertEquals(text(), want, T.innerHTML);
    }
    _unmount(handle);
    assertEquals(T.innerHTML + T2.innerHTML, "");
  } finally {
    await closeWindow(win);
  }
});
