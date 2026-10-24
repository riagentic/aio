// A raw controlled `<input>` whose STABLE handler stores later (a debounce)
// lost what was typed to any unrelated render of its parent in between: the
// prop had not changed, the DOM had, so the render re-asserted the old value
// under the user's fingers. A field typed into within the last second whose
// keystrokes started no call keeps the text while its prop is unchanged;
// a CHANGED prop still wins, and a same-task refusal still snaps back.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withField(
  app: () => unknown,
  fn: (el: HTMLInputElement, type: (ch: string) => void) => Promise<void>,
): Promise<void> {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _setDocument(doc);
  // deno-lint-ignore no-explicit-any
  const W = win as any;
  // deno-lint-ignore no-explicit-any
  const handle = mount(root, app as any);
  const el = root.querySelector("#q") as HTMLInputElement;
  el.focus();
  const type = (ch: string) => {
    el.value += ch;
    el.dispatchEvent(new W.InputEvent("input", { bubbles: true }));
  };
  try {
    await fn(el, type);
  } finally {
    _unmount(handle);
    await closeWindow(win);
  }
}

Deno.test("debounced raw input: an unrelated parent render keeps the typed text", async () => {
  const q = signal("");
  const tick = signal(0);
  let t: ReturnType<typeof setTimeout> | undefined;
  const onInput = (e: Event) => { // stable: one function for every render
    const v = (e.target as HTMLInputElement).value;
    clearTimeout(t);
    t = setTimeout(() => q.set(v), 200);
  };
  await withField(
    () =>
      h(
        "div",
        null,
        h("input", { id: "q", value: q.value, onInput }),
        h("i", null, String(tick.value)),
      ),
    async (el, type) => {
      type("a");
      type("b");
      await sleep(20);
      tick.set(1); // the clock / a sibling re-renders the parent
      await sleep(20);
      assertEquals(el.value, "ab", "the render must not eat the keys");
      await sleep(300);
      assertEquals(q.peek(), "ab");
      assertEquals(el.value, "ab");
    },
  );
});

Deno.test("debounced raw input: a CHANGED prop still wins (a reset)", async () => {
  const q = signal("x");
  const onInput = () => {};
  await withField(
    () => h("input", { id: "q", value: q.value, onInput }),
    async (el, type) => {
      type("y");
      q.set(""); // the app resets the field
      await sleep(20);
      assertEquals(el.value, "");
    },
  );
});

Deno.test("raw input: a same-task refusal still snaps back", async () => {
  const q = signal("");
  await withField(
    () =>
      h("input", {
        id: "q",
        value: q.value,
        onInput: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          q.set(v.replace(/[^0-9]/g, "")); // digits only
        },
      }),
    async (el, type) => {
      type("1");
      type("x");
      await sleep(20);
      assertEquals(el.value, "1");
    },
  );
});
