// A component that failed on one render must come back when the input that
// broke it goes away — including when the fix is its parent handing back props
// it had rendered before.
//
// A contained render error (`isolateComponentError`) left the auto-memo keyed
// on the last GOOD props. `mode` good → bad → good then matched the memo, the
// child was skipped, and the failed render had read no signal that could re-run
// it: an `<ErrorBoundary>` fallback stayed on screen for the life of the mount
// (and without a boundary the child stopped following its own signals).
//
// A `<Suspense>` retry that threw for real had the same shape one level up: the
// signals the throwing child read were subscribed on nothing, so the fallback
// outlived the condition that caused it.
//
// The property every case pins: once the inputs are valid again, the DOM equals
// a fresh render of the same component.

import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, Fragment, h, lazy, Suspense } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

async function withDom(
  fn: (
    doc: Document,
    fresh: (App: ComponentFn) => string,
  ) => void | Promise<void>,
): Promise<string[]> {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    await fn(doc, (App) => {
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

Deno.test("rerender throw: an ErrorBoundary fallback clears when the parent hands back the props that worked", async () => {
  const errs = await withDom((doc, fresh) => {
    const mode = signal("good");
    const tick = signal(0);
    const Child = (p: { mode: string }) => {
      if (p.mode === "bad") throw new Error("bad prop");
      return h("p", null, `child:${p.mode}:${tick.value}`);
    };
    const Parent = () =>
      h(
        Fragment,
        null,
        h("span", null, mode.value),
        h(Child, { mode: mode.value }),
      );
    const App = () =>
      h(
        "div",
        null,
        h(ErrorBoundary, {
          fallback: (e: Error) => h("em", null, `FB:${e.message}`),
        }, h(Parent, null)),
      );
    const r = root(doc);
    const hd = mount(r, App);

    mode.set("bad");
    hd._flush();
    assertEquals(
      r.innerHTML,
      "<div><span>bad</span><em>FB:bad prop</em></div>",
      "the boundary's fallback replaces the failing child",
    );

    mode.set("good");
    hd._flush();
    assertEquals(r.innerHTML, fresh(App), "good props again == fresh render");

    tick.set(1);
    hd._flush();
    assertEquals(r.innerHTML, fresh(App), "and it follows its own signal");
    _unmount(hd);
  });
  assertEquals(errs.length, 1, "the one failure is reported once");
});

Deno.test("rerender throw: without a boundary a child that threw follows its signals again once its props recover", async () => {
  await withDom((doc, fresh) => {
    const x = signal(1);
    const mode = signal("good");
    const Child = (p: { mode: string }) => {
      if (p.mode === "bad") throw new Error("bad prop");
      return h("p", null, `x=${x.value}`);
    };
    const App = () =>
      h(
        "div",
        null,
        h("span", null, mode.value),
        h(Child, { mode: mode.value }),
      );
    const r = root(doc);
    const hd = mount(r, App);

    x.set(2);
    hd._flush();
    mode.set("bad");
    hd._flush();
    assertEquals(
      r.innerHTML,
      "<div><span>bad</span><p>x=2</p></div>",
      "the child keeps its last good output",
    );

    mode.set("good");
    hd._flush();
    x.set(3);
    hd._flush();
    assertEquals(r.innerHTML, "<div><span>good</span><p>x=3</p></div>");
    assertEquals(r.innerHTML, fresh(App));
    x.set(4);
    hd._flush();
    assertEquals(r.innerHTML, fresh(App));
    _unmount(hd);
  });
});

Deno.test("rerender throw: the SAME failing props on a later parent render do not re-throw", async () => {
  const errs = await withDom((doc) => {
    const mode = signal("good");
    const other = signal(0);
    let calls = 0;
    const Child = (p: { mode: string }) => {
      calls++;
      if (p.mode === "bad") throw new Error("bad prop");
      return h("p", null, p.mode);
    };
    const App = () =>
      h(
        "div",
        null,
        h("b", null, String(other.value)),
        h(Child, { mode: mode.value }),
      );
    const r = root(doc);
    const hd = mount(r, App);
    mode.set("bad");
    hd._flush();
    const afterFail = calls;
    other.set(1);
    hd._flush();
    assertEquals(r.innerHTML, "<div><b>1</b><p>good</p></div>");
    assertEquals(
      calls,
      afterFail,
      "an unchanged failing input is not re-run on every parent render",
    );
    _unmount(hd);
  });
  assertEquals(errs.length, 1, "so the error is reported once, not per render");
});

Deno.test("suspense: a retry that throws is retried when the signal it read changes", async () => {
  await withDom(async (doc, fresh) => {
    const ready = signal(false);
    const other = signal(0);
    const Inner = () => {
      if (!ready.value) throw new Error("not ready");
      return h("p", null, "LOADED");
    };
    let resolve!: (m: { default: ComponentFn }) => void;
    const L = lazy(() => new Promise((r) => (resolve = r)));
    const App = () =>
      h(
        "div",
        null,
        h("b", null, `o${other.value}`),
        h(Suspense, { fallback: h("i", null, "loading") }, h(L, null)),
      );
    const r = root(doc);
    const hd = mount(r, App);
    const settle = async () => {
      await new Promise((res) => setTimeout(res, 10));
      hd._flush();
    };
    await settle();
    resolve({ default: Inner });
    await settle();
    assertEquals(
      r.innerHTML.replace(/<!---->/g, ""),
      "<div><b>o0</b><i>loading</i></div>",
      "the retry threw: the fallback stays",
    );

    ready.set(true);
    await settle();
    assertEquals(
      r.innerHTML.replace(/<!---->/g, ""),
      "<div><b>o0</b><p>LOADED</p></div>",
      "the signal that made it throw retries it — no unrelated render needed",
    );
    assertEquals(r.innerHTML, fresh(App));
    _unmount(hd);
  });
});

Deno.test("suspense: a throw NESTED inside the retried subtree also retries through the boundary's owner", async () => {
  await withDom(async (doc) => {
    const ready = signal(false);
    const Inner = () => {
      if (!ready.value) throw new Error("not ready");
      return h("p", null, "LOADED");
    };
    // The lazy module's component renders the thrower one level down, so the
    // instance nearest the throw is one the failed retry creates and discards.
    const Wrapper = () => h("section", null, h(Inner, null));
    let resolve!: (m: { default: ComponentFn }) => void;
    const L = lazy(() => new Promise((r) => (resolve = r)));
    const App = () =>
      h(
        "div",
        null,
        h(Suspense, { fallback: h("i", null, "loading") }, h(L, null)),
      );
    const r = root(doc);
    const hd = mount(r, App);
    const settle = async () => {
      await new Promise((res) => setTimeout(res, 10));
      hd._flush();
    };
    await settle();
    resolve({ default: Wrapper });
    await settle();
    assertEquals(
      r.innerHTML.replace(/<!---->/g, ""),
      "<div><i>loading</i></div>",
    );
    ready.set(true);
    await settle();
    assertEquals(
      r.innerHTML.replace(/<!---->/g, ""),
      "<div><section><p>LOADED</p></section></div>",
    );
    _unmount(hd);
  });
});
