// `useResource()` inside a component, where the ONLY read of the key is the
// `key()` function itself — the shape `docs/ui/air-advanced.md` shows
// (`key: () => settings.cameraId`) and the one a component that never prints
// the id has. The existing guard test also rendered the key, so the component
// re-rendered on the change and hid what happens when nothing else reads it.
//
// Why it broke: the renderer collects every `effect()` created during a render
// and disposes the lot at the next re-render (that is how per-render effects
// stay per-render). `useResource` creates its key-watching reaction ONCE, on
// the first render, so the first re-render for ANY reason — here, the opened
// value landing and being shown — silently killed it. A component that also
// rendered the key re-rendered on the change and ran the new key's open
// through the stale closure, which is what hid it.
//
// Measured before the fix: opened ["a"], closed [] — the page stayed on
// camera "a" after the key moved to "b".
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { _openResourceCount, useResource } from "../src/air/use-resource.ts";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

Deno.test("useResource: a key read ONLY inside key() still re-keys the resource", async () => {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const which = signal("a");
  const opened: string[] = [];
  const closed: string[] = [];
  const App = () => {
    const cam = useResource({
      key: () => which.value,
      open: (k) => {
        opened.push(String(k));
        return { k };
      },
      close: (_v, k) => {
        closed.push(String(k));
      },
    });
    // The key is NOT rendered — only the opened value, whose landing
    // re-renders the component the way a real camera preview does.
    return h("div", null, [String(cam.value?.k)]);
  };
  const handle = mount(root, App as never);
  try {
    await tick();
    which.set("b");
    handle._flush();
    await tick();
    assertEquals(opened, ["a", "b"], "the new key opens");
    assertEquals(closed, ["a"], "and the old one closes first");
    which.set("c");
    handle._flush();
    await tick();
    assertEquals(opened, ["a", "b", "c"]);
    assertEquals(closed, ["a", "b"]);
    assertEquals(root.textContent, "c", "and the page shows the new one");
  } finally {
    _unmount(handle);
    await tick();
    _setDocument(null as never);
    await closeWindow(win);
  }
  assertEquals(closed, ["a", "b", "c"]);
  assertEquals(_openResourceCount(), 0);
});

// The doc's own shape: the key is a CELL field, changed by a method call.
const settings = cell("ur-key-only-settings", {
  state: { cameraId: "a" },
  methods: {
    pick(s: { cameraId: string }, id: string) {
      s.cameraId = id;
    },
  },
});
const camOpened: string[] = [];
const camClosed: string[] = [];
function CameraPanel() {
  const cam = useResource({
    key: () => settings.cameraId,
    open: (id) => {
      camOpened.push(String(id));
      return `cam:${id}`;
    },
    close: (_v, id) => {
      camClosed.push(String(id));
    },
  });
  return h("div", null, [
    h("span", { class: "label" }, [String(cam.value)]),
    h("button", { t: "b", onClick: () => settings.pick("b") }, ["B"]),
  ]);
}

testUI(
  CameraPanel,
  "useResource: a cell key read only in key() re-keys after a method call",
  async (ui) => {
    await ui.settle();
    ui.b.click();
    await ui.settle();
    await tick(20);
    await ui.settle();
    assertEquals(camOpened, ["a", "b"]);
    assertEquals(camClosed, ["a"]);
    assertStringIncludes(ui.html(), "cam:b");
  },
);
