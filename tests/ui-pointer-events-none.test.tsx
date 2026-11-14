// `pointer-events: none` makes an element — and, since it inherits, its whole
// subtree unless a descendant sets it back — unreachable by the mouse: a
// browser's click lands on whatever is beneath and the element's onClick never
// runs. It is a common "disabled look" for a div-button, and testUI's click
// fired the handler anyway, so a dead button passed its test. The keyboard
// still reaches it (Tab + Enter), so only pointer gestures refuse.
import "./store-sandbox.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  pointerEventsNoneReason,
  triggerAction,
} from "../src/air/ui-trigger.ts";

const fired: string[] = [];
const log = (s: string) => () => fired.push(s);

function Panel() {
  return (
    <div>
      <div
        class="button"
        t="Direct"
        style="pointer-events:none"
        onClick={log("direct")}
        onDblClick={log("direct-dbl")}
        onMouseEnter={log("direct-hover")}
        onKeyDown={log("direct-key")}
        tabIndex={0}
      >
        direct
      </div>
      <section style="pointer-events:none">
        <button type="button" t="Inherited" onClick={log("inherited")}>
          inherited
        </button>
        <button
          type="button"
          t="SetBack"
          style="pointer-events:auto"
          onClick={log("setback")}
        >
          set back
        </button>
        <div draggable t="Src" onDragStart={log("drag")}>src</div>
      </section>
      <div t="Dst" onDrop={log("drop")}>dst</div>
      <div draggable t="Free" onDragStart={log("free-drag")}>free</div>
    </div>
  );
}

testUI(
  Panel,
  "pointer gestures refuse a pointer-events:none element",
  async (ui) => {
    fired.length = 0;
    const direct = await assertRejects(async () => {
      ui.Direct.click();
      await ui.settle();
    });
    assert(
      (direct as Error).message.includes(
        'testUI: cannot click "Direct" — the mouse cannot reach the div: it has `pointer-events: none`',
      ),
      (direct as Error).message,
    );
    const inh = await assertRejects(async () => {
      ui.Inherited.click();
      await ui.settle();
    });
    assert(
      (inh as Error).message.includes(
        "`pointer-events: none` on the enclosing <section>, which it inherits",
      ),
      (inh as Error).message,
    );
    await assertRejects(async () => {
      ui.Direct.dblclick();
      await ui.settle();
    });
    await assertRejects(async () => {
      ui.Direct.hover();
      await ui.settle();
    });
    // Dragging FROM it and dropping ONTO it are both mouse gestures.
    await assertRejects(async () => {
      ui.Src.dragTo(ui.Dst);
      await ui.settle();
    });
    await assertRejects(async () => {
      ui.Free.dragTo(ui.Direct);
      await ui.settle();
    });
    assertEquals(fired, [], "no refused gesture reached a handler");

    // A descendant that sets it back takes the click, as in a browser…
    ui.SetBack.click();
    // …and the keyboard still reaches the element itself.
    ui.Direct.press("Enter");
    await ui.settle();
    assertEquals(fired, ["setback", "direct-key"]);
  },
);

Deno.test("pointerEventsNoneReason reads the nearest value", async () => {
  const { Window } = await import("happy-dom");
  const w = new Window();
  const d = w.document;
  d.body.innerHTML = `<div id="a" style="pointer-events:none">` +
    `<p><b id="b">x</b><i id="c" style="pointer-events:auto">y</i></p></div>` +
    `<span id="d">z</span>`;
  // deno-lint-ignore no-explicit-any
  const $ = (id: string) => d.getElementById(id) as any;
  assertEquals(
    pointerEventsNoneReason($("a")),
    "it has `pointer-events: none`",
  );
  assert(pointerEventsNoneReason($("b"))!.includes("enclosing <div>"));
  assertEquals(pointerEventsNoneReason($("c")), null);
  assertEquals(pointerEventsNoneReason($("d")), null);
  // The tier `am trigger` drives refuses a click and a hover the same way.
  let clicked = 0;
  $("b").addEventListener("click", () => clicked++);
  assertThrows(
    () => triggerAction($("b"), "click"),
    Error,
    "mouse cannot reach",
  );
  assertThrows(
    () => triggerAction($("b"), "hover"),
    Error,
    "mouse cannot reach",
  );
  assertEquals(clicked, 0);
  await closeWindow(w);
});
