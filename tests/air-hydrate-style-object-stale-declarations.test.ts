// hydrate() repairs a server/client `style` divergence to what the component
// says. For a style OBJECT the repair wrote the component's declarations ON TOP
// of the server's, so a server-only declaration (`padding`) survived forever —
// while the dev warning said "repaired". Found by
// tests/air-stateful-differential.test.ts (mismatch mode, FUZZ_SEED=13).
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";

async function both(ssr: string, props: Record<string, unknown>) {
  const win = new Window();
  const doc = win.document;
  _setDocument(doc);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const a = doc.createElement("div"), b = doc.createElement("div");
    a.innerHTML = ssr;
    const ha = hydrate(a, () => h("div", props));
    const hb = mount(b, () => h("div", props));
    ha._flush();
    hb._flush();
    const out = [a.innerHTML, b.innerHTML];
    _unmount(ha);
    _unmount(hb);
    return out;
  } finally {
    console.warn = warn;
    await closeWindow(win);
  }
}

Deno.test("hydrate: a style object over a server style string drops the server-only declarations", async () => {
  const [got, want] = await both(`<div style="padding:1px"></div>`, {
    style: { color: "red", marginTop: 2 },
  });
  assertEquals(got, want);
});

Deno.test("hydrate: a style object over a server style object keeps no stale key", async () => {
  const [got, want] = await both(
    `<div style="opacity:0;color:blue"></div>`,
    { style: { color: "red" } },
  );
  assertEquals(got, want);
});

Deno.test("hydrate: an empty style object over server declarations leaves no style", async () => {
  const [got, want] = await both(`<div style="color:blue"></div>`, {
    style: {},
  });
  assertEquals(got, want);
});

Deno.test("hydrate: matching markup with a signal-valued declaration is left in place, no divergence reported", async () => {
  const win = new Window();
  const doc = win.document;
  _setDocument(doc);
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  setDevMode(true);
  try {
    const col = signal("red");
    const App = () => h("p", { style: { color: col, marginTop: 1 } }, "x");
    const a = doc.createElement("div");
    a.innerHTML = renderToString(h(App, null));
    const hd = hydrate(a, App);
    hd._flush();
    assertEquals(
      a.querySelector("p")!.getAttribute("style"),
      "color: red; margin-top: 1px;",
    );
    assertEquals(warns.filter((w) => /disagrees/.test(w)), []);
    _unmount(hd);
  } finally {
    console.warn = warn;
    setDevMode("auto");
    await closeWindow(win);
  }
});
