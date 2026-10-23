// The kit's form wiring, as a browser and a screen reader see it.
//
// • Field: the label activates its control (`for` → id), the error/hint are
//   announced with it (`aria-describedby`), an error marks it invalid
//   (`aria-invalid`) — they were sibling text and nothing more (measured in
//   headless Chromium: clicking "Bio" focused nothing).
// • Input/Select/Textarea `invalid` reaches assistive tech, not only the CSS.
// • Modal: a JSX title still names the dialog.
// • The browser cell stub: an Event the method does not declare a parameter
//   for (`onClick={c.reset}`, `<Input onInput={c.setName}>`) no longer trips
//   the wire's "server receives DIFFERENT values" warning — in a real browser
//   it fired for every kit control wired to a cell method.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import {
  Checkbox,
  Field,
  Input,
  Modal,
  RadioGroup,
  Select,
  Textarea,
} from "../src/ui/mod.ts";
import { cell as browserCell } from "../src/browser/protocol-cell.ts";
import { actionWireTrip } from "../src/state/action-encode.ts";
import { plainUnreadEvents } from "../src/state/event-arg.ts";

// deno-lint-ignore no-explicit-any
type Doc = any;

async function render(view: () => ReturnType<typeof h>) {
  const win = new Window();
  const ui = await testUI(view, { document: win.document as Doc });
  return { ui, doc: win.document as unknown as Document, win };
}

/** Closes the window AFTER the ui handle (declared first, disposed last). */
const shut = (win: Window) => ({
  [Symbol.asyncDispose]: () => closeWindow(win),
});

Deno.test("Field: the label targets the control, error is described and invalid", async () => {
  const { ui, doc, win } = await render(() =>
    h(Field, { label: "Email", error: "Required" }, h(Input, { value: "" }))
  );
  await using _w = shut(win);
  await using _ = ui;
  const label = doc.querySelector("label.aio-field__label")!;
  const input = doc.querySelector("input")!;
  const forId = label.getAttribute("for");
  assert(forId, "label has no `for`");
  assertEquals(input.id, forId);
  assertEquals(input.getAttribute("aria-invalid"), "true");
  const desc = input.getAttribute("aria-describedby")!;
  assertEquals(doc.getElementById(desc)?.textContent, "Required");
});

Deno.test("Field: a hint is described; the caller's id and aria-* win", async () => {
  const { ui, doc, win } = await render(() =>
    h(
      Field,
      { label: "Name", hint: "As on the card" },
      h(Textarea, { id: "mine", "aria-describedby": "elsewhere" }),
    )
  );
  await using _w = shut(win);
  await using _ = ui;
  const ta = doc.querySelector("textarea")!;
  assertEquals(ta.id, "mine");
  assertEquals(
    doc.querySelector("label.aio-field__label")!.getAttribute("for"),
    "mine",
  );
  assertEquals(ta.getAttribute("aria-describedby"), "elsewhere");
  assertEquals(ta.getAttribute("aria-invalid"), null);

  const two = await render(() =>
    h(Field, { label: "Role", hint: "Pick one" }, h(Select, { options: ["a"] }))
  );
  await using _w2 = shut(two.win);
  await using _2 = two.ui;
  const sel = two.doc.querySelector("select")!;
  assertEquals(
    two.doc.getElementById(sel.getAttribute("aria-describedby")!)?.textContent,
    "Pick one",
  );
});

Deno.test("Field: no `for` onto a group or a self-labelled checkbox", async () => {
  const { ui, doc, win } = await render(() =>
    h(
      "div",
      null,
      h(
        Field,
        { label: "Plan", error: "Pick a plan" },
        h(RadioGroup, { options: [{ value: "a", label: "A" }] }),
      ),
      h(Field, { label: "Notifications" }, h(Checkbox, { label: "Email me" })),
    )
  );
  await using _w = shut(win);
  await using _ = ui;
  const labels = doc.querySelectorAll("label.aio-field__label");
  assertEquals(labels[0]!.getAttribute("for"), null);
  assertEquals(labels[1]!.getAttribute("for"), null);
  const group = doc.querySelector('[role="group"]')!;
  assertEquals(group.getAttribute("aria-invalid"), null);
  assertEquals(
    doc.getElementById(group.getAttribute("aria-describedby")!)?.textContent,
    "Pick a plan",
  );
});

Deno.test("Input/Select/Textarea: `invalid` sets aria-invalid; an explicit one wins", async () => {
  const { ui, doc, win } = await render(() =>
    h(
      "div",
      null,
      h(Input, { invalid: true, "aria-label": "a" }),
      h(Select, { invalid: true, options: ["a"], "aria-label": "b" }),
      h(Textarea, { invalid: true, "aria-label": "c" }),
      h(Input, { invalid: true, "aria-invalid": "grammar", "aria-label": "d" }),
      h(Input, { "aria-label": "e" }),
    )
  );
  await using _w = shut(win);
  await using _ = ui;
  const got = [...doc.querySelectorAll("input,select,textarea")].map((e) =>
    e.getAttribute("aria-invalid")
  );
  assertEquals(got, ["true", "true", "true", "grammar", null]);
});

Deno.test("Modal: a JSX title names the dialog through aria-labelledby", async () => {
  const { ui, doc, win } = await render(() =>
    h(Modal, { open: true, title: h("b", null, "Delete it?") }, "body")
  );
  await using _w = shut(win);
  await using _ = ui;
  const dialog = doc.querySelector('[role="dialog"]')!;
  const id = dialog.getAttribute("aria-labelledby");
  assert(id, "dialog has no name");
  assertEquals(doc.getElementById(id)?.textContent, "Delete it?");
});

// ── The browser stub and an Event the method never reads ──────────────

function fakeEvent(type: string): Event {
  // The shape `isDomEvent` recognises in any realm.
  return {
    type,
    isTrusted: true,
    currentTarget: null,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as Event;
}

Deno.test("browser stub: an undeclared Event crosses the wire as it always did, with no loss reported", () => {
  const c = browserCell("evarg-probe", {
    state: { name: "", n: 0 },
    methods: {
      setName(s: { name: string }, v: string) {
        s.name = v;
      },
      reset(s: { n: number }) {
        s.n = 0;
      },
      take(s: { name: string }, v: unknown) {
        s.name = String(v);
      },
    },
  }) as unknown as {
    __aio: {
      actions: Record<
        string,
        (...a: unknown[]) => { type: string; payload: unknown }
      >;
    };
  };
  const act = c.__aio.actions;
  for (
    const a of [
      act.setName!("x", fakeEvent("input")),
      act.reset!(fakeEvent("click")),
    ]
  ) {
    assertEquals(actionWireTrip(a).lossy, [], a.type);
  }
  // The frame the server decodes is the one an Event always produced.
  const sent = actionWireTrip(act.setName!("x", fakeEvent("input")));
  assertEquals(sent.payload, { args: ["x", { isTrusted: true }] });
  // An Event in a DECLARED parameter is a real bug and still says so.
  const bad = actionWireTrip(act.take!(fakeEvent("click")));
  assert(bad.lossy.length > 0, "declared Event slot lost its warning");
});

Deno.test("plainUnreadEvents: arity unknown (rest param) or no Event — unchanged", () => {
  const ev = fakeEvent("click");
  const args = [1, ev];
  assert(
    plainUnreadEvents((_s: unknown, ..._r: unknown[]) => {}, args) === args,
  );
  const plain = ["a"];
  assert(plainUnreadEvents((_s: unknown) => {}, plain) === plain);
  assertEquals(plainUnreadEvents((_s: unknown, _a: unknown) => {}, args), [
    1,
    { isTrusted: true },
  ]);
});
