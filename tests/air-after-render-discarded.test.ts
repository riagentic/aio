// `afterRender` waits for a commit. An instance thrown away before its render
// committed has none coming — and got the callback anyway, AFTER its own
// `onUnmount`, for a tree that was never on the page.
//
// The hydrate-mismatch fallback was the first place this was seen
// (tests/hydrate-parser-restructured.test.ts); a boundary that catches is the
// same discard reached from the other side — at mount, and on an update that
// swaps live children for the fallback. One rule for all of them, the one
// `onMount` already had: a callback whose instance is gone is not run.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  afterRender,
  mount,
  onUnmount,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

async function world(fn: (host: Element, log: string[]) => void) {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  const origErr = console.error;
  console.error = () => {};
  try {
    _setDocument(doc as never);
    doc.body.innerHTML = `<div id="a"></div>`;
    fn(doc.getElementById("a")!, []);
  } finally {
    console.error = origErr;
    await closeWindow(win);
  }
}

const LOG: string[] = [];
const Leaf = (p: { name: string }) => {
  onUnmount(() => LOG.push("unmount " + p.name));
  afterRender(() => LOG.push("after " + p.name));
  return h("span", null, p.name);
};
const Boom = () => {
  afterRender(() => LOG.push("after Boom"));
  throw new Error("boom");
};
const Fallback = () => {
  afterRender(() => LOG.push("after Fallback"));
  return h("b", null, "!");
};
const boundary = (...kids: unknown[]) =>
  h(
    ErrorBoundary as never,
    { fallback: () => h(Fallback, null) },
    ...kids as never[],
  );

Deno.test("afterRender: a boundary that catches at MOUNT runs none for the children it discarded", async () => {
  await world((host) => {
    LOG.length = 0;
    const App = () =>
      h(
        "main",
        null,
        h(Leaf as never, { name: "Out" }),
        boundary(h(Leaf as never, { name: "D" }), h(Boom, null)),
      );
    const handle = mount(host, App);
    handle._flush();
    assertEquals(host.innerHTML.includes("<b>!</b>"), true, host.innerHTML);
    assertEquals(LOG, ["unmount D", "after Out", "after Fallback"]);
    _unmount(handle);
  });
});

Deno.test("afterRender: a boundary that catches on an UPDATE runs none for the live children it replaced", async () => {
  await world((host) => {
    LOG.length = 0;
    const bad = signal(false);
    const App = () =>
      h(
        "main",
        null,
        h(Leaf as never, { name: "Out" }),
        bad.value
          ? boundary(
            h(Leaf as never, { name: "D" }),
            h(Leaf as never, { name: "New" }),
            h(Boom, null),
          )
          : boundary(h(Leaf as never, { name: "D" })),
      );
    const handle = mount(host, App);
    handle._flush();
    assertEquals(LOG, ["after Out", "after D"]);
    LOG.length = 0;
    bad.set(true);
    handle._flush();
    assertEquals(host.innerHTML.includes("<b>!</b>"), true, host.innerHTML);
    assertEquals(
      LOG.filter((l) => l.startsWith("after")),
      ["after Fallback"], // `Out` did not render: same props
      LOG.join(", "),
    );
    assertEquals(LOG.filter((l) => l.startsWith("unmount")).sort(), [
      "unmount D",
      "unmount New",
    ]);
    _unmount(handle);
  });
});

// Found by the lifecycle fuzzer's throwing child: the update path retires the
// boundary's OLD children, then sweeps the half-diffed NEW ones — and a
// `<Portal>` is in both, with one region in its target. The second pass had
// no node left for the portal's bare text and reported, in dev, a text that
// "will stay on the page forever" — about a target that was already empty.
// And a signal child in the portal kept its subscription for good: the diff
// had moved its effect to the new vnode, whose text the first pass detached.
Deno.test("a boundary catching on an update retires a <Portal>'s content once: no lost-text alarm, no signal subscription left", async () => {
  const { Portal } = await import("../src/air/vdom.ts");
  const { setDevMode } = await import("../src/air/aio-renderer.ts");
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  setDevMode(true);
  try {
    await world((host) => {
      const target = host.ownerDocument!.createElement("aside");
      const bad = signal(false);
      const g = signal("g");
      const subs = () =>
        (g as unknown as { _subscribers: Set<unknown> })._subscribers.size;
      const Thrower = (p: { boom: boolean }) => {
        if (p.boom) throw new Error("boom");
        return null;
      };
      const App = () =>
        h(
          "main",
          null,
          boundary(
            h(
              Portal as never,
              { target },
              "a",
              g as never,
              h(Leaf as never, { name: "P" }),
            ),
            h(Thrower as never, { boom: bad.value }),
          ),
        );
      const handle = mount(host, App);
      handle._flush();
      assertEquals(target.textContent, "agP");
      assertEquals(subs(), 1);
      LOG.length = 0;
      bad.set(true);
      handle._flush();
      assertEquals(target.innerHTML, "");
      assertEquals(subs(), 0, "the signal child's effect outlived its text");
      assertEquals(LOG.filter((l) => l.startsWith("unmount")), ["unmount P"]);
      assertEquals(warns.filter((w) => w.includes("stay on the page")), []);
      _unmount(handle);
    });
  } finally {
    console.warn = origWarn;
    setDevMode(false);
  }
});
