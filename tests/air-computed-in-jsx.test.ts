// A `computed` passed into JSX binds exactly like a signal — as a child and as a
// prop, on the client and in SSR.
//
// The renderer's "is this reactive" decider required `set`, which a computed
// does not have, so a computed took the plain-value path: as a child it threw
// "A component returned a function… did you return the component itself",
// naming a mistake nobody made, and as a prop it was written as the literal
// text `[object Function]` with nothing said.

import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import { _setDocument, mount } from "../src/air/aio-renderer.ts";
import { computed, signal } from "../src/state/signal.ts";

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { root, cleanup: () => closeWindow(win) };
}

Deno.test("computed in JSX: a child is one text node that follows it", async () => {
  const { root, cleanup } = setup();
  const n = signal(1);
  const label = computed(() => `n=${n.value}`);
  const App = () => h("p", null, "[", label as never, "]");
  const handle = mount(root, App);
  assertEquals(root.innerHTML, "<p>[n=1]</p>");
  n.set(2);
  handle._flush();
  assertEquals(root.innerHTML, "<p>[n=2]</p>");
  assertEquals(renderToString(h(App, null)), "<p>[n=2]</p>");
  await cleanup();
});

Deno.test("computed in JSX: a prop (and a style value) is bound, never stringified", async () => {
  const { root, cleanup } = setup();
  const on = signal(false);
  const title = computed(() => (on.value ? "on" : "off"));
  const color = computed(() => (on.value ? "red" : "blue"));
  const App = () =>
    h("i", { id: "t", title: title as never, style: { color } as never }, "x");
  const handle = mount(root, App);
  const el = root.querySelector("#t") as HTMLElement;
  assertEquals(el.getAttribute("title"), "off");
  assertEquals(el.style.color, "blue");
  on.set(true);
  handle._flush();
  assertEquals(el.getAttribute("title"), "on");
  assertEquals(el.style.color, "red");
  assertEquals(
    renderToString(h(App, null)),
    '<i id="t" title="on" style="color:red">x</i>',
  );
  await cleanup();
});

// A signal-valued style declaration takes the SAME name rule as a static one.
// The binder had its own inline camel→kebab, which lowercased a custom property
// (`--rowGap` → `--row-gap`, a different variable) and wrote `msTransform` as
// `ms-transform`, a name no engine reads.
Deno.test("signal style value: a custom property keeps its case (same name rule as static styles)", async () => {
  const { root, cleanup } = setup();
  const gap = signal("4px");
  const App = () =>
    h("div", { id: "s", style: { "--rowGap": gap } as never }, "x");
  const handle = mount(root, App);
  const el = root.querySelector("#s") as HTMLElement;
  assertEquals(el.style.getPropertyValue("--rowGap"), "4px");
  assertEquals(el.style.getPropertyValue("--row-gap"), "");
  gap.set("8px");
  handle._flush();
  assertEquals(el.style.getPropertyValue("--rowGap"), "8px");
  await cleanup();
});
