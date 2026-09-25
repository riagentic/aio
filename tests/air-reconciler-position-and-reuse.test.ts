// Six reconciler defects found by differential fuzzing (the extended alphabet
// in renderer-differential.test.ts swept over more seeds, and the mount-level
// lifecycle differential in air-lifecycle-differential.test.ts). Each case is
// the minimized shape, asserted against a FRESH render of the same model — the
// one oracle a reconciler has to agree with.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  _diff,
  _render,
  Fragment,
  h,
  Portal,
  renderToString,
  type VNode,
} from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  onMount,
  onUnmount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { hydrate } from "../src/air/renderer-hydrate.ts";
import { signal } from "../src/state/signal.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function world() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as Any);
  return { win, doc };
}

const fresh = (doc: Document, v: VNode): string => {
  const el = doc.createElement("main");
  _render(el, v, null, { doc });
  return el.innerHTML;
};

const settle = async (hA: { _flush(): void }) => {
  hA._flush();
  await Promise.resolve();
  hA._flush();
};

const strip = (s: string) => s.replace(/ data-component="[^"]*"/g, "");

Deno.test("reconciler: a keyed list turning unkeyed keeps a fragment row's siblings inside the region", async () => {
  const { win, doc } = world();
  try {
    // `<div><>{rows}</>Z</div>` where the first row is itself a fragment.
    const mk = (keyed: boolean) =>
      h(
        "div",
        null,
        h(
          Fragment,
          null,
          h(Fragment, keyed ? { key: "c" } : null, "a", "b"),
          h("p", keyed ? { key: "p" } : null),
        ),
        "Z",
      );
    const host = doc.createElement("main");
    const a = mk(true), b = mk(false);
    _render(host, a, null, { doc });
    _diff(host, b, a, { doc });
    assertEquals(host.innerHTML, fresh(doc, mk(false)));
    assertEquals(host.innerHTML, "<div>ab<p></p>Z</div>");
  } finally {
    await closeWindow(win);
  }
});

Deno.test("reconciler: a portal-led fragment wrapped in another keeps its place before the next sibling", async () => {
  const { win, doc } = world();
  try {
    const target = doc.createElement("aside");
    const inner = () =>
      h(
        Fragment,
        null,
        h(Portal as never, { target }, "q"),
        h("p", { id: "a" }),
        "x",
      );
    const a = h(Fragment, null, inner(), h("p", { id: "z" }));
    const b = h(
      Fragment,
      null,
      h(Fragment, null, inner()),
      h("p", { id: "z" }),
    );
    const host = doc.createElement("main");
    _render(host, a, null, { doc });
    _diff(host, b, a, { doc });
    assertEquals(host.innerHTML, '<p id="a"></p>x<p id="z"></p>');
    _diff(host, null, b, { doc });
  } finally {
    await closeWindow(win);
  }
});

Deno.test("hydrate: a signal that changed since SSR leaves no stale server text behind", async () => {
  const { win, doc } = world();
  try {
    const s = signal<unknown>("server");
    const App = () =>
      h("p", null, "1", h(Fragment, null), s as unknown as VNode);
    const root = doc.createElement("div");
    root.innerHTML = renderToString(h(App, null));
    // The value moves on between SSR and hydrate (a WS snapshot, a write by a
    // component later in the same render) — and shrinks to a PREFIX of it.
    s.set("");
    const hA = hydrate(root, App);
    try {
      assertEquals(root.innerHTML, "<p>1<!----></p>");
      s.set("now");
      await settle(hA);
      assertEquals(root.innerHTML, "<p>1<!---->now</p>");
    } finally {
      _unmount(hA);
    }
  } finally {
    await closeWindow(win);
  }
});

Deno.test("reconciler: a component re-placing its own children keeps them mounted and live", async () => {
  const { win, doc } = world();
  setDevMode(true);
  try {
    doc.body.innerHTML = `<div id="a"></div><div id="t"></div>`;
    const target = doc.getElementById("t")!;
    const open = signal(false), txt = signal("t0");
    const log: string[] = [];
    const Child = () => {
      onMount(() => log.push("mount"));
      onUnmount(() => log.push("unmount"));
      return h("b", null, "child");
    };
    // The ordinary conditional wrapper, re-rendering on its OWN signal — so
    // it hands the very same `children` vnodes to a different parent tag.
    const Wrap = (p: { children?: VNode[] }) =>
      open.value
        ? h("section", null, ...(p.children ?? []))
        : h("div", null, ...(p.children ?? []));
    const App = () =>
      h(
        "main",
        null,
        h(
          Wrap as never,
          null,
          h("i", null, txt as unknown as VNode),
          h(Child as never, null),
          h(Portal as never, { target }, "m"),
        ),
      );
    const hA = mount(doc.getElementById("a")!, App);
    try {
      open.set(true);
      await settle(hA);
      txt.set("t1");
      await settle(hA);
      const host = doc.getElementById("a")!;
      assertEquals(
        strip(host.innerHTML),
        "<main><section><i>t1</i><b>child</b></section></main>",
        "the signal child froze at its old value",
      );
      // Remounted with its new parent — and NOT left unmounted on screen.
      assertEquals(log, ["mount", "unmount", "mount"]);
      assertEquals(target.innerHTML, "<!---->m", "the portal left a region");
      open.set(false);
      await settle(hA);
      assertEquals(target.innerHTML, "<!---->m");
    } finally {
      _unmount(hA);
    }
    assertEquals(log.at(-1), "unmount");
    assertEquals(target.innerHTML, "");
  } finally {
    setDevMode(false);
    await closeWindow(win);
  }
});

Deno.test("reconciler: reused children whose unkeyed ordinal shifts at the same index stay mounted and live", async () => {
  // Same parent tag, same length, same INDEX — but the sibling in front of
  // the reused children turns from unkeyed to keyed, so each child's unkeyed
  // ordinal (what the reconciler pairs by) shifts by one. Index equality is
  // not position equality; the cheap in-place proof must not skip this.
  const { win, doc } = world();
  setDevMode(true);
  try {
    doc.body.innerHTML = `<div id="a"></div>`;
    const keyed = signal(false), txt = signal("t0");
    const log: string[] = [];
    const Child = () => {
      onMount(() => log.push("mount"));
      onUnmount(() => log.push("unmount"));
      return h("b", null, "child");
    };
    const Wrap = (p: { children?: VNode[] }) =>
      h(
        "div",
        null,
        keyed.value ? h("u", { key: "k" }) : h("u", null),
        ...(p.children ?? []),
      );
    const App = () =>
      h(
        "main",
        null,
        h(
          Wrap as never,
          null,
          h("i", null, txt as unknown as VNode),
          h(Child as never, null),
        ),
      );
    const hA = mount(doc.getElementById("a")!, App);
    try {
      keyed.set(true);
      await settle(hA);
      txt.set("t1");
      await settle(hA);
      assertEquals(
        strip(doc.getElementById("a")!.innerHTML),
        "<main><div><u></u><i>t1</i><b>child</b></div></main>",
        "the signal child froze at its old value",
      );
      assertEquals(
        log.filter((x) => x === "mount").length -
          log.filter((x) => x === "unmount").length,
        1,
        log.join(),
      );
    } finally {
      _unmount(hA);
    }
    assertEquals(log.at(-1), "unmount");
  } finally {
    setDevMode(false);
    await closeWindow(win);
  }
});

Deno.test("reconciler: a child's own keyed reorder does not move its parent fragment's region start", async () => {
  const { win, doc } = world();
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  setDevMode(true);
  try {
    doc.body.innerHTML = `<div id="a"></div>`;
    const flip = signal(false), n = signal(0);
    const C = () =>
      flip.value
        ? h(Fragment, null, h("em", { key: "e" }), "x")
        : h(Fragment, null, "x", h("em", { key: "e" }));
    const App = () =>
      h(
        "main",
        null,
        h("header", null, "h"),
        h(
          Fragment,
          null,
          h(C as never, null),
          h("p", null, "p"),
          ...(n.value ? [h("b", null, "new")] : []),
        ),
        h("footer", null, "f"),
      );
    const hA = mount(doc.getElementById("a")!, App);
    try {
      flip.set(true);
      await settle(hA);
      n.set(1);
      await settle(hA);
      assertEquals(
        strip(doc.getElementById("a")!.innerHTML),
        "<main><header>h</header><em></em>x<p>p</p><b>new</b><footer>f</footer></main>",
      );
      assertEquals(warns.filter((w) => /desync/.test(w)), []);
    } finally {
      _unmount(hA);
    }
  } finally {
    console.warn = orig;
    setDevMode(false);
    await closeWindow(win);
  }
});

Deno.test("reconciler: removing a region whose inner component swapped its root removes its bare text too", async () => {
  const { win, doc } = world();
  try {
    doc.body.innerHTML = `<div id="a"></div>`;
    const shown = signal(true), inner = signal(0);
    // Swaps its ROOT element on its own signal — every ancestor fragment's
    // copy of "my first node" now points at a detached node.
    const Inner = () =>
      inner.value % 2 ? h("span", null, "s") : h("div", null, "d");
    const Outer = () =>
      shown.value
        ? h(
          Fragment,
          null,
          h(Fragment, null, h(Inner as never, null), "a"),
          "a",
        )
        : null;
    const App = () =>
      h("main", null, h(Outer as never, null), h("footer", null));
    const hA = mount(doc.getElementById("a")!, App);
    try {
      inner.set(1);
      await settle(hA);
      shown.set(false);
      await settle(hA);
      assertEquals(
        strip(doc.getElementById("a")!.innerHTML),
        "<main><!----><footer></footer></main>",
      );
    } finally {
      _unmount(hA);
    }
  } finally {
    await closeWindow(win);
  }
});

Deno.test("reconciler: children passed through a component to one that re-wraps them stay mounted and live", async () => {
  const { win, doc } = world();
  try {
    doc.body.innerHTML = `<div id="a"></div>`;
    const open = signal(false), txt = signal("t0");
    const log: string[] = [];
    const Child = () => {
      onMount(() => log.push("mount"));
      onUnmount(() => log.push("unmount"));
      return h("b", null, "child");
    };
    // Outer re-renders on its own signal and forwards the SAME children to
    // Inner as a prop change: Inner is re-rendered by its PARENT, not itself.
    const Inner = (p: { open: boolean; children?: VNode[] }) =>
      p.open
        ? h("section", null, ...(p.children ?? []))
        : h("div", null, ...(p.children ?? []));
    const Outer = (p: { children?: VNode[] }) =>
      h(Inner as never, { open: open.value }, ...(p.children ?? []));
    const App = () =>
      h(
        "main",
        null,
        h(
          Outer as never,
          null,
          h("i", null, txt as unknown as VNode),
          h(Child as never, null),
        ),
      );
    const hA = mount(doc.getElementById("a")!, App);
    try {
      open.set(true);
      await settle(hA);
      txt.set("t1");
      await settle(hA);
      assertEquals(
        strip(doc.getElementById("a")!.innerHTML),
        "<main><section><i>t1</i><b>child</b></section></main>",
      );
      assertEquals(log, ["mount", "unmount", "mount"]);
    } finally {
      _unmount(hA);
    }
  } finally {
    await closeWindow(win);
  }
});

Deno.test("hydrate: a root-level signal that changed since SSR leaves no stale server text behind", async () => {
  const { win, doc } = world();
  try {
    const s = signal<unknown>("server");
    const App = () => h(Fragment, null, "1", s as unknown as VNode);
    const root = doc.createElement("div");
    root.innerHTML = renderToString(h(App, null));
    s.set("");
    const hA = hydrate(root, App);
    try {
      assertEquals(root.textContent, "1");
    } finally {
      _unmount(hA);
    }
  } finally {
    await closeWindow(win);
  }
});
