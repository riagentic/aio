// A submit button's surface entry used to list NO events, so an agent picking
// a trigger target off `am surface` read the one button that works as inert.
//
// MEASURED on `examples/todo` before the fix (a real `am` session):
//   am surface --json → {"name":"AddButton","tag":"button","events":[], …}
//   am trigger "App:AddButton" click → ok, and the todo was added.
// The surface and the trigger disagreed about the same button. `<button>` in a
// form is type="submit" by default, so this is the most common control on any
// form-shaped page.
//
// The rule now has ONE home — `isSubmitControl` in ui-trigger.ts — read by the
// trigger (to find the button implicit submission clicks) and by the surface
// (to report the form's `submit` on it). The last test below is the one that
// makes a second copy impossible to ship: it CLICKS every control in the form
// and requires the surface's answer to equal what actually ran.
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { getLiveSurfaces, runUITrigger } from "../src/air/ui-remote.ts";
import type { UIElementInfo } from "../src/air/ui-surface.ts";
import { isSubmitControl } from "../src/air/ui-trigger.ts";

let submits = 0;
let clicks = 0;

function Form() {
  return (
    <form
      onSubmit={(e: Event) => {
        e.preventDefault();
        submits++;
      }}
    >
      <input aria-label="Title" />
      {/* No `type` — HTML makes this the form's submit button. */}
      <button>Add</button>
      <button type="submit">Save</button>
      <button type="button" onClick={() => clicks++}>Cancel</button>
      <input type="submit" aria-label="Go" />
    </form>
  );
}

/** A `<button>` that is not in any form drives nothing but its own handler. */
function Loose() {
  return (
    <div>
      <button t="Lone">Lone</button>
      <form>
        <button t="Plain">Plain</button>
      </form>
    </div>
  );
}

function elements(): UIElementInfo[] {
  const out: UIElementInfo[] = [];
  const walk = (n: { elements: UIElementInfo[]; children: unknown[] }) => {
    out.push(...n.elements);
    for (const c of n.children) walk(c as typeof n);
  };
  for (const r of getLiveSurfaces()) walk(r);
  return out;
}

const byName = (name: string): UIElementInfo => {
  const el = elements().find((e) => e.name === name);
  assert(el, `no "${name}" on the surface: ${elements().map((e) => e.name)}`);
  return el;
};

testUI(Form, "surface: a submit button carries the form's submit", (_ui) => {
  // The form still owns the handler — this is an INHERITED event, not a moved
  // one, and both entries say so.
  assertEquals(byName("Form").events, ["submit"]);
  // `<button>` with no type: the default that surprises everyone.
  assertEquals(byName("AddButton").events, ["submit"]);
  // …and the explicit spellings.
  assertEquals(byName("SaveButton").events, ["submit"]);
  assertEquals(byName("GoButton").events, ["submit"]);
  // type="button" is not a submit control: its own handler, and nothing else.
  assertEquals(byName("CancelButton").events, ["click"]);
});

Deno.test("isSubmitControl — HTML's rule, the one both tiers read", () => {
  assert(isSubmitControl("button", undefined)); // the default that surprises
  assert(isSubmitControl("BUTTON", "SUBMIT"));
  assert(!isSubmitControl("button", "button"));
  assert(!isSubmitControl("button", "reset"));
  assert(isSubmitControl("input", "submit"));
  assert(isSubmitControl("input", "image"));
  assert(!isSubmitControl("input", undefined)); // an <input> defaults to text
  assert(!isSubmitControl("div", undefined));
});

testUI(Loose, "surface: no form, or no onSubmit, adds nothing", (_ui) => {
  // A submit button outside any form submits nothing.
  assertEquals(byName("Lone").events, []);
  // A form with no onSubmit handles no submit — claiming one would be the
  // same lie pointed the other way.
  assertEquals(byName("Plain").events, []);
});

testUI(
  Form,
  "surface: what it lists is what a click actually runs",
  async (ui) => {
    // THE anti-drift test. For every control in the form, the surface's claim
    // is checked against the observed effect of the real gesture — so a second
    // copy of the rule (or a surface that guesses) fails here, not in a field
    // report.
    const controls = elements().filter((e) =>
      e.tag === "button" || (e.tag === "input" && e.name.endsWith("Button"))
    );
    assertEquals(controls.length, 4, controls.map((c) => c.name).join(", "));
    for (const el of controls) {
      const before = submits;
      const r = await runUITrigger({ path: el.path, action: "click" });
      assert(r.ok, `${el.path}: ${r.error}`);
      await ui.settle();
      const ran = submits > before;
      assertEquals(
        ran,
        el.events.includes("submit"),
        `${el.name} lists ${JSON.stringify(el.events)} but clicking it ${
          ran ? "DID" : "did not"
        } run the form's onSubmit`,
      );
    }
    assert(clicks > 0, "the type=button control still ran its own onClick");
  },
);

// HTML's OTHER association: `form="<id>"` names the form a control belongs to,
// wherever the control sits, and OVERRIDES nesting. The walk carries the
// ENCLOSING `<form>` down the tree, which answers neither shape that uses the
// attribute — a submit button in a sticky footer or a dialog action bar,
// outside the form it drives, and a button inside one form that drives
// another.
//
// MEASURED in Chromium (`--headless --dump-dom`, each button clicked in turn,
// each form's `submit` logged):
//
//   <button> in <form id=real>              -> real
//   <button form=other> in <form id=real>   -> other      (NOT the one it sits in)
//   <button form=real> outside every form   -> real
//
// and before this, `am surface` said `[]` for the third — the same "the
// surface reads the button that works as inert" defect isSubmitControl was
// written for, in the one case nesting cannot see — and `["submit"]` for the
// second, naming a form that button does not drive.
let attrSubmits = 0;

function Attached() {
  return (
    <div>
      <form
        id="real"
        onSubmit={(e: Event) => {
          e.preventDefault();
          attrSubmits++;
        }}
      >
        <button t="Inside">Inside</button>
        {/* belongs to #other, which handles nothing */}
        <button t="Elsewhere" type="submit" form="other">Elsewhere</button>
      </form>
      <form id="other">
        <span>no handler</span>
      </form>
      {/* outside every form, and the one that drives #real */}
      <button t="Outside" form="real">Outside</button>
    </div>
  );
}

testUI(
  Attached,
  'surface: form="id" decides which form a control drives',
  async (ui) => {
    // Nesting still answers when nothing overrides it.
    assertEquals(byName("Inside").events, ["submit"]);
    // The attribute overrides nesting: this one drives #other, which handles
    // nothing. (happy-dom resolves `form` to the ANCESTOR when there is one,
    // so the click below would submit #real here and in no real browser —
    // the surface follows HTML, which Chromium was measured against above.)
    assertEquals(byName("Elsewhere").events, []);
    // …and the case a click can prove in this harness too: outside every
    // form, driving the one it names.
    const outside = byName("Outside");
    assertEquals(outside.events, ["submit"]);
    const before = attrSubmits;
    const r = await runUITrigger({ path: outside.path, action: "click" });
    assert(r.ok, `${outside.path}: ${r.error}`);
    await ui.settle();
    assert(
      attrSubmits > before,
      "the surface claimed submit for a button whose click ran nothing",
    );
  },
);
