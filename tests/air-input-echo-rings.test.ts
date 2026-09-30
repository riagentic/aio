// The keystroke-echo ring is PER PROPERTY, not one ring per element.
//
// A controlled input remembers what it EMITTED so a render carrying an older
// keystroke does not regress the field (see `_echoRing`). The ring used to be
// one per element and keyed by whichever property asked first, so on a
// `<input type="checkbox">` — which carries BOTH `value` and `checked` —
// `_echoKey("checked", true)` and `_echoKey("value", "true")` are the same
// string (Boolean lookup vs String). A `value` write of "true"/"false" after a
// toggle was then read as a stale keystroke echo and SKIPPED: the DOM kept the
// old value while the model held the new one.
import { assert } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _writeProp } from "../src/air/prop-write.ts";

/** happy-dom's boxed element, with the two properties this test drives. */
type Box = { checked: boolean; focus(): void };

/** A `checked` write after `inputs` toggles of the checkbox; did it land? */
async function checkedWriteLands(
  value: string,
  inputs: number,
): Promise<boolean> {
  const win = new Window({ url: "http://localhost/" });
  try {
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<input id="cb" type="checkbox" value="${value}">`;
    const el = doc.getElementById("cb") as unknown as HTMLElement & Box;
    el.focus();
    _writeProp(el, "value", value);
    const EventCtor = (win as unknown as { Event: typeof Event }).Event;
    for (let i = 0; i < inputs; i++) {
      el.checked = true;
      el.dispatchEvent(new EventCtor("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    }
    el.checked = false;
    _writeProp(el, "checked", true);
    return el.checked;
  } finally {
    await closeWindow(win);
  }
}

Deno.test('controlled checkbox: a `value` write of "true" does not eat a `checked` write', async () => {
  assert(await checkedWriteLands("true", 0), "control (no toggles) must land");
  assert(
    await checkedWriteLands("true", 2),
    'a value of "true" collided with the checked echo and skipped the write',
  );
  assert(await checkedWriteLands("false", 2), 'the "false" pair too');
  // A value that cannot collide still lands, unchanged.
  assert(await checkedWriteLands("on", 2));
  assert(await checkedWriteLands("TRUE", 2));
});
