// The React compat layer's deps arrays must mean what React's mean.
//
// `useEffect` on this surface promises "Deps are honored (React semantics)"
// and compares with `Object.is`. Two of its neighbours broke that promise from
// opposite sides:
//
//   useCallback  returned `fn` UNCHANGED — "unnecessary in AIR, components are
//                auto-optimized". True of rendering, false of IDENTITY, and
//                identity is what a deps array compares. A fresh arrow every
//                render is a changed dep every render.
//   useMemo      compared deps ELEMENT-WISE only, so a shrinking array whose
//                surviving prefix matched was judged unchanged — and returned
//                a stale VALUE, not just a missed optimisation. Its twin
//                `useEffect` already compared lengths; two deciders, one
//                question, one half done.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { useCallback, useEffect, useMemo } from "../src/air/compat.ts";

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

Deno.test("useCallback: a stable callback does not re-run the effect that depends on it", async () => {
  await withDom(async (root) => {
    const tick = signal(0);
    let subs = 0, unsubs = 0;
    const App = () => {
      void tick.value;
      const cb = useCallback(() => {}, []);
      useEffect(() => {
        subs++;
        return () => {
          unsubs++;
        };
      }, [cb]);
      return h("div", null, [String(tick.value)]);
    };
    const handle = mount(root, App as never);
    try {
      for (let i = 1; i <= 3; i++) {
        tick.set(i);
        handle._flush();
        await new Promise((r) => setTimeout(r, 0));
      }
      assertEquals(
        [subs, unsubs],
        [1, 0],
        "an empty deps array means ONE subscription — a fresh arrow every " +
          "render turned a one-shot effect into a per-render teardown",
      );
    } finally {
      _unmount(handle);
    }
  });
});

Deno.test("useCallback: a callback whose deps CHANGE gets a new identity", async () => {
  // The other direction — returning one frozen function forever would pass the
  // test above and break every effect that is supposed to re-run.
  await withDom(async (root) => {
    const which = signal(0);
    const seen: unknown[] = [];
    const App = () => {
      const n = which.value;
      const cb = useCallback(() => n, [n]);
      useEffect(() => {
        seen.push(cb);
      }, [cb]);
      return h("div", null, [String(n)]);
    };
    const handle = mount(root, App as never);
    try {
      which.set(1);
      handle._flush();
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(seen.length, 2, "a changed dep must give a new callback");
      assert(seen[0] !== seen[1], "…and it must be a different function");
    } finally {
      _unmount(handle);
    }
  });
});

Deno.test("useMemo: a deps array that SHRINKS recomputes", async () => {
  await withDom(async (root) => {
    const n = signal(3);
    let computes = 0;
    const seen: number[] = [];
    const App = () => {
      const deps = Array.from({ length: n.value }, (_, i) => i);
      const v = useMemo(() => {
        computes++;
        return deps.length;
      }, deps);
      seen.push(v);
      return h("div", null, [String(v)]);
    };
    const handle = mount(root, App as never);
    try {
      n.set(2);
      handle._flush();
      assertEquals(
        seen[seen.length - 1],
        2,
        "the memo returned a value the deps contradict — deps [0,1,2] → " +
          "[0,1] must recompute, not keep 3",
      );
      assertEquals(computes, 2);
    } finally {
      _unmount(handle);
    }
  });
});

Deno.test("useMemo: unchanged deps still skip the work", async () => {
  // The control — a memo that recomputed every time would pass the test above
  // and delete the feature.
  await withDom(async (root) => {
    const tick = signal(0);
    let computes = 0;
    const App = () => {
      void tick.value;
      const v = useMemo(() => {
        computes++;
        return 7;
      }, [1, 2]);
      return h("div", null, [String(v)]);
    };
    const handle = mount(root, App as never);
    try {
      for (let i = 1; i <= 3; i++) {
        tick.set(i);
        handle._flush();
      }
      assertEquals(computes, 1, "stable deps must compute once");
    } finally {
      _unmount(handle);
    }
  });
});
