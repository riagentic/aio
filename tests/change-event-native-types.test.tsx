// `onChange` is remapped to `input` for React migrants — except where `change`
// IS the event.
//
// For a FILE input "the user picked a file" is the `change` event; there is no
// keystroke stream for `input` to be the better answer to. A real picker fires
// both, so the remap looked harmless in a browser — and under `testUI` a test
// dispatching `change` saw nothing at all, with the handler "simply never
// firing" (a field report). The framework's rule is fail loud, never silent,
// and this was the one place it broke.
import { assertEquals } from "@std/assert";
import { signal } from "aio/air";
import { testUI } from "aio/testing";

const fired = signal<string[]>([]);
const note = (s: string) => fired.set([...fired(), s]);

function App() {
  return (
    <div>
      <input t="file" type="file" onChange={() => note("file")} />
      {
        /* A checkbox keeps the remap: `input` fires alongside `change` in every
          browser, so remapping is harmless there — and narrowing it broke
          examples/todo under testUI, which is the harness diverging from
          production rather than the fix this file is about. */
      }
      <input t="check" type="checkbox" onChange={() => note("check")} />
      {
        /* A text input KEEPS the React behaviour — that is the whole point of
          the remap, and it must not regress. */
      }
      <input t="text" type="text" onChange={() => note("text")} />
    </div>
  );
}

testUI(App, "a file input's onChange listens to `change`", async (ui) => {
  fired.set([]);
  const el = ui.file.info._el as unknown as HTMLElement;
  el.dispatchEvent(
    new el.ownerDocument!.defaultView!.Event("change", {
      bubbles: true,
    }),
  );
  await ui.settle();
  assertEquals(fired(), ["file"]);
});

testUI(App, "a checkbox keeps the React-compat remap", async (ui) => {
  fired.set([]);
  await ui.check.check();
  await ui.settle();
  assertEquals(fired(), ["check"]);
});

testUI(App, "a text input keeps React's per-keystroke onChange", async (ui) => {
  // The remap earns its keep here: `input` fires on every character, which is
  // what a React migrant expects `onChange` to do.
  fired.set([]);
  await ui.text.type("ab");
  await ui.settle();
  assertEquals(fired(), ["text", "text"]);
});

// The same element, its props in the OTHER order. `applyProps` walks props in
// source order and asked the ELEMENT for its type when it mapped `onChange` —
// with `onChange` written before `type="file"` the element still said
// `type="text"`, so the handler was wired to `input` and the picker's `change`
// went nowhere. Two spellings of one component, two different elements.
function OrderApp() {
  return (
    <div>
      <input t="early" onChange={() => note("early")} type="file" />
    </div>
  );
}

testUI(
  OrderApp,
  'onChange written BEFORE type="file" still listens to `change`',
  async (ui) => {
    fired.set([]);
    const el = ui.early.info._el as unknown as HTMLElement;
    const Ev = el.ownerDocument!.defaultView!.Event;
    el.dispatchEvent(new Ev("change", { bubbles: true }));
    await ui.settle();
    assertEquals(fired(), ["early"], "`change` reaches the handler");
    el.dispatchEvent(new Ev("input", { bubbles: true }));
    await ui.settle();
    assertEquals(fired(), ["early"], "…and `input` is not what it listens to");
  },
);
