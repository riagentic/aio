// Surface names are FROZEN: a test or an `am trigger` that addressed a name
// must keep reaching the same element after an upgrade.
//
// 1. Field and Modal wire their label/hint/title ids from an id sequence of
//    their own. Taken from `useId()`, every app id after the first Field moved
//    — and an unlabeled RadioGroup's name is derived from its id
//    (`AioRadioRc0Radio` became `AioRadioRc1Radio`).
// 2. A shown ErrorBoundary fallback is named AFTER the rest of its component,
//    so a later sibling that already owned `RetryButton` keeps it.
// 3. The handles reserved for a component are read from what is ON SCREEN —
//    a `t` in the boundary's unmounted children no longer pushes the
//    fallback's own name to an ordinal.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { ErrorBoundary, h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  useId,
} from "../src/air/aio-renderer.ts";
import { closeWindow } from "../src/testing/close-window.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { Field, Input, Modal, RadioGroup } from "../src/ui/mod.ts";
import type { UISurfaceNode } from "../src/air/ui-surface.ts";

function names(n: UISurfaceNode | null): string[] {
  const out: string[] = [];
  const walk = (x: UISurfaceNode) => {
    for (const e of x.elements) out.push(e.name);
    for (const c of x.children) walk(c);
  };
  if (n) walk(n);
  return out;
}

const quiet = async (fn: () => Promise<void>) => {
  const realError = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = realError;
  }
};

Deno.test("surface: Field/Modal wiring ids leave an unlabeled RadioGroup's name where it was", async () => {
  const noop = () => {};
  const View = () =>
    h(
      "div",
      null,
      h(Modal, { open: false, title: h("b", null, "T"), onClose: noop }),
      h(
        Field,
        { label: "Size", hint: "pick one" },
        h(RadioGroup, {
          value: "s",
          options: [{ value: "s" }, { value: "m" }],
          onChange: noop,
        }),
      ),
      h(
        Field,
        { label: "Tier" },
        h(RadioGroup, {
          value: "a",
          options: [{ value: "a", label: "Alpha" }],
          onChange: noop,
        }),
      ),
      h(RadioGroup, {
        "aria-label": "Mode",
        value: "x",
        options: [{ value: "x" }],
        onChange: noop,
      }),
    );
  await using ui = await testUI(View);
  assertEquals(
    names(ui.surface()),
    ["AioRadioRc0Radio", "AioRadioRc0Radio2", "AlphaRadio", "AioRadioRc2Radio"],
  );
});

Deno.test("Field wiring ids: hydrate keeps the server's, and app useId() numbers do not move", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const Own = () => h("i", { id: useId() });
    const App = () =>
      h(
        "div",
        null,
        h(Field, { label: "Email", hint: "h" }, h(Input, {})),
        h(Own, null),
      );
    const html = renderToString(h(App, null));
    const host = doc.createElement("div");
    host.innerHTML = html;
    doc.body.appendChild(host);
    const read = () => ({
      label: host.querySelector("label")!.getAttribute("for"),
      input: host.querySelector("input")!.id,
      hint: host.querySelector(".aio-field__hint")!.id,
      own: host.querySelector("i")!.id,
    });
    const server = read();
    assertEquals(server.own, ":r0:", "the Field drew none of the app's ids");
    assertEquals(server.label, server.input);
    const input = host.querySelector("input");
    const root = hydrate(host, () => h(App, null));
    assertEquals(read(), server, "hydrate reproduced the server's ids");
    assertEquals(host.querySelector("input"), input, "adopted, not rebuilt");
    _unmount(root);
  } finally {
    await closeWindow(win);
  }
});

Deno.test("surface: a fallback's Retry never takes a sibling's RetryButton", async () => {
  let hit = "";
  const Boom = () => {
    throw new Error("x");
  };
  const View = () =>
    h(
      "div",
      null,
      h(ErrorBoundary, {
        fallback: () =>
          h("button", { onClick: () => hit = "fallback" }, "Retry"),
      }, h(Boom, null)),
      h("button", { onClick: () => hit = "sibling" }, "Retry"),
    );
  await quiet(async () => {
    await using ui = await testUI(View);
    await ui.settle();
    assertEquals(names(ui.surface()), ["RetryButton", "RetryButton2"]);
    ui.RetryButton.click();
    await ui.settle();
    assertEquals(hit, "sibling", "RetryButton is the name the sibling had");
    ui.RetryButton2.click();
    await ui.settle();
    assertEquals(hit, "fallback");
  });
});

Deno.test("surface: a handle in a boundary's UNMOUNTED children reserves nothing", async () => {
  const Boom = () => {
    throw new Error("x");
  };
  const View = () =>
    h(
      ErrorBoundary,
      { fallback: () => h("button", { onClick: () => {} }, "Retry") },
      h(
        "div",
        null,
        h("button", { t: "RetryButton", onClick: () => {} }, "Again"),
        h(Boom, null),
      ),
    );
  await quiet(async () => {
    await using ui = await testUI(View);
    await ui.settle();
    assertEquals(names(ui.surface()), ["RetryButton"]);
  });
});
