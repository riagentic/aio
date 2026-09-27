// useMemo/useCallback document React semantics — "recomputes when a dep
// changes (`Object.is`, length first)" (src/air/compat.ts) — but compared with
// `===`. A NaN dep (parseFloat of an empty field, a failed Number(...)) was
// then "changed" on EVERY render: useMemo recomputed forever, and useCallback
// handed out a fresh identity each render, so the useEffect that depends on it
// tore down and re-subscribed on every unrelated re-render — useEffect in the
// same file used Object.is and did not. All deps hooks now share ONE decider,
// `_depsChanged` in compat.ts.
import { assertEquals } from "@std/assert";
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

Deno.test("useMemo: a NaN dep that did not change does not recompute (Object.is)", async () => {
  await withDom(async (root) => {
    const tick = signal(0);
    let computes = 0;
    const App = () => {
      void tick.value;
      const v = useMemo(() => {
        computes++;
        return 1;
      }, [NaN]);
      return h("div", null, [String(v)]);
    };
    const handle = mount(root, App as never);
    try {
      for (let i = 1; i <= 3; i++) {
        tick.set(i);
        handle._flush();
      }
      assertEquals(computes, 1, "Object.is(NaN, NaN) — deps unchanged");
    } finally {
      _unmount(handle);
    }
  });
});

Deno.test("useCallback: a NaN dep keeps the callback stable, so its effect runs once", async () => {
  await withDom(async (root) => {
    const tick = signal(0);
    let subs = 0, unsubs = 0;
    const App = () => {
      void tick.value;
      const amount = parseFloat(""); // NaN while the field is empty
      const cb = useCallback(() => amount, [amount]);
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
      assertEquals([subs, unsubs], [1, 0]);
    } finally {
      _unmount(handle);
    }
  });
});
