// `useResource()` is a `use*`-named hook exported from `aio/air`, and it did
// not behave like one: it registered no cleanup and was not idempotent across
// renders. There was no correct way to call it.
//
//   Left alone (the natural way, no manual dispose): the resource outlived
//   the component FOREVER. Measured — three renders and an unmount left
//   `opens 1 closes 0`, and `_openResourceCount()` stuck at 1, against that
//   counter's own doc: "Zero is the healthy answer once every holder has
//   disposed." The refcount had also grown to 3, so a single later `dispose()`
//   could not have closed it either.
//
//   Wired to `onCleanup(dispose)` the way the docs show: a BODY cleanup fires
//   before every re-render, so three renders opened and closed the camera
//   three times with the key never changing — "two pipelines fighting over one
//   device", the exact thing this module's header says it exists to refuse.
//
// One handle per component INSTANCE now, disposed at unmount and only at
// unmount (`onCleanup` inside `onMount` is the mount-cleanup list, not the
// per-render one).
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { _openResourceCount, useResource } from "../src/air/use-resource.ts";

async function withDom<T>(fn: (root: HTMLElement) => T | Promise<T>) {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  try {
    return await fn(root);
  } finally {
    _setDocument(null as never);
    await closeWindow(win);
  }
}

Deno.test("useResource: ONE open across re-renders, closed at unmount", async () => {
  await withDom(async (root) => {
    const tick = signal(0);
    let opens = 0, closes = 0;
    const App = () => {
      void tick.value;
      useResource({
        key: () => "cam",
        open: () => {
          opens++;
          return { id: opens };
        },
        close: () => {
          closes++;
        },
      });
      return h("div", null, [String(tick.value)]);
    };
    const handle = mount(root, App as never);
    await new Promise((r) => setTimeout(r, 5));

    tick.set(1);
    handle._flush();
    tick.set(2);
    handle._flush();
    await new Promise((r) => setTimeout(r, 5));

    assertEquals(
      opens,
      1,
      "the key never changed — re-rendering must not re-open the device",
    );
    assertEquals(closes, 0, "…and must not close it either");

    _unmount(handle);
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(
      closes,
      1,
      "unmount must close it — otherwise the resource outlives the component",
    );
    assertEquals(
      _openResourceCount(),
      0,
      "`Zero is the healthy answer once every holder has disposed.`",
    );
  });
});

Deno.test("useResource: a CHANGED key still closes the old and opens the new", async () => {
  // The control — a handle that was created once and never listened again
  // would pass the test above and break the feature.
  await withDom(async (root) => {
    const which = signal("a");
    const opened: string[] = [];
    const closed: string[] = [];
    const App = () => {
      useResource({
        key: () => which.value,
        open: (k) => {
          opened.push(String(k));
          return { k };
        },
        close: (_v, k) => {
          closed.push(String(k));
        },
      });
      return h("div", null, [which.value]);
    };
    const handle = mount(root, App as never);
    await new Promise((r) => setTimeout(r, 5));
    which.set("b");
    handle._flush();
    await new Promise((r) => setTimeout(r, 10));
    try {
      assertEquals(opened, ["a", "b"], "the new key opens");
      assertEquals(closed, ["a"], "and the old one closes first");
    } finally {
      _unmount(handle);
      await new Promise((r) => setTimeout(r, 5));
    }
  });
});

Deno.test("useResource: outside a render, the caller still owns it", async () => {
  // Unchanged behaviour for the non-component caller: no hooks to hang off,
  // so `dispose()` is theirs.
  let opens = 0, closes = 0;
  const r = useResource({
    key: () => "x",
    open: () => {
      opens++;
      return 1;
    },
    close: () => {
      closes++;
    },
  });
  await new Promise((res) => setTimeout(res, 5));
  assertEquals(opens, 1);
  r.dispose();
  await new Promise((res) => setTimeout(res, 5));
  assertEquals(closes, 1);
  assert(_openResourceCount() === 0);
});
