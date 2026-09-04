// `onChange` is remapped to `input` for React migrants — unless `onInput` sits
// beside it (AIO-166), in which case it keeps native `change`. So the EVENT
// NAME an `onChange` registers under depends on its neighbours, and the two
// share the `input` slot of the per-element listener map.
//
// The diff skipped a prop whose handler was the same function as last render,
// so an `onChange` whose NAME had moved stayed registered under the old one:
//  * `onInput` ARRIVING beside a stable `onChange` — the new `input` entry
//    overwrote the change handler's, which never fired again;
//  * `onInput` LEAVING — the change handler stayed on native `change` and
//    fired on blur instead of per keystroke;
//  * `onInput={undefined}` counted as present (`"onInput" in props`), flipping
//    a lone `onChange` to blur semantics.
// All three silent. One rule now: a moved name is a new registration, and
// `onChange` is written after `onInput` so it never deletes the slot `onInput`
// just took.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, cleanup: () => win.happyDOM.close() };
}

function fire(doc: Document, el: Element, name: string): void {
  el.dispatchEvent(
    // deno-lint-ignore no-explicit-any
    new (doc.defaultView as any).Event(name, { bubbles: true }),
  );
}

Deno.test({
  name:
    "onChange keeps firing when onInput is ADDED beside it (stable handler)",
  async fn() {
    const { doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const log: string[] = [];
    const change = () => log.push("change");
    const input = () => log.push("input");
    const live = signal(false);
    const App = () =>
      h("input", {
        "aria-label": "x",
        onChange: change,
        ...(live.value ? { onInput: input } : {}),
      });
    const handle = mount(root, App);
    const el = root.querySelector("input")!;

    fire(doc, el, "input");
    assertEquals(log, ["change"], "alone, onChange is per keystroke");

    live.set(true);
    handle._flush();
    log.length = 0;
    fire(doc, el, "input");
    fire(doc, el, "change");
    assertEquals(
      log,
      ["input", "change"],
      "with onInput beside it, onChange listens to native `change` and " +
        "onInput to `input` — neither lost, neither doubled",
    );

    live.set(false);
    handle._flush();
    log.length = 0;
    fire(doc, el, "input");
    fire(doc, el, "change");
    assertEquals(
      log,
      ["change"],
      "onInput gone: onChange is back on `input` (per keystroke), and the " +
        "native `change` registration is retired",
    );

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name:
    "onChange keeps firing when onInput is REMOVED beside it (stable handler)",
  async fn() {
    const { doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const log: string[] = [];
    const change = () => log.push("change");
    const input = () => log.push("input");
    const live = signal(true);
    const App = () =>
      h("input", {
        "aria-label": "x",
        ...(live.value ? { onInput: input } : {}),
        onChange: change,
      });
    const handle = mount(root, App);
    const el = root.querySelector("input")!;
    fire(doc, el, "input");
    fire(doc, el, "change");
    assertEquals(log, ["input", "change"]);

    live.set(false);
    handle._flush();
    log.length = 0;
    fire(doc, el, "input");
    assertEquals(log, ["change"], "onChange fires per keystroke again");
    fire(doc, el, "change");
    assertEquals(log, ["change"], "…and not a second time on blur");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "onInput={undefined} is absent: onChange stays per keystroke",
  async fn() {
    const { doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const log: string[] = [];
    const change = () => log.push("change");
    const gen = signal(0);
    const App = () =>
      h(
        "div",
        null,
        h("span", null, `g:${gen.value}`),
        h("input", {
          "aria-label": "x",
          onInput: undefined, // `cond ? f : undefined` with cond false
          onChange: change,
        }),
      );
    const handle = mount(root, App);
    const el = root.querySelector("input")!;
    fire(doc, el, "input");
    assertEquals(log, ["change"], "fires on `input`, not only on blur");
    gen.set(1); // an unrelated re-render must not disturb the registration
    handle._flush();
    fire(doc, el, "input");
    assertEquals(log, ["change", "change"]);
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "onChange follows a `type` change to file (stable handler)",
  async fn() {
    const { doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const log: string[] = [];
    const change = () => log.push("change");
    const kind = signal("text");
    const App = () =>
      h("input", { "aria-label": "x", onChange: change, type: kind.value });
    const handle = mount(root, App);
    const el = root.querySelector("input")!;
    fire(doc, el, "input");
    assertEquals(log, ["change"]);

    kind.set("file");
    handle._flush();
    log.length = 0;
    fire(doc, el, "change");
    assertEquals(log, ["change"], "a file input's onChange is `change`");
    fire(doc, el, "input");
    assertEquals(log, ["change"], "…and no longer `input`");

    _unmount(handle);
    await cleanup();
  },
});
