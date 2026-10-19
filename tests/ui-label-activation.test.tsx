// A click on a <label>'s text activates its control the way Chromium does —
// for the trigger's own click. happy-dom ran the activation while the click
// was still bubbling at the label: it toggled the control when the click hit a
// link or button inside the label, ignored a preventDefault() above the label,
// and never focused the control. App code's own `label.click()` keeps the
// DOM's behaviour (nested labels, a handler's programmatic click). Every
// expected value was measured in headless Chromium (synthetic `click()`, the
// way `am trigger` clicks there).
import { assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";

// deno-lint-ignore no-explicit-any
type Ev = any;

const Terms = () => (
  <div onClick={(e: Ev) => e.target?.dataset?.cancel && e.preventDefault()}>
    <label>
      <input type="checkbox" id="agree" t="Agree" />
      <span t="AgreeText">I agree to the</span>
      <a href="#terms" t="TermsLink">terms</a>
      <button type="button" t="HelpButton">?</button>
      <span t="CancelText" data-cancel="1">cancelled</span>
    </label>
    <label>
      <span t="NameText">Name</span>
      <input id="name" t="Name" />
    </label>
  </div>
);

Deno.test("label text: a click toggles the control and focuses it", async () => {
  await using ui = await testUI(Terms);
  ui.AgreeText.click();
  await ui.settle();
  assertEquals(ui.Agree.checked, true);
  assertEquals(ui.document.activeElement?.id, "agree");
  ui.NameText.click();
  await ui.settle();
  assertEquals(ui.document.activeElement?.id, "name");
});

Deno.test("label text: a link or button inside the label does not toggle it", async () => {
  await using ui = await testUI(Terms);
  ui.TermsLink.click();
  await ui.settle();
  assertEquals(ui.Agree.checked, false);
  ui.HelpButton.click();
  await ui.settle();
  assertEquals(ui.Agree.checked, false);
});

Deno.test("label text: a click cancelled above the label does not toggle it", async () => {
  await using ui = await testUI(Terms);
  ui.CancelText.click();
  await ui.settle();
  assertEquals(ui.Agree.checked, false);
});

Deno.test("label text: a modified click and a double click activate it too", async () => {
  await using ui = await testUI(Terms);
  ui.AgreeText.click({ shiftKey: true });
  await ui.settle();
  assertEquals(ui.Agree.checked, true);
  ui.AgreeText.dblclick();
  await ui.settle();
  assertEquals(ui.Agree.checked, true); // two clicks, two toggles
});

const Nested = () => (
  <div>
    <label>
      <span t="OuterText">outer</span>
      <label>
        <span t="InnerText">inner</span>
        <input type="checkbox" t="Inner" />
      </label>
      <input type="checkbox" t="Outer" />
    </label>
    <label for="far">
      <span t="ForText">for</span>
    </label>
    <input type="checkbox" id="far" t="Far" />
    <button
      type="button"
      t="ProgButton"
      onClick={(e: Ev) =>
        e.currentTarget.ownerDocument.querySelector("label[for=far]").click()}
    >
      p
    </button>
    <fieldset disabled>
      <label>
        <span t="OffText">off</span>
        <input type="checkbox" t="Off" />
      </label>
    </fieldset>
  </div>
);

Deno.test("label text: nested labels, for=, a programmatic label.click(), a disabled fieldset", async () => {
  await using ui = await testUI(Nested);
  ui.InnerText.click();
  await ui.settle();
  assertEquals([ui.Inner.checked, ui.Outer.checked], [true, false]);
  // The outer label's control is its FIRST labelable descendant: Inner.
  ui.OuterText.click();
  await ui.settle();
  assertEquals([ui.Inner.checked, ui.Outer.checked], [false, false]);
  ui.ForText.click();
  await ui.settle();
  assertEquals(ui.Far.checked, true);
  ui.ProgButton.click();
  await ui.settle();
  assertEquals(ui.Far.checked, false);
  ui.OffText.click();
  await ui.settle();
  assertEquals(ui.Off.checked, false);
});
