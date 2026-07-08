// AIO-400: onMount must fire exactly once per component instance. afterSubtree
// deno-lint-ignore-file no-explicit-any
// (where AIO-390 defers mount firing so refs are committed) was firing whenever
// mountCallbacks were non-empty — so any re-render that re-executes the body
// (non-memoized: children/props changed) re-collected onMount and fired it
// again, remounting every wrapper/layout component that takes children.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";
import { onCleanup, onMount, useRef } from "../src/air/renderer-lifecycle.ts";
import { testComponent } from "../src/testing/test-component.ts";

function harness() {
  const win = new Window({ url: "https://localhost" });
  return { win, doc: win.document as unknown as Document };
}

Deno.test("onMount fires once for a wrapper-with-children across parent re-renders", async () => {
  const { win, doc } = harness();
  const s = signal(0);
  let mounts = 0;
  const Wrapper = (p: { children?: any }) => {
    onMount(() => mounts++);
    return h("div", null, p.children);
  };
  const App = () => h(Wrapper, null, h("span", null, `v${s.value}`));
  const t = testComponent(App, { document: doc });
  for (let i = 1; i <= 4; i++) {
    s.set(i);
    await new Promise((r) => setTimeout(r, 3));
  }
  assertEquals(mounts, 1);
  t.unmount();
  win.happyDOM.close();
});

Deno.test("onMount fires once even with a stable key and a sibling signal", async () => {
  const { win, doc } = harness();
  const s = signal(0);
  let mounts = 0;
  const Wrapper = (p: { children?: any }) => {
    onMount(() => mounts++);
    return h("div", null, p.children);
  };
  const App = () =>
    h(
      "div",
      null,
      h("b", null, `v${s.value}`),
      h(Wrapper, { key: "w" }, h("span", null, "static")),
    );
  const t = testComponent(App, { document: doc });
  s.set(1);
  await new Promise((r) => setTimeout(r, 3));
  s.set(2);
  await new Promise((r) => setTimeout(r, 3));
  assertEquals(mounts, 1);
  t.unmount();
  win.happyDOM.close();
});

Deno.test("onCleanup (from onMount) fires once, only on unmount — not per re-render", async () => {
  const { win, doc } = harness();
  const s = signal(0);
  let mounts = 0, cleanups = 0;
  const Wrapper = (p: { children?: any }) => {
    onMount(() => {
      mounts++;
      onCleanup(() => cleanups++); // AIO-76: unmount-only
    });
    return h("div", null, p.children);
  };
  const App = () => h(Wrapper, null, h("span", null, `v${s.value}`));
  const t = testComponent(App, { document: doc });
  s.set(1);
  await new Promise((r) => setTimeout(r, 3));
  s.set(2);
  await new Promise((r) => setTimeout(r, 3));
  assertEquals(mounts, 1);
  assertEquals(cleanups, 0); // still mounted
  t.unmount();
  assertEquals(cleanups, 1);
  win.happyDOM.close();
});

Deno.test("AIO-390 preserved: ref is committed when onMount runs", async () => {
  const { win, doc } = harness();
  let tagInMount: string | null = null;
  const App = () => {
    const ref = useRef<HTMLElement>(null!);
    onMount(() => {
      tagInMount = ref.current ? ref.current.nodeName : null;
    });
    return h("canvas", { ref });
  };
  const t = testComponent(App, { document: doc });
  assertEquals(tagInMount, "CANVAS");
  t.unmount();
  win.happyDOM.close();
});
