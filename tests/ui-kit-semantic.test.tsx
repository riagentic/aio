// The kit's promise, pinned: EVERY component of `aio/ui` is drivable and
// observable through the semantic surface — no DOM selectors, no positional
// `ui.find("Field", 1)` — and the harness is never more permissive than the
// browser it stands in for.
//
// Each block below failed on main before the fix it names:
//
//  1. `<Field label="Email">` named nothing. A sibling `<label>` with no
//     `for`/`id` associates with nothing, so the control was `Input`, `Input2`,
//     … — a two-field form was addressable only positionally, in the kit's own
//     headline example (and announced as unnamed by a screen reader).
//  2. `<Checkbox label="Enable LAN">` was `Checkbox`, `Checkbox2`, …: the
//     wrapping `<label>` DOES name it in HTML, but the surface only read a
//     label's DIRECT string children — and a wrapping label never has any.
//  3. `<Pagination>` rendered "‹"/"›": punctuation names nothing, so prev and
//     next came out as `Button` and `Button2`.
//  4. Typing into a READONLY input mutated it — a test could prove a value a
//     user cannot enter. The harness must be the strictest environment.
//  5. `select("nope")` on a `<select>` silently reset it to "" (DOM spec) and
//     ran the change handler with the empty string.
//  6. `am trigger` shared the trigger module but NOT its guards, so the live
//     tier clicked disabled buttons and typed into readonly inputs and answered
//     `ok: true` — two tiers, one promise ("a test and an `am` session behave
//     identically"), two behaviours.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { runUITrigger } from "../src/air/ui-remote.ts";
import {
  _resetToasts,
  Checkbox,
  Confirm,
  Field,
  Input,
  Modal,
  Pagination,
  Select,
  Table,
  Textarea,
  toast,
  ToastHost,
} from "../src/ui/mod.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// ── 1. Field names its control ───────────────────────────────────────

Deno.test("kit: Field's label names its control (semantic, not positional)", async () => {
  const seen: Record<string, string> = {
    name: "",
    email: "",
    bio: "",
    pick: "",
  };
  const App = () =>
    h(
      "div",
      null,
      h(
        Field,
        { label: "Name" },
        h(Input, { onInput: (v: string) => seen.name = v }),
      ),
      h(
        Field,
        { label: "Email" },
        h(Input, { onInput: (v: string) => seen.email = v }),
      ),
      h(
        Field,
        { label: "Bio" },
        h(Textarea, { onInput: (v: string) => seen.bio = v }),
      ),
      h(
        Field,
        { label: "Colour" },
        h(Select, {
          options: ["red", "blue"],
          onChange: (v: string) => seen.pick = v,
        }),
      ),
    );
  await using ui = await testUI(App as ComponentFn);
  // Addressable by LABEL + ROLE, from anywhere — the whole point of the kit.
  await ui.NameInput.type("Ada");
  await ui.EmailInput.type("ada@x.dev");
  await ui.BioInput.type("hi");
  await ui.ColourSelect.select("blue");
  assertEquals(seen, {
    name: "Ada",
    email: "ada@x.dev",
    bio: "hi",
    pick: "blue",
  });
  // …and observable.
  assertEquals(ui.NameInput.value, "Ada");
  assertEquals(ui.EmailInput.value, "ada@x.dev");
  // The accessible name is real, not a test-only affordance.
  assert(ui.html().includes('aria-label="Email"'), ui.html());
});

Deno.test("kit: an explicit t/aria-label on the control still wins over Field", async () => {
  const App = () =>
    h(
      "div",
      null,
      h(Field, { label: "Name" }, h(Input, { t: "who", onInput: () => {} })),
      h(
        Field,
        { label: "Mail" },
        h(Input, { "aria-label": "Work mail", onInput: () => {} }),
      ),
    );
  await using ui = await testUI(App as ComponentFn);
  await ui.who.type("x");
  assertEquals(ui.who.value, "x");
  await ui.WorkMailInput.type("y");
  assertEquals(ui.WorkMailInput.value, "y");
});

// ── 2. A wrapping <label> names the first labelable thing inside it ──

Deno.test("kit: Checkbox's label names the box; both instances stay distinct", async () => {
  const state: Record<string, boolean> = { lan: false, dark: true };
  const App = () =>
    h(
      "div",
      null,
      h(Checkbox, {
        label: "Enable LAN",
        checked: state.lan,
        onChange: (c: boolean) => state.lan = c,
      }),
      h(Checkbox, {
        label: "Dark mode",
        checked: state.dark,
        onChange: (c: boolean) => state.dark = c,
      }),
    );
  await using ui = await testUI(App as ComponentFn);
  assertEquals(ui.EnableLANCheckbox.checked, false);
  assertEquals(ui.DarkModeCheckbox.checked, true);
  await ui.EnableLANCheckbox.check();
  await ui.DarkModeCheckbox.uncheck();
  assertEquals(state, { lan: true, dark: false });
});

Deno.test("surface: a wrapping <label> names its FIRST labelable descendant only", async () => {
  const App = () =>
    h(
      "form",
      null,
      h(
        "label",
        null,
        "Full name",
        h("input", { onInput: () => {} }),
        // A second control under the same label is NOT named by it (HTML
        // associates a label with one control), so it keeps its own identity.
        h("input", { placeholder: "Nickname", onInput: () => {} }),
      ),
    );
  await using ui = await testUI(App as ComponentFn);
  await ui.FullNameInput.type("Ada");
  await ui.NicknameInput.type("A");
  assertEquals(ui.FullNameInput.value, "Ada");
  assertEquals(ui.NicknameInput.value, "A");
});

// ── 3. Pagination / Table / Modal are drivable by name ───────────────

Deno.test("kit: Pagination's prev/next/pages are named, not Button and Button2", async () => {
  const seen: number[] = [];
  const App = () =>
    h(Pagination, { page: 3, pages: 9, onPage: (p: number) => seen.push(p) });
  await using ui = await testUI(App as ComponentFn);
  await ui.PreviousPageButton.click();
  await ui.NextPageButton.click();
  await ui.Page5Button.click();
  assertEquals(seen, [2, 4, 5]);
});

Deno.test("kit: Pagination's edge button is disabled and fails loud when driven", async () => {
  const App = () => h(Pagination, { page: 1, pages: 3, onPage: () => {} });
  const ui = await testUI(App as ComponentFn);
  try {
    assertEquals(ui.PreviousPageButton.disabled, true);
    assertEquals(ui.NextPageButton.disabled, false);
    const e = await assertRejects(() => ui.PreviousPageButton.click(), Error);
    assert(e.message.includes("is disabled"), e.message);
  } finally {
    await ui.dispose();
  }
});

Deno.test("kit: a clickable Table row is a Row, and every row is drivable", async () => {
  const clicked: string[] = [];
  const rows = [{ id: "a", name: "Ada" }, { id: "b", name: "Bob" }];
  const App = () =>
    h(Table, {
      columns: [{ key: "name" }],
      rows,
      getKey: (r: { id: string }) => r.id,
      onRowClick: (r: { id: string }) => clicked.push(r.id),
    });
  await using ui = await testUI(App as ComponentFn);
  await ui.Table.Row.click();
  await ui.Table.Row2.click();
  assertEquals(clicked, ["a", "b"]);
});

Deno.test("kit: Modal's backdrop is addressable and its ARIA sits on the box", async () => {
  let closed = 0;
  const App = () =>
    h(Modal, { open: true, title: "Danger", onClose: () => closed++ }, "body");
  await using ui = await testUI(App as ComponentFn);
  const html = ui.html();
  // role="dialog"/aria-modal describe the DIALOG, not the overlay around it.
  assert(
    /<div class="aio-modal" role="dialog" aria-modal="true"/.test(html),
    html,
  );
  await ui.modalBackdrop.click();
  assertEquals(closed, 1);
});

Deno.test("kit: Confirm is drivable end to end through the surface", async () => {
  let confirmed = 0, cancelled = 0;
  const App = () =>
    h(Confirm, {
      open: true,
      message: "Delete it?",
      onConfirm: () => confirmed++,
      onCancel: () => cancelled++,
    });
  await using ui = await testUI(App as ComponentFn);
  await ui.CancelButton.click();
  await ui.ConfirmButton.click();
  assertEquals([confirmed, cancelled], [1, 1]);
});

Deno.test("kit: Checkbox without a label keeps the caller's class", async () => {
  const App = () =>
    h("div", null, h(Checkbox, { class: "mine", checked: false }));
  await using ui = await testUI(App as ComponentFn);
  assert(ui.html().includes("aio-checkbox mine"), ui.html());
});

// ── 4./5. The harness is never more permissive than a browser ────────

Deno.test("harness: a readonly input refuses type/setValue/clear, loudly", async () => {
  let inputs = 0;
  const App = () =>
    h("input", {
      t: "pinned",
      readOnly: true,
      value: "locked",
      onInput: () => inputs++,
    });
  const ui = await testUI(App as ComponentFn);
  try {
    assertEquals(ui.pinned.readonly, true);
    for (
      const act of [
        () => ui.pinned.type("x"),
        () => ui.pinned.setValue("x"),
        () => ui.pinned.clear(),
      ]
    ) {
      const e = await assertRejects(act, Error);
      assert(e.message.includes("is readonly"), e.message);
    }
    assertEquals(ui.pinned.value, "locked", "value must be untouched");
    assertEquals(inputs, 0, "no input event may have fired");
  } finally {
    await ui.dispose();
  }
});

Deno.test("harness: select() refuses a value with no option, and a disabled one", async () => {
  const picked: string[] = [];
  const App = () =>
    h(
      "div",
      null,
      h(Select, {
        t: "sel",
        options: ["red", { value: "blue", disabled: true }],
        value: "red",
        onChange: (v: string) => picked.push(v),
      }),
      h("input", { t: "txt", onInput: () => {} }),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    const miss = await assertRejects(() => ui.sel.select("green"), Error);
    assert(miss.message.includes("no such option"), miss.message);
    assert(miss.message.includes('"red"'), miss.message); // lists what exists
    const off = await assertRejects(() => ui.sel.select("blue"), Error);
    assert(off.message.includes("disabled"), off.message);
    // …and select() on something that is not a <select> says so.
    const wrong = await assertRejects(() => ui.txt.select("red"), Error);
    assert(wrong.message.includes("only a <select>"), wrong.message);
    assertEquals(picked, [], "no change handler may have run");
    assertEquals(ui.sel.value, "red", "the select must be untouched");
    await ui.sel.select("red");
  } finally {
    await ui.dispose();
  }
});

Deno.test("harness: check()/uncheck() on something with no checked state fails loud", async () => {
  let clicks = 0;
  const App = () => h("button", { onClick: () => clicks++ }, "Save");
  const ui = await testUI(App as ComponentFn);
  try {
    const e = await assertRejects(() => ui.SaveButton.check(), Error);
    assert(e.message.includes("no checked state"), e.message);
    assertEquals(clicks, 0, "check() must not have clicked a plain button");
  } finally {
    await ui.dispose();
  }
});

// ── 6. Both tiers enforce the same rule ──────────────────────────────

Deno.test("parity: am trigger refuses what testUI refuses (one decider)", async () => {
  let fired = 0;
  const App = () =>
    h(
      "div",
      null,
      h(
        "button",
        { t: "locked", disabled: true, onClick: () => fired++ },
        "Go",
      ),
      h("input", {
        t: "ro",
        readOnly: true,
        value: "keep",
        onInput: () => fired++,
      }),
      h(
        "select",
        { t: "sel", onChange: () => fired++ },
        h("option", {
          value: "a",
        }, "A"),
      ),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    const root = ui.surface().component;
    const click = await runUITrigger({
      path: `${root}:locked`,
      action: "click",
    });
    assertEquals(click.ok, false, JSON.stringify(click));
    assert(String(click.error).includes("is disabled"), String(click.error));

    const type = await runUITrigger({
      path: `${root}:ro`,
      action: "type",
      text: "x",
    });
    assertEquals(type.ok, false, JSON.stringify(type));
    assert(String(type.error).includes("is readonly"), String(type.error));

    const sel = await runUITrigger({
      path: `${root}:sel`,
      action: "select",
      text: "zzz",
    });
    assertEquals(sel.ok, false, JSON.stringify(sel));
    assert(String(sel.error).includes("no such option"), String(sel.error));

    assertEquals(fired, 0, "no refused action may have reached a handler");
    assertEquals(ui.ro.value, "keep");
    // The allowed action still works through the same tier.
    const ok = await runUITrigger({
      path: `${root}:sel`,
      action: "select",
      text: "a",
    });
    assertEquals(ok.ok, true, JSON.stringify(ok));
    assertEquals(fired, 1);
  } finally {
    await ui.dispose();
  }
});

// ── Toast: the mechanism the docs can actually promise ───────────────

Deno.test("kit: a toast auto-dismisses on its own duration", async () => {
  _resetToasts();
  const App = () => h(ToastHost, null);
  const ui = await testUI(App as ComponentFn);
  try {
    // `toast()` uses the platform clock, NOT the cell schedule clock — so
    // `ui.advance()` cannot dismiss it, and the docs must not say it can.
    toast("sticky", { duration: 60_000 });
    await ui.waitFor(() => ui.html().includes("sticky"), "toast shows");
    await ui.advance(600_000);
    assert(
      ui.html().includes("sticky"),
      "advance() does not drive toast timers",
    );
    // What DOES work: the toast's own duration, on real time.
    toast("saved", { variant: "success", duration: 20 });
    await ui.waitFor(() => ui.html().includes("saved"), "second toast shows");
    await ui.waitFor(
      () => !ui.html().includes("saved"),
      "toast auto-dismissed",
    );
    assert(ui.html().includes("sticky"), "only the expired toast goes");
  } finally {
    await ui.dispose();
    _resetToasts();
  }
});

// ── Randomized reachability: nothing on screen is unreachable ────────

// Every interactive element the renderer put on screen MUST be addressable and
// drivable through the semantic surface — that is the kit's whole contract, and
// it is a property, not a set of examples. Random component trees, deterministic
// seed (printed on failure so a sweep's find is replayable).
const SEED = fuzzEnvInt("UIKIT_FUZZ_SEED", 20260805, 1);
const TREES = fuzzEnvInt("UIKIT_FUZZ_TREES", 24, 1);

Deno.test("fuzz: every interactive element is reachable and drivable by name", async () => {
  let seed = SEED;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const WORDS = [
    "Save",
    "Delete",
    "Name",
    "Email",
    "Rôle ✓",
    "Enable LAN",
    "3D view",
  ];

  let elements = 0;
  for (let tree = 0; tree < TREES; tree++) {
    const label = () => pick(WORDS);
    // A leaf renders one interactive thing, in one of the kit's shapes.
    const leaf = (): VNode => {
      switch (Math.floor(rnd() * 8)) {
        case 0:
          return h("button", { onClick: () => {} }, label());
        case 1:
          return h(Field, { label: label() }, h(Input, { onInput: () => {} }));
        case 2:
          return h(Checkbox, {
            label: label(),
            checked: false,
            onChange: () => {},
          });
        case 3:
          return h(
            Field,
            { label: label() },
            h(Select, { options: ["a", "b"], onChange: () => {} }),
          );
        case 4:
          return h("div", { class: "button", onClick: () => {} }, label());
        case 5:
          return h(
            Field,
            { label: label() },
            h(Textarea, { onInput: () => {} }),
          );
        case 6:
          return h("label", null, label(), h("input", { onInput: () => {} }));
        default:
          return h("button", { t: `h${Math.floor(rnd() * 1e6)}` }, label());
      }
    };
    const Leafy = () => h("div", null, leaf(), leaf());
    const Middle = () => h("section", null, h(Leafy, null), leaf());
    const App = () =>
      h(
        "div",
        null,
        ...Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
          h(pick([Leafy, Middle]) as ComponentFn, null)),
      );
    await using ui = await testUI(App as ComponentFn);
    const where = `seed=${SEED} tree=${tree}`;

    // Flatten the surface in tree order — the SAME order the documented
    // ordinal escape hatch uses ("Leafy ×2 — use Leafy2 for the 2nd").
    type Node = {
      component: string;
      path: string;
      elements: { name: string; tag: string }[];
      children: Node[];
    };
    const flat: Node[] = [];
    const collect = (n: Node) => {
      flat.push(n);
      n.children.forEach(collect);
    };
    collect(ui.surface() as Node);

    const seenOfName = new Map<string, number>();
    for (const node of flat) {
      const nth = seenOfName.get(node.component) ?? 0;
      seenOfName.set(node.component, nth + 1);
      // Address the instance exactly as the error messages tell a reader to.
      const comp = nth === 0
        ? ui[node.component]
        : ui[`${node.component}${nth + 1}`];
      for (const el of node.elements) {
        elements++;
        assert(el.name.length > 0, `${where}: unnamed element on ${node.path}`);
        const handle = comp[el.name];
        // Observable: the four state booleans + text resolve without throwing.
        assertEquals(
          typeof handle.disabled,
          "boolean",
          `${where}: ${node.path}:${el.name} is not resolvable`,
        );
        assertEquals(typeof handle.checked, "boolean", `${where}: ${el.name}`);
        assertEquals(typeof handle.text, "string", `${where}: ${el.name}.text`);
        assertEquals(handle.info.tag, el.tag, `${where}: ${el.name}.info`);
        // Drivable: the gesture its kind of control actually accepts.
        const tag = el.tag;
        if (tag === "select") await handle.select("a");
        else if (
          handle.checked === true || handle.info.events.includes("change")
        ) {
          await handle.click();
        } else if (tag === "input" || tag === "textarea") {
          await handle.type("a");
        } else await handle.click();
      }
    }
  }
  assert(elements >= TREES, `fuzz produced too few elements: ${elements}`);
});
