// SSR markup the HTML parser restructures cannot be adopted: it must be SAID,
// and the page must still end up right.
//
// `<p><div>x</div></p>` is what `renderToString` writes for that tree, and no
// DOM holds it: the parser closes the `<p>` at the `<div>`. A browser has
// always done that; happy-dom did not until 20 (MEASURED: 17.6.3 keeps the
// nesting, 20.14.5 answers `<p></p><div>x</div>`), so until aio moved to it
// the renderer's fuzzers hydrated such models as if they were adoptable and
// this path had no test at all. Their alphabets now avoid it
// (renderer-differential, air-lifecycle-differential); this pins what happens
// when an app does write it.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  afterRender,
  mount,
  onCleanup,
  onMount,
  onUnmount,
  setDevMode,
  useRef,
} from "../src/air/aio-renderer.ts";
import { hydrate } from "../src/air/renderer-hydrate.ts";

Deno.test("hydrate: markup the parser restructured (<p><div>) is a reported mismatch, and the fallback is a correct page", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  setDevMode(true);
  try {
    _setDocument(doc as never);
    doc.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
    let mounts = 0;
    const Leaf = () => {
      onMount(() => {
        mounts++;
      });
      return h("div", { class: "leaf" }, "x");
    };
    const App = () => h("p", null, h(Leaf, null));

    const host = doc.getElementById("a")!;
    const ssr = renderToString(h(App, null));
    assertEquals(ssr, `<p><div class="leaf">x</div></p>`);
    host.innerHTML = ssr;
    // The premise, measured — so this fails loudly the day the test DOM stops
    // parsing as a browser does, instead of passing on a path it never took.
    assertEquals(
      host.querySelector("p > div"),
      null,
      "the parser closes <p> at the <div>: " + host.innerHTML,
    );

    const handle = hydrate(host, App);
    handle._flush();
    assert(
      warns.some((w) => w.includes("found DOM that does not match")),
      "the discarded server HTML must be said:\n" + warns.join("\n"),
    );
    // Built by the client, not parsed: the tree the app described.
    const ref = doc.getElementById("b")!;
    const fresh = mount(ref, App);
    fresh._flush();
    assertEquals(host.innerHTML, ref.innerHTML);
    // (`data-component` is the dev stamp a client render writes.)
    assertEquals(host.innerHTML.replace(/ data-component="[^"]*"/g, ""), ssr);
    assertEquals(mounts, 2, "one live Leaf per root — the fallback's, once");
    _unmount(fresh);
    _unmount(handle);
  } finally {
    console.warn = origWarn;
    setDevMode(false);
    await closeWindow(win);
  }
});

// The lifecycle of the instances the fallback THROWS AWAY — the ones whose
// body ran before the walk met the mismatch. The contract is the one a
// boundary's discarded children already have (docs/ui/air-lifecycle.md,
// "onUnmount also runs … before the component ever mounts"): the render never
// committed, so nothing that waits for a commit may run (`onMount`,
// `afterRender`), and everything the body took is released exactly once
// (`onCleanup`, `onUnmount`). `afterRender` did run — AFTER the instance's
// `onUnmount`, for a tree that was never on the page, beside the live
// instance's own.
Deno.test("hydrate: an instance discarded by the mismatch fallback is released once and never sees a commit", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    _setDocument(doc as never);
    doc.body.innerHTML = `<div id="a"></div>`;
    let log: string[] = [];
    let n = 0;
    const Leaf = (p: { name: string }) => {
      const r = useRef(0);
      if (!r.current) r.current = ++n;
      const id = p.name + r.current;
      log.push("body " + id);
      onMount(() => {
        log.push("mount " + id);
        onCleanup(() => log.push("mount-cleanup " + id));
      });
      onUnmount(() => log.push("unmount " + id));
      onCleanup(() => log.push("cleanup " + id));
      afterRender(() => log.push("after " + id));
      return h("span", null, p.name);
    };
    // A is hydrated cleanly, B's body runs inside the <p> the parser closed,
    // C is never reached: the mismatch is the <div>.
    const App = () =>
      h(
        "main",
        null,
        h(Leaf as never, { name: "A" }),
        h("p", null, h(Leaf as never, { name: "B" }), h("div", null, "x")),
        h(Leaf as never, { name: "C" }),
      );
    const host = doc.getElementById("a")!;
    host.innerHTML = renderToString(h(App, null));
    const server = host.firstChild;
    log = [];
    n = 0;
    const handle = hydrate(host, App);
    handle._flush();
    assert(host.firstChild !== server, "premise: the fallback was taken");
    assertEquals(log, [
      "body A1",
      "body B2",
      // discarded: released, in the order an unmount releases
      "cleanup A1",
      "unmount A1",
      "cleanup B2",
      "unmount B2",
      // the client render
      "body A3",
      "body B4",
      "body C5",
      "mount A3",
      "mount B4",
      "mount C5",
      "after A3",
      "after B4",
      "after C5",
    ]);
    log = [];
    _unmount(handle);
    assertEquals(log.filter((l) => l.startsWith("unmount")), [
      "unmount A3",
      "unmount B4",
      "unmount C5",
    ]);
    assertEquals(log.filter((l) => /[AB][12]$/.test(l)), []);
  } finally {
    console.warn = origWarn;
    await closeWindow(win);
  }
});
