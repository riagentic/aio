import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import type { VNode } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import {
  _resetModalStack,
  Modal,
  Pagination,
  RadioGroup,
  Tabs,
} from "../src/ui/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function run(
  app: () => VNode,
  body: (
    t: {
      doc: Any;
      root: Any;
      win: Any;
      key: (el: Any, k: string, i?: Any) => Any;
      settle: () => Promise<void>;
    },
  ) => Promise<void>,
): Promise<void> {
  _resetModalStack();
  const win = new Window({ url: "http://localhost/" }) as Any;
  const doc = win.document as Any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const handle = mount(root, app as never) as Any;
  const settle = async () => {
    handle._flush();
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
  };
  const key = (el: Any, k: string, init: Record<string, unknown> = {}) => {
    const e = new win.KeyboardEvent("keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    el.dispatchEvent(e);
    return e;
  };
  try {
    await settle();
    await body({ doc, root, win, key, settle });
  } finally {
    _unmount(handle);
    _resetModalStack();
    await closeWindow(win);
  }
}

Deno.test("LEAD Tabs: active tab becomes disabled -> a reachable tab stop remains", async () => {
  const dis = signal(false);
  await run(() =>
    h(Tabs as never, {
      label: "S",
      tabs: [
        { id: "a", label: "A", disabled: dis.value },
        { id: "b", label: "B" },
      ],
    }), async ({ root, settle }) => {
    dis.set(true);
    await settle();
    const btns = [...root.querySelectorAll('[role="tab"]')] as Any[];
    const reachable = btns.filter((b) => !b.disabled && b.tabIndex === 0);
    assertEquals(
      reachable.length,
      1,
      btns.map((b) => `${b.textContent}:ti=${b.tabIndex},dis=${b.disabled}`)
        .join(" "),
    );
  });
});

Deno.test("LEAD Tabs SSR: controlled value naming a disabled tab", () => {
  const html = renderToString(
    h(Tabs as never, {
      value: "a",
      tabs: [{ id: "a", label: "A", disabled: true }, { id: "b", label: "B" }],
    }),
  );
  const stops = [...html.matchAll(/<button([^>]*)>([^<]*)</gi)].filter((m) =>
    /tabindex="0"/i.test(m[1]!) && !/disabled/i.test(m[1]!)
  );
  assertEquals(stops.length, 1, html);
});

Deno.test("LEAD Pagination pages=0 page=0", async () => {
  const calls: number[] = [];
  await run(
    () =>
      h(Pagination as never, {
        page: 0,
        pages: 0,
        onPage: (p: number) => calls.push(p),
      }),
    async ({ root }) => {
      const btns = [...root.querySelectorAll("button")] as Any[];
      console.log(
        btns.map((b) => `${b.getAttribute("aria-label")} dis=${b.disabled}`),
      );
      for (const b of btns) b.click();
      assertEquals(calls, [], "no pages: nothing to navigate to");
    },
  );
});

Deno.test("LEAD Modal initial focus: a later checked radio, not the first unchecked", async () => {
  await run(() =>
    h(Modal as never, {
      open: true,
      title: "T",
      onClose: () => {},
      children: h(RadioGroup as never, {
        label: "Env",
        value: "b",
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      }),
    }), async ({ doc, settle }) => {
    await settle();
    const a = doc.activeElement;
    assertEquals(a?.value, "b", `focused ${a?.tagName} value=${a?.value}`);
  });
});
