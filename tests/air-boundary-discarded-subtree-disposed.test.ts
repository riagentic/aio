// What a boundary THROWS AWAY must be torn down — at any depth, on every path.
//
// An `<ErrorBoundary>` that catches (or a `<Suspense>` that falls back) swaps
// its fallback in for its children, but the failed attempt had already built
// part of them: the wrappers above the thrower, the siblings before it, their
// signal children, refs and `useResource` holds. Nothing unmounted them.
// Measured before the fix, `<ErrorBoundary><Wrapper reads w><Thrower/>` with
// the owner re-rendering 200 times:
//
//   depth 1  w subscribers 201, 50 × w.set → 10051 wrapper renders into
//            detached DOM, still 201 subscribers after unmount
//   depth 2  402 / 20102
//
// and the same class everywhere around it: a completed sibling (21 after 20
// retries), a boundary mounted fresh on each toggle (one per mount, kept past
// unmount), a lazy pending under a wrapper (21), keyed list items (43), a
// signal child + signal attribute (42), a ref left on a detached element, and a
// `useResource` that never closed. A signal only the discarded wrapper read
// could not bring the boundary back either — the wrapper re-rendered, detached,
// and the fallback stayed.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, Fragment, h, lazy, Suspense } from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import type { Signal } from "../src/state/signal.ts";
import { _openResourceCount, useResource } from "../src/air/use-resource.ts";

type Root = { innerHTML: string };

const subs = (s: Signal<unknown>): number =>
  (s as unknown as { _subscribers: Set<unknown> })._subscribers.size;

const C = (fn: unknown) => fn as ComponentFn;

async function withDom(body: (root: Root) => void | Promise<void>) {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    await body(root);
  } finally {
    console.error = origErr;
    console.warn = origWarn;
    _setDocument(null as never);
    await closeWindow(win);
  }
}

const boundary = (children: VNode[]) =>
  h(ErrorBoundary, {
    fallback: (e: Error) => h("i", null, ["err:" + e.message]),
  }, children);

for (const depth of [1, 2]) {
  Deno.test(`discarded subtree: wrappers ${depth} deep are disposed on every retry and at unmount`, async () => {
    await withDom((root) => {
      const ready = signal(false);
      const w = signal(0);
      const tick = signal(0);
      let wrapperRenders = 0;
      const Thrower = () => {
        if (!ready.value) throw new Error("not ready");
        return h("p", null, ["loaded"]);
      };
      let inner = C(Thrower);
      for (let i = 0; i < depth; i++) {
        const Inner = inner;
        inner = C(() => {
          wrapperRenders++;
          return h("section", null, [String(w.value), h(Inner, null)]);
        });
      }
      const App = () =>
        h("div", null, [String(tick.value), boundary([h(inner, null)])]);
      const hd = mount(root, C(App));
      for (let i = 1; i <= 200; i++) {
        tick.set(i);
        hd._flush();
      }
      assertEquals(
        subs(w) <= 1,
        true,
        `w subscribers after 200 retries: ${subs(w)}`,
      );
      const before = wrapperRenders;
      for (let i = 1; i <= 50; i++) {
        w.set(i);
        hd._flush();
      }
      // One retry per set, `depth` wrappers each — never a render per dead copy.
      assertEquals(wrapperRenders - before, 50 * depth);
      ready.set(true);
      hd._flush();
      assertEquals(
        root.innerHTML.includes("<p>loaded</p>"),
        true,
        root.innerHTML,
      );
      _unmount(hd);
      assertEquals([subs(w), subs(ready), subs(tick)], [0, 0, 0]);
    });
  });
}

Deno.test("discarded subtree: a sibling that rendered before the thrower is disposed", async () => {
  await withDom((root) => {
    const w = signal(0);
    const tick = signal(0);
    const Ok = () => h("b", null, [String(w.value)]);
    const Thrower = () => {
      throw new Error("no");
    };
    const App = () =>
      h("div", null, [
        String(tick.value),
        boundary([h(C(Ok), null), h(C(Thrower), null)]),
      ]);
    const hd = mount(root, C(App));
    for (let i = 1; i <= 20; i++) {
      tick.set(i);
      hd._flush();
    }
    assertEquals(subs(w) <= 1, true, `w subscribers: ${subs(w)}`);
    _unmount(hd);
    assertEquals(subs(w), 0);
  });
});

Deno.test("discarded subtree: a boundary MOUNTED fresh on each toggle leaks nothing", async () => {
  await withDom((root) => {
    const w = signal(0);
    const show = signal(false);
    const Thrower = () => {
      throw new Error("no");
    };
    const Wrapper = () =>
      h("section", null, [String(w.value), h(C(Thrower), null)]);
    const App = () =>
      h("div", null, [show.value ? boundary([h(C(Wrapper), null)]) : "off"]);
    const hd = mount(root, C(App));
    for (let i = 1; i <= 21; i++) {
      show.set(!show.value);
      hd._flush();
    }
    assertEquals(root.innerHTML, "<div><i>err:no</i></div>");
    assertEquals(subs(w) <= 1, true, `w subscribers: ${subs(w)}`);
    _unmount(hd);
    assertEquals(subs(w), 0);
  });
});

Deno.test("discarded subtree: a wrapper around a PENDING lazy under <Suspense> is disposed", async () => {
  await withDom(async (root) => {
    const w = signal(0);
    const tick = signal(0);
    let resolve!: (m: { default: ComponentFn }) => void;
    const Lazy = lazy(() => new Promise((r) => (resolve = r)));
    const Wrapper = () => h("section", null, [String(w.value), h(Lazy, null)]);
    const App = () =>
      h("div", null, [
        String(tick.value),
        h(Suspense, { fallback: "loading" }, [h(C(Wrapper), null)]),
      ]);
    const hd = mount(root, C(App));
    for (let i = 1; i <= 20; i++) {
      tick.set(i);
      hd._flush();
    }
    assertEquals(root.innerHTML, "<div>20loading</div>");
    assertEquals(subs(w) <= 1, true, `w subscribers while pending: ${subs(w)}`);
    resolve({ default: C(() => h("p", null, ["loaded"])) });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    hd._flush();
    assertEquals(
      root.innerHTML,
      "<div>20<section>0<p>loaded</p></section></div>",
    );
    assertEquals(subs(w), 1, "exactly the live wrapper");
    _unmount(hd);
    assertEquals(subs(w), 0);
  });
});

Deno.test("discarded subtree: a boundary that fell back INSIDE work an outer boundary discarded is disposed too", async () => {
  await withDom(async (root) => {
    const w = signal(0);
    const tick = signal(0);
    let resolve!: (m: { default: ComponentFn }) => void;
    const Lazy = lazy(() => new Promise((r) => (resolve = r)));
    const Thrower = () => {
      throw new Error("t");
    };
    const Wrapper = () =>
      h("section", null, [String(w.value), h(C(Thrower), null)]);
    const App = () =>
      h("div", null, [
        String(tick.value),
        h(Suspense, { fallback: "loading" }, [
          boundary([h(C(Wrapper), null)]),
          h(Lazy, null),
        ]),
      ]);
    const hd = mount(root, C(App));
    for (let i = 1; i <= 10; i++) {
      tick.set(i);
      hd._flush();
    }
    assertEquals(root.innerHTML, "<div>10loading</div>");
    assertEquals(subs(w) <= 1, true, `w subscribers while pending: ${subs(w)}`);
    resolve({ default: C(() => h("p", null, ["L"])) });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    hd._flush();
    assertEquals(root.innerHTML, "<div>10<i>err:t</i><p>L</p></div>");
    _unmount(hd);
    assertEquals(subs(w), 0);
  });
});

for (const kind of ["ErrorBoundary", "Suspense retry"]) {
  Deno.test(`discarded subtree: a throw that is not a component's (a malformed child) still retires the work — ${kind}`, async () => {
    await withDom((root) => {
      const w = signal(0);
      const tick = signal(0);
      const bad = signal(false);
      const Lazy = lazy(() => new Promise<never>(() => {}));
      const Wrapper = (p: { bad: boolean }) =>
        h("section", null, [
          String(w.value),
          // Not a node — `createDom` throws, and no component body did.
          (p.bad ? { nope: true } : "fine") as unknown as string,
        ]);
      const App = () =>
        h("div", null, [
          String(tick.value),
          kind === "ErrorBoundary"
            ? boundary([h(C(Wrapper), { bad: bad.value })])
            : h(Suspense, { fallback: "loading" }, [
              h(C(Wrapper), { bad: bad.value }),
              h(Lazy, null),
            ]),
        ]);
      const hd = mount(root, C(App));
      bad.set(true);
      tick.set(1);
      hd._flush();
      assertEquals(
        kind === "ErrorBoundary"
          ? root.innerHTML.startsWith("<div>1<i>err:")
          : root.innerHTML === "<div>1loading</div>",
        true,
        root.innerHTML,
      );
      for (let i = 2; i <= 20; i++) {
        tick.set(i);
        hd._flush();
      }
      assertEquals(subs(w) <= 1, true, `w subscribers: ${subs(w)}`);
      _unmount(hd);
      assertEquals(subs(w), 0);
    });
  });
}

Deno.test("discarded subtree: keyed list items that rendered before the one that threw are disposed", async () => {
  await withDom((root) => {
    const w = signal(0);
    const tick = signal(0);
    const Item = (p: { id: number }) => {
      const v = w.value;
      if (p.id === 3) throw new Error("bad");
      return h("li", null, [`${p.id}:${v}`]);
    };
    const App = () =>
      h("div", null, [
        String(tick.value),
        boundary([
          h("ul", null, [1, 2, 3, 4].map((id) => h(C(Item), { key: id, id }))),
        ]),
      ]);
    const hd = mount(root, C(App));
    tick.set(1);
    hd._flush();
    // The thrower's own read and its discarded siblings' are both lent to the
    // owner — a fixed number, never one more per retry.
    const lent = subs(w);
    assertEquals(lent <= 2, true, `w subscribers after one retry: ${lent}`);
    for (let i = 2; i <= 20; i++) {
      tick.set(i);
      hd._flush();
    }
    assertEquals(subs(w), lent);
    _unmount(hd);
    assertEquals(subs(w), 0);
  });
});

Deno.test("discarded subtree: recovering and throwing again, over and over, leaves nothing behind", async () => {
  await withDom((root) => {
    const ready = signal(false);
    const w = signal(0);
    const tick = signal(0);
    const Thrower = () => {
      if (!ready.value) throw new Error("x");
      return "ok";
    };
    const Wrapper = () =>
      h("section", null, [String(w.value), h(C(Thrower), null)]);
    const App = () =>
      h("div", null, [String(tick.value), boundary([h(C(Wrapper), null)])]);
    const hd = mount(root, C(App));
    for (let k = 0; k < 10; k++) {
      ready.set(true);
      hd._flush();
      assertEquals(root.innerHTML, `<div>${k}<section>0ok</section></div>`);
      ready.set(false);
      hd._flush();
      tick.set(k + 1);
      hd._flush();
    }
    assertEquals(subs(w) <= 1, true, `w subscribers: ${subs(w)}`);
    _unmount(hd);
    assertEquals([subs(w), subs(ready)], [0, 0]);
  });
});

Deno.test("discarded subtree: signal children and signal attributes are unbound", async () => {
  await withDom((root) => {
    const w = signal("a");
    const tick = signal(0);
    const Thrower = () => {
      throw new Error("x");
    };
    const App = () =>
      h("div", null, [
        String(tick.value),
        boundary([
          h("span", { title: w }, [w as unknown as string]),
          h(C(Thrower), null),
        ]),
      ]);
    const hd = mount(root, C(App));
    for (let i = 1; i <= 20; i++) {
      tick.set(i);
      hd._flush();
    }
    assertEquals(subs(w), 0);
    _unmount(hd);
    assertEquals(subs(w), 0);
  });
});

Deno.test("discarded subtree: a ref is not left holding a detached element", async () => {
  await withDom((root) => {
    const tick = signal(0);
    const ref = { current: null as unknown };
    const Thrower = () => {
      throw new Error("x");
    };
    const App = () =>
      h("div", null, [
        String(tick.value),
        boundary([h("span", { ref }), h(C(Thrower), null)]),
      ]);
    const hd = mount(root, C(App));
    assertEquals(ref.current, null);
    tick.set(1);
    hd._flush();
    assertEquals(ref.current, null);
    _unmount(hd);
  });
});

Deno.test("discarded subtree: a signal only the discarded WRAPPER read still brings the boundary back", async () => {
  await withDom((root) => {
    const mode = signal("bad");
    const Thrower = (p: { mode: string }) => {
      if (p.mode === "bad") throw new Error("bad");
      return h("p", null, ["loaded"]);
    };
    const Wrapper = () =>
      h("section", null, [h(C(Thrower), { mode: mode.value })]);
    const App = () => h("div", null, [boundary([h(C(Wrapper), null)])]);
    const hd = mount(root, C(App));
    assertEquals(root.innerHTML, "<div><i>err:bad</i></div>");
    mode.set("good");
    hd._flush();
    assertEquals(root.innerHTML, "<div><section><p>loaded</p></section></div>");
    _unmount(hd);
    assertEquals(subs(mode), 0);
  });
});

Deno.test("discarded subtree: a fallback that re-renders a child it replaced keeps that child live", async () => {
  await withDom((root) => {
    const w = signal(0);
    const Ok = () => h("b", null, [String(w.value)]);
    const Thrower = () => {
      throw new Error("x");
    };
    const App = () => {
      const ok = h(C(Ok), null);
      return h("div", null, [
        h(ErrorBoundary, { fallback: () => h(Fragment, null, [ok]) }, [
          ok,
          h(C(Thrower), null),
        ]),
      ]);
    };
    const hd = mount(root, C(App));
    assertEquals(root.innerHTML, "<div><b>0</b></div>");
    w.set(1);
    hd._flush();
    assertEquals(root.innerHTML, "<div><b>1</b></div>");
    _unmount(hd);
    assertEquals(subs(w), 0);
  });
});

for (const where of ["the component itself", "a child the boundary catches"]) {
  Deno.test(`discarded subtree: useResource is closed when ${where} throws on the first render`, async () => {
    await withDom(async (root) => {
      const ready = signal(false);
      const show = signal(true);
      const opened: string[] = [];
      const closed: string[] = [];
      const Child = () => {
        if (!ready.value) throw new Error("not ready");
        return "ok";
      };
      const Cam = () => {
        const cam = useResource({
          key: () => "cam",
          open: (k) => {
            opened.push(String(k));
            return { k };
          },
          close: (_v, k) => {
            closed.push(String(k));
          },
        });
        if (where === "the component itself" && !ready.value) {
          throw new Error("not ready");
        }
        return h("p", null, [String(cam.value?.k), h(C(Child), null)]);
      };
      const App = () =>
        h("div", null, [show.value ? boundary([h(C(Cam), null)]) : "off"]);
      const hd = mount(root, C(App));
      assertEquals(root.innerHTML, "<div><i>err:not ready</i></div>");
      assertEquals(
        _openResourceCount(),
        0,
        "the failed render's open is released",
      );
      ready.set(true);
      hd._flush();
      assertEquals(_openResourceCount(), 1);
      show.set(false);
      hd._flush();
      assertEquals(root.innerHTML, "<div>off</div>");
      // An open that had not landed closes when it does — one turn later.
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(
        _openResourceCount(),
        0,
        `opened ${opened} closed ${closed}`,
      );
      assertEquals(opened.length, closed.length);
      _unmount(hd);
    });
  });
}
