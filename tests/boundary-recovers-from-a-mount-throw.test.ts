// An `<ErrorBoundary>` whose child throws on its FIRST render must be able to
// recover.
//
// The RE-RENDER path already refuses to let a fallback become permanent, and
// says why: "THE DEPS OF THE FAILED RENDER COME ALONG. A fallback typically
// reads no signals at all, so subscribing to only its deps would subscribe to
// NOTHING and the component could never be asked to render again — the
// fallback would be permanent, which is a worse stale than the one this
// replaces."
//
// The MOUNT path did exactly that. A component that throws before reaching
// `afterComponent` has no instance, so nothing subscribed to the signals it
// read before throwing — and the mount comment asserted that a throw "unwinds
// to the catch below" as if that were equivalent. Measured:
//
//   boot (not ready)   <div>0<i>err:not ready</i></div>   Child ran: 1
//   after ready=true   <div>0<i>err:not ready</i></div>   Child ran: 1  ← never re-ran
//   after parent bump  <div>1<p>loaded</p></div>          Child ran: 2  ← only this fixed it
//
// `<ErrorBoundary><Chart/></ErrorBoundary>` where Chart throws while its data
// is still loading is the ordinary shape of this.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

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

Deno.test("ErrorBoundary: a child that throws at MOUNT recovers when its signal changes", async () => {
  await withDom((root) => {
    const ready = signal(false);
    let childRuns = 0;
    const Child = () => {
      childRuns++;
      if (!ready.value) throw new Error("not ready");
      return h("p", null, ["loaded"]);
    };
    const App = () =>
      h("div", null, [
        h(
          ErrorBoundary,
          { fallback: (e: Error) => h("i", null, ["err:" + e.message]) },
          [h(Child as never, null)],
        ),
      ]);

    const origErr = console.error;
    console.error = () => {};
    const handle = mount(root, App as never);
    console.error = origErr;
    try {
      assertStringIncludes(
        root.innerHTML,
        "err:not ready",
        "the boundary caught the mount throw, as it should",
      );
      assertEquals(childRuns, 1);

      // The signal the child read before throwing is the signal that fixes it.
      ready.set(true);
      handle._flush();

      assert(
        childRuns > 1,
        "the child was never asked to render again — the fallback is " +
          "permanent, which the re-render path's own comment calls a worse " +
          "stale than the one it replaces",
      );
      assertStringIncludes(
        root.innerHTML,
        "<p>loaded</p>",
        `the boundary must step aside once the child works: ${root.innerHTML}`,
      );
    } finally {
      _unmount(handle);
    }
  });
});

// The control: a boundary whose child throws EVERY time must stay on the
// fallback, not thrash. A fix that simply re-ran the child on any signal would
// pass the test above and spin.
Deno.test("ErrorBoundary: a child that always throws stays on the fallback", async () => {
  await withDom((root) => {
    const tick = signal(0);
    let childRuns = 0;
    const Child = () => {
      childRuns++;
      void tick.value;
      throw new Error("always");
    };
    const App = () =>
      h("div", null, [
        h(
          ErrorBoundary,
          { fallback: (e: Error) => h("i", null, ["err:" + e.message]) },
          [h(Child as never, null)],
        ),
      ]);
    const origErr = console.error;
    console.error = () => {};
    const handle = mount(root, App as never);
    try {
      for (let i = 1; i <= 3; i++) {
        tick.set(i);
        handle._flush();
      }
      assertStringIncludes(root.innerHTML, "err:always");
      assert(
        childRuns <= 8,
        `a boundary must not spin on a child that always throws: ` +
          `${childRuns} renders for 3 signal changes`,
      );
    } finally {
      console.error = origErr;
      _unmount(handle);
    }
  });
});

// …and the re-render path, which was already correct, must stay correct.
Deno.test("ErrorBoundary: break → fix → break after a GOOD first render", async () => {
  await withDom((root) => {
    const ok = signal(true);
    const Child = () => {
      if (!ok.value) throw new Error("broke");
      return h("p", null, ["ok"]);
    };
    const App = () =>
      h("div", null, [
        h(
          ErrorBoundary,
          { fallback: () => h("i", null, ["fallback"]) },
          [h(Child as never, null)],
        ),
      ]);
    const origErr = console.error;
    console.error = () => {};
    const handle = mount(root, App as never);
    try {
      assertStringIncludes(root.innerHTML, "<p>ok</p>");
      for (
        const [v, want] of [[false, "fallback"], [true, "ok"], [
          false,
          "fallback",
        ], [true, "ok"]] as [boolean, string][]
      ) {
        ok.set(v);
        handle._flush();
        assertStringIncludes(root.innerHTML, want);
      }
    } finally {
      console.error = origErr;
      _unmount(handle);
    }
  });
});
