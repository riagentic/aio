// A component body that throws while its PARENT's re-render diffs it is
// contained where it stands — the same rule a component that re-renders ITSELF
// has always had (AIO-138: keep the last good output). It used to unwind the
// parent's diff half-applied; AIO-180 then recorded the new tree as committed,
// so the next render mounted a SECOND copy of the child beside the stale one:
// `<main>Header: bob<p>Hi bob</p><p>Hi ann</p> footer</main>`, forever, where a
// fresh mount shows one paragraph.
//
// The property every case pins: once the data is valid again, the DOM equals a
// fresh render of the same component.

import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

async function withDom(
  fn: (doc: Document, fresh: (App: ComponentFn) => string) => void,
): Promise<string[]> {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    fn(doc, (App) => {
      const f = doc.createElement("div");
      const hd = mount(f, App);
      const html = f.innerHTML;
      _unmount(hd);
      return html;
    });
  } finally {
    console.error = orig;
    await closeWindow(win);
  }
  return errs;
}

function root(doc: Document): HTMLElement {
  const r = doc.createElement("div");
  doc.body.appendChild(r);
  return r;
}

Deno.test("rerender throw: a child that throws in its parent's re-render keeps its output, no duplicate after recovery", async () => {
  const errs = await withDom((doc, fresh) => {
    const data = signal<{ user: { name: string } | null }>({
      user: { name: "ann" },
    });
    const Profile = () =>
      h("p", null, "Hi ", (data.value.user as { name: string }).name);
    const App = () =>
      h(
        "main",
        null,
        "Header: ",
        data.value.user?.name ?? "none",
        h(Profile, null),
        " footer",
      );
    const r = root(doc);
    const hd = mount(r, App);

    data.set({ user: null });
    hd._flush();
    assertEquals(
      r.innerHTML,
      "<main>Header: none<p>Hi ann</p> footer</main>",
      "the parent's own update lands; the child keeps its last good output",
    );

    data.set({ user: { name: "bob" } });
    hd._flush();
    assertEquals(r.innerHTML, fresh(App), "recovered == fresh render");

    data.set({ user: { name: "cy" } });
    hd._flush();
    assertEquals(r.innerHTML, fresh(App));
    _unmount(hd);
  });
  assertEquals(
    errs.filter((e) => e.includes("render error in <Profile>")).length,
    1,
    "loud, and ONCE — the pass covered the child's own queued render",
  );
});

Deno.test("rerender throw: a keyed row that throws leaves no stuck tail", async () => {
  await withDom((doc, fresh) => {
    const d = signal(0);
    const Row = (p: { k: number }) => {
      if (d.value === 1 && p.k === 2) throw new Error("row");
      return h("li", null, "r", p.k, "-", d.value);
    };
    const App = () =>
      h(
        "ul",
        null,
        ...[1, 2, 3].map((k) => h(Row as ComponentFn, { key: k, k })),
        h("li", null, "tail", d.value),
      );
    const r = root(doc);
    const hd = mount(r, App);
    d.set(1);
    hd._flush();
    assertEquals(
      r.innerHTML,
      "<ul><li>r1-1</li><li>r2-0</li><li>r3-1</li><li>tail1</li></ul>",
    );
    for (const v of [2, 3]) {
      d.set(v);
      hd._flush();
      assertEquals(r.innerHTML, fresh(App), `value ${v}`);
    }
    _unmount(hd);
  });
});

Deno.test("rerender throw: a NEW child that throws holds an empty slot and comes back on its own signal", async () => {
  await withDom((doc, fresh) => {
    const open = signal(false);
    const ok = signal(false);
    // `Panel` is the only reader of `ok` — the parent never re-renders for it,
    // so recovery must come from the failed render's own deps.
    const Panel = () => {
      if (!ok.value) throw new Error("not ready");
      return h("b", null, "panel");
    };
    const App = () =>
      h("div", null, "a", open.value ? h(Panel, null) : null, "z");
    const r = root(doc);
    const hd = mount(r, App);
    open.set(true);
    hd._flush();
    assertEquals(r.innerHTML, "<div>a<!---->z</div>");
    ok.set(true);
    hd._flush();
    assertEquals(r.innerHTML, "<div>a<b>panel</b>z</div>");
    assertEquals(r.innerHTML, fresh(App));
    _unmount(hd);
  });
});

Deno.test("rerender throw: a boundary ABOVE the re-rendering parent shows its fallback in the child's place, then recovers", async () => {
  await withDom((doc, fresh) => {
    const bad = signal(false);
    const Child = () => {
      if (bad.value) throw new Error("bad");
      return h("i", null, "child");
    };
    // Parent reads `bad` too, so Parent re-renders and diffs Child — the
    // boundary is outside that pass.
    const Parent = () => h("section", null, String(bad.value), h(Child, null));
    const App = () =>
      h(
        "div",
        null,
        h(
          ErrorBoundary as unknown as ComponentFn,
          { fallback: () => h("em", null, "oops") },
          h(Parent, null),
        ),
        "end",
      );
    const r = root(doc);
    const hd = mount(r, App);
    bad.set(true);
    hd._flush();
    assertEquals(
      r.innerHTML,
      "<div><section>true<em>oops</em></section>end</div>",
    );
    bad.set(false);
    hd._flush();
    assertEquals(r.innerHTML, fresh(App));
    _unmount(hd);
  });
});

Deno.test("rerender throw: a boundary INSIDE the pass still catches it", async () => {
  await withDom((doc, fresh) => {
    const bad = signal(false);
    const Child = () => {
      if (bad.value) throw new Error("bad");
      return h("i", null, "child");
    };
    const App = () =>
      h(
        "div",
        null,
        String(bad.value),
        h(
          ErrorBoundary as unknown as ComponentFn,
          { fallback: () => h("em", null, "oops") },
          h(Child, null),
        ),
      );
    const r = root(doc);
    const hd = mount(r, App);
    bad.set(true);
    hd._flush();
    assertEquals(r.innerHTML, "<div>true<em>oops</em></div>");
    bad.set(false);
    hd._flush();
    assertEquals(r.innerHTML, fresh(App));
    _unmount(hd);
  });
});

Deno.test("rerender throw: a throw on FIRST mount still propagates out of mount()", async () => {
  await withDom((doc) => {
    const Boom = () => {
      throw new Error("first render");
    };
    let thrown = false;
    try {
      mount(root(doc), () => h("div", null, h(Boom, null)));
    } catch {
      thrown = true;
    }
    assertEquals(thrown, true);
  });
});
