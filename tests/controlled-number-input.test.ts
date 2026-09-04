// A controlled NUMERIC input is compared as a number, not as a string.
//
// `_controlDrifted` (prop-write.ts) re-asserts a controlled `value` whenever
// the element no longer shows the state's value — the fix for a handler that
// REFUSES a keystroke. Compared as strings, it also fired on every value the
// user was still in the middle of typing: "1." is how "1.5" begins, the
// handler stores `parseFloat("1.") === 1`, and the next re-render of the
// component (any other write to the cell it reads — a sibling field, a server
// push, a clock) compared "1." to "1", called it drift and wrote "1" back.
// The decimal point vanished under the user's finger; "1.05" could not be
// typed at all. Before the drift check the vnode comparison (`1 === 1`)
// skipped the write, so this is the regression the check introduced.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { _controlDrifted } from "../src/air/prop-write.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, cleanup: () => win.happyDOM.close() };
}

/** What a keystroke does: the DOM holds the typed text, then the handler
 *  runs on `input`. */
function type(doc: Document, input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(
    // deno-lint-ignore no-explicit-any
    new (doc.defaultView as any).Event("input", { bubbles: true }),
  );
}

Deno.test({
  name:
    "controlled number input: a half-typed decimal survives an unrelated re-render",
  async fn() {
    const { doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const qty = signal(0);
    const tick = signal(0); // "anything else the component reads changed"
    let refuseAbove = Infinity;
    const App = () =>
      h(
        "div",
        null,
        h("span", null, `tick:${tick.value}`),
        h("input", {
          type: "number",
          "aria-label": "qty",
          value: qty.value,
          onInput: (e: Event) => {
            const n = parseFloat((e.target as HTMLInputElement).value);
            if (!Number.isNaN(n) && n <= refuseAbove) qty.set(n);
          },
        }),
      );
    const handle = mount(root, App);
    const input = root.querySelector("input") as HTMLInputElement;

    for (
      const [typed, stateAfter] of [["1", 1], ["1.", 1], ["1.0", 1]] as const
    ) {
      type(doc, input, typed);
      handle._flush();
      assertEquals(qty.peek(), stateAfter);
      tick.set(tick.peek() + 1); // a server push / sibling field / clock
      handle._flush();
      assertEquals(
        input.value,
        typed,
        `"${typed}" shows the state's value ${stateAfter} — it must not be ` +
          `rewritten out from under the user`,
      );
    }
    type(doc, input, "1.05");
    handle._flush();
    assertEquals(qty.peek(), 1.05);
    assertEquals(input.value, "1.05");

    // A value the handler REFUSED is still corrected — that is what the drift
    // check is for, and the numeric comparison must not weaken it. The
    // handler declines anything above 5.
    refuseAbove = 5;
    qty.set(2);
    handle._flush();
    assertEquals(input.value, "2");
    type(doc, input, "9");
    handle._flush();
    assertEquals(qty.peek(), 2, "the handler refused 9");
    tick.set(tick.peek() + 1);
    handle._flush();
    assertEquals(input.value, "2", "state 2 wins over a DOM showing 9");

    _unmount(handle);
    await cleanup();
  },
});

// The decider, driven directly across the value shapes a keystroke stream
// produces: every string that PARSES to the state's number is "showing it".
Deno.test({
  name:
    "_controlDrifted: numeric inputs compare by value, text inputs by string",
  async fn() {
    const { doc, cleanup } = createDOM();
    const num = doc.createElement("input") as HTMLInputElement;
    num.setAttribute("type", "number");
    const txt = doc.createElement("input") as HTMLInputElement;
    const rng = doc.createElement("input") as HTMLInputElement;
    rng.setAttribute("type", "range");

    // [dom value, state value, drifted?]
    const cases: [string, unknown, boolean][] = [
      ["1.", 1, false],
      ["1.0", 1, false],
      ["1.50", 1.5, false],
      ["01", 1, false],
      ["-0.5", -0.5, false],
      ["+2", 2, false],
      ["1e2", 100, false],
      ["1.5", "1.50", false], // state as a numeric string
      ["", 1, true], // the element shows nothing, the state has a value
      ["1", "", true], // the state was cleared
      ["1", null, true],
      ["", null, false],
      ["", undefined, false],
      ["2", 1, true], // a genuinely different number
      ["1.5", 1, true],
    ];
    for (const [have, want, drifted] of cases) {
      num.value = have;
      assertEquals(
        _controlDrifted(num, "value", want),
        drifted,
        `number: dom ${JSON.stringify(have)} vs state ${JSON.stringify(want)}`,
      );
    }
    // Ranges are numeric too; happy-dom clamps to [0,100] so stay inside it.
    rng.value = "50";
    assertEquals(_controlDrifted(rng, "value", "50.0"), false);
    assertEquals(_controlDrifted(rng, "value", 51), true);
    // A TEXT input keeps the exact-string rule: "1." and "1" are different.
    txt.value = "1.";
    assertEquals(_controlDrifted(txt, "value", 1), true);
    txt.value = "1";
    assertEquals(_controlDrifted(txt, "value", 1), false);

    // Property: for random numbers and the spellings a keystroke stream
    // passes through, "parses to the same number" is never drift.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 300; i++) {
      const n = Math.round((rnd() * 2000 - 1000) * 1000) / 1000;
      const spellings = [
        String(n),
        n.toFixed(3),
        `${n}${Number.isInteger(n) ? "." : ""}`,
        `${n}${Number.isInteger(n) ? ".0" : "0"}`,
        n >= 0 ? `+${n}` : String(n),
      ];
      for (const s of spellings) {
        num.value = s;
        if (num.value !== s) continue; // the DOM itself refused the spelling
        assertEquals(
          _controlDrifted(num, "value", n),
          false,
          `dom ${JSON.stringify(s)} shows state ${n}`,
        );
      }
      num.value = String(n);
      assertEquals(_controlDrifted(num, "value", n + 1), true);
    }
    await cleanup();
  },
});
