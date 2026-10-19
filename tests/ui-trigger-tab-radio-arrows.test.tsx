// press("Tab") and the arrow keys on a radio do what Chromium does.
//
// Measured with real CDP input in headless Chromium (a three-tier differential:
// happy-dom testUI · Chromium via `am trigger` · Chromium with real keys). Both
// trigger tiers dispatched the keydown/keyup and then did NOTHING: focus stayed
// put, so no `change`/`blur` reached the field being left — an `onBlur`
// validation never ran — and an arrow key on a radio left the group's choice
// unchanged. The expected sequences below are the real-Chromium column.
import { assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { bindInput, useForm } from "../src/air.ts";
import { ConfirmButton, RadioGroup } from "../src/ui/mod.ts";

// deno-lint-ignore no-explicit-any
type Ev = any;

const TYPES = "keydown keyup change input click focus blur".split(" ");

/** Record what Chromium's listener column records: `type:aria-label(key)`. */
function recorder(doc: Ev): string[] {
  const log: string[] = [];
  const name = (t: Ev) =>
    t?.getAttribute?.("aria-label") ?? String(t?.tagName ?? "doc");
  for (const t of TYPES) {
    doc.addEventListener(t, (e: Ev) => {
      log.push(`${t}:${name(e.target)}${e.key ? `(${e.key})` : ""}`);
    }, true);
  }
  return log;
}
const take = (log: string[]) => log.splice(0).join(" | ");
const active = (doc: Ev) =>
  doc.activeElement?.getAttribute?.("aria-label") ??
    String(doc.activeElement?.tagName);

Deno.test("Tab moves focus, committing the field it leaves (change, blur, focus)", async () => {
  const form = useForm({
    email: {
      initial: "",
      rules: [(v: string) => v.includes("@") ? null : "Bad"],
    },
  });
  const App = () => (
    <div>
      <input t="Email" aria-label="email" {...bindInput(form, "email")} />
      {form.fields.email.error && <span t="Err">{form.fields.email.error}
      </span>}
      <input t="Next" aria-label="next" />
    </div>
  );
  await using ui = await testUI(App);
  const doc = ui.window.document;
  ui.Email.click();
  ui.Email.type("q");
  await ui.settle();
  const log = recorder(doc);
  await ui.Email.press("Tab");
  assertEquals(
    take(log),
    "keydown:email(Tab) | change:email | blur:email | focus:next | keyup:next(Tab)",
  );
  assertEquals(active(doc), "next");
  assertEquals(ui.Err.text, "Bad", "onBlur validation ran");
  await ui.Next.press("Tab", { shiftKey: true });
  assertEquals(active(doc), "email");
});

Deno.test("Tab order: positive tabindex first, skips disabled / tabindex=-1 / hidden / inert, leaves the page at the end", async () => {
  const App = () => (
    <div>
      <input t="A" aria-label="a" />
      <button t="Off" aria-label="off" disabled>x</button>
      <span t="Minus" aria-label="minus" tabIndex={-1}>m</span>
      <input t="Gone" aria-label="gone" style={{ display: "none" }} />
      <div {...({ inert: "" } as Ev)}>
        <button aria-label="inert">i</button>
      </div>
      <div t="Zero" aria-label="zero" tabIndex={0}>z</div>
      <a t="Link" aria-label="link" href="#x">l</a>
      <button t="First" aria-label="first" tabIndex={1}>f</button>
    </div>
  );
  await using ui = await testUI(App);
  const doc = ui.window.document;
  await ui.First.focus();
  const byLabel: Record<string, string> = {
    first: "First",
    a: "A",
    zero: "Zero",
    link: "Link",
  };
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    const label = active(doc);
    seen.push(label);
    if (!byLabel[label]) break;
    await (ui as Ev)[byLabel[label]].press("Tab");
  }
  assertEquals(seen, ["first", "a", "zero", "link"]);
  assertEquals(
    active(doc),
    "BODY",
    "Tab past the last control leaves the page",
  );
});

Deno.test("Tab inside a radio group stops once, on the checked radio", async () => {
  const App = () => (
    <div>
      <input t="Before" aria-label="before" />
      <RadioGroup
        label="Plan"
        value="pro"
        options={[
          { value: "free", label: "Free" },
          { value: "pro", label: "Pro" },
          { value: "team", label: "Team" },
        ]}
      />
      <input t="After" aria-label="after" />
    </div>
  );
  await using ui = await testUI(App);
  const doc = ui.window.document;
  await ui.Before.press("Tab");
  assertEquals(active(doc), "Pro");
  await ui.RadioGroup.ProRadio.press("Tab");
  assertEquals(active(doc), "after");
  await ui.After.press("Tab", { shiftKey: true });
  assertEquals(active(doc), "Pro");
});

Deno.test("arrow keys on a radio move the choice: blur, focus, click, input, change — wrapping, skipping disabled", async () => {
  const picks: string[] = [];
  const App = () => (
    <RadioGroup
      label="Plan"
      value="pro"
      onChange={(v) => picks.push(v)}
      options={[
        { value: "free", label: "Free" },
        { value: "pro", label: "Pro" },
        { value: "mid", label: "Mid", disabled: true },
        { value: "team", label: "Team" },
      ]}
    />
  );
  await using ui = await testUI(App);
  const doc = ui.window.document;
  await ui.RadioGroup.ProRadio.focus();
  const log = recorder(doc);
  await ui.RadioGroup.ProRadio.press("ArrowDown");
  assertEquals(
    take(log),
    "keydown:Pro(ArrowDown) | blur:Pro | focus:Team | click:Team | input:Team | change:Team | keyup:Team(ArrowDown)",
  );
  assertEquals(active(doc), "Team");
  await ui.RadioGroup.TeamRadio.press("ArrowRight");
  assertEquals(active(doc), "Free", "wraps");
  await ui.RadioGroup.FreeRadio.press("ArrowUp");
  assertEquals(active(doc), "Team");
  await ui.RadioGroup.TeamRadio.press("ArrowLeft");
  assertEquals(active(doc), "Pro");
  assertEquals(picks, ["team", "free", "team", "pro"]);
});

Deno.test("a handled Tab keydown keeps focus (the kit Modal's trap still wins)", async () => {
  const App = () => (
    <div>
      <ConfirmButton t="Wipe" confirm="Sure?" onConfirm={() => {}}>
        Wipe
      </ConfirmButton>
      <input t="Outside" aria-label="outside" />
    </div>
  );
  await using ui = await testUI(App);
  const doc = ui.window.document;
  ui.Wipe.click();
  await ui.settle();
  assertEquals(doc.activeElement?.textContent, "Cancel");
  await ui.ConfirmButton.CancelButton.press("Tab");
  assertEquals(doc.activeElement?.textContent, "Confirm");
  await ui.ConfirmButton.ConfirmButton.press("Tab");
  assertEquals(
    doc.activeElement?.textContent,
    "Cancel",
    "wrapped by the Modal",
  );
});

Deno.test("Tab from the window moves on from the focused control, or starts at the page's edge", async () => {
  // `ui.window.press("Tab")` is aimed at the document: the Tab default read
  // its ownerDocument (null for a document) and threw a TypeError where
  // 1.0.20 just dispatched the keys.
  const App = () => (
    <div>
      <input t="A" aria-label="a" />
      <input t="B" aria-label="b" />
    </div>
  );
  await using ui = await testUI(App);
  const doc = ui.window.document;
  await (ui as Ev).window.press("Tab");
  assertEquals(active(doc), "a", "nothing focused: the first stop");
  await (ui as Ev).window.press("Tab");
  assertEquals(active(doc), "b");
});

Deno.test("Tab order: a details' summary and an editing host are stops; a closed details hides its content", async () => {
  // Measured in Chromium with real keys: a > sum > ce > z. The harness DOM
  // reports tabIndex -1 for <summary> and for a contenteditable host, and saw
  // the link inside the CLOSED details as shown.
  const App = () => (
    <div>
      <input t="A" aria-label="a" />
      <details>
        <summary aria-label="sum">more</summary>
        <a aria-label="inclosed" href="#in">in</a>
      </details>
      <div aria-label="ce" {...({ contenteditable: "" } as Ev)}>edit</div>
      <input t="Z" aria-label="z" />
    </div>
  );
  await using ui = await testUI(App);
  const doc = ui.window.document;
  ui.A.click();
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    await (ui as Ev).window.press("Tab");
    seen.push(active(doc));
  }
  assertEquals(seen.join(" > "), "sum > ce > z");
});
