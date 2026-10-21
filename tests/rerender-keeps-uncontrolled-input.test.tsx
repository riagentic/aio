// A re-render of the component that OWNS a focused, uncontrolled `<input>`
// keeps the same element, its typed value, its caret/selection and focus —
// measured here, because docs/ui/air-forms.md states it as a guarantee.
import { assert, assertEquals } from "@std/assert";
import { signal } from "aio/air";
import { testUI } from "aio/testing";

const count = signal(0);
let renders = 0;

function App() {
  renders++;
  const n = count(); // read in the BODY: the whole component re-renders
  return (
    <div>
      <span t="count">{n}</span>
      <input t="field" aria-label="Note" />
      <input t="other" aria-label="Other" defaultValue="x" />
      {n % 2 === 0 ? <b>even</b> : <i>odd</i>}
    </div>
  );
}

testUI(App, "re-render keeps a focused uncontrolled input", async (ui) => {
  count.set(0);
  ui.other.type("yz");
  ui.field.type("hello world");
  await ui.settle();
  const doc = ui.window.document;
  const el = doc.querySelector("input") as HTMLInputElement;
  el.focus();
  el.setSelectionRange(2, 5);
  const before = renders;
  for (let i = 1; i <= 3; i++) {
    count.set(i);
    await ui.settle();
    assertEquals(ui.count.text, String(i));
  }
  assertEquals(renders - before, 3, "the component did not re-render");
  const now = doc.querySelector("input") as HTMLInputElement;
  assert(now === el, "the input element was replaced");
  assertEquals(now.value, "hello world");
  assertEquals([now.selectionStart, now.selectionEnd], [2, 5]);
  assert(doc.activeElement === now, "focus was lost");
  assertEquals(ui.other.value, "xyz"); // defaultValue is never re-applied
});
