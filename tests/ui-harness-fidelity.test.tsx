// The harness must never be MORE PERMISSIVE than the browser it stands in for,
// and both tiers (`testUI` in-process, `am trigger` on a live app) must answer
// from ONE implementation. Each block below failed on main before its fix:
//
//  1. `am trigger … check` had no checkable guard at all: `el.checked` is
//     `undefined` on a <button>, `undefined !== true`, so a "check" CLICKED a
//     real button and reported `{"ok":true}`. `ui.x.check()` refused the same
//     element — two deciders, and an agent driving a live app could destroy
//     data through a word that promises to tick a box.
//  2. A MODIFIED click on a checkbox was a net no-op: the code pre-flipped
//     `el.checked` AND dispatched `click`, whose activation behaviour flips it
//     back. `ui.cb.click({ ctrlKey: true })` left the DOM and the state false.
//     Radio + shift moved the DOM but fired NO input/change handler.
//  3. `onChange` was unreachable from either tier: `type()` fires only `input`
//     and `blur()` fired only `blur`, so `type("ab"); blur()` produced
//     `input,input` — a green test over a handler that never runs in a browser.
//  4. Four things a browser refuses, all reported as success: typing into a
//     <div> (it wrote a `value` expando), typing past `maxLength`, clicking a
//     `display:none` / `hidden` element, and typing into `type="hidden"`.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { runUITrigger } from "../src/air/ui-remote.ts";
import { _resetSurfaceWarnings } from "../src/air/ui-surface.ts";
import { useLocal } from "../src/air.ts";

// ── 1. check()/uncheck(): one guard, both tiers ──────────────────────

Deno.test("check: `am trigger check` refuses a plain button, like testUI does", async () => {
  let clicks = 0;
  const App = () =>
    h(
      "div",
      null,
      h(
        "button",
        { t: "danger", onClick: () => clicks++ },
        "Delete everything",
      ),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    const root = ui.surface().component;
    const res = await runUITrigger({
      path: `${root}:danger`,
      action: "check",
    });
    assertEquals(
      res.ok,
      false,
      "a 'check' on a <button> must refuse — it clicked it instead: " +
        JSON.stringify(res),
    );
    assert(String(res.error).includes("no checked state"), String(res.error));
    assertEquals(clicks, 0, "a refused check must not have clicked anything");

    // …and the in-process tier says the same thing about the same element.
    const e = await assertRejects(() => ui.danger.check(), Error);
    assert(e.message.includes("no checked state"), e.message);
    assertEquals(clicks, 0);
  } finally {
    await ui.dispose();
  }
});

Deno.test("check: both tiers still tick a real checkbox exactly once", async () => {
  const seen: boolean[] = [];
  const App = () =>
    h(
      "div",
      null,
      h("input", {
        t: "box",
        type: "checkbox",
        onChange: (e: { target: { checked: boolean } }) =>
          seen.push(e.target.checked),
      }),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    const root = ui.surface().component;
    const on = await runUITrigger({ path: `${root}:box`, action: "check" });
    assertEquals(on.ok, true, JSON.stringify(on));
    assertEquals(ui.box.checked, true);
    // check() on an already-checked box is a no-op in both tiers.
    const again = await runUITrigger({ path: `${root}:box`, action: "check" });
    assertEquals(again.ok, true, JSON.stringify(again));
    assertEquals(seen, [true], "check() on a checked box must do nothing");
    await ui.box.uncheck();
    assertEquals(ui.box.checked, false);
    assertEquals(seen, [true, false]);
  } finally {
    await ui.dispose();
  }
});

// ── 2. a modified click is a real click ──────────────────────────────

Deno.test("click: ctrl+click on a checkbox toggles it and fires the handler", async () => {
  const changes: boolean[] = [];
  let ctrlSeen = false;
  const App = () =>
    h(
      "div",
      null,
      h("input", {
        t: "cb",
        type: "checkbox",
        onClick: (e: { ctrlKey?: boolean }) => {
          if (e.ctrlKey) ctrlSeen = true;
        },
        onChange: (e: { target: { checked: boolean } }) =>
          changes.push(e.target.checked),
      }),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    await ui.cb.click({ ctrlKey: true });
    assertEquals(ui.cb.checked, true, "a ctrl+click must tick the box");
    assertEquals(changes, [true], "the change handler must run");
    assert(ctrlSeen, "the click handler must see ctrlKey");
    await ui.cb.click({ ctrlKey: true });
    assertEquals(ui.cb.checked, false);
    assertEquals(changes, [true, false]);
  } finally {
    await ui.dispose();
  }
});

Deno.test("click: shift+click on a radio selects it and fires the handler", async () => {
  const picked: string[] = [];
  const App = () =>
    h(
      "div",
      null,
      h("input", {
        t: "r1",
        type: "radio",
        name: "g",
        value: "a",
        onChange: () => picked.push("a"),
      }),
      h("input", {
        t: "r2",
        type: "radio",
        name: "g",
        value: "b",
        onChange: () => picked.push("b"),
      }),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    await ui.r2.click({ shiftKey: true });
    assertEquals(ui.r2.checked, true);
    assertEquals(picked, ["b"], "a modified radio click must fire onChange");
  } finally {
    await ui.dispose();
  }
});

// ── 3. onChange is reachable ─────────────────────────────────────────

Deno.test("change: blur after typing fires change, exactly like a browser", async () => {
  const events: string[] = [];
  const App = () =>
    h(
      "div",
      null,
      h("input", {
        t: "name",
        onInput: () => events.push("input"),
        onChange: () => events.push("change"),
        onBlur: () => events.push("blur"),
      }),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    await ui.name.type("ab");
    await ui.name.blur();
    assertEquals(
      events,
      ["input", "input", "change", "blur"],
      "change must fire on blur after the value changed (and BEFORE blur)",
    );
    // A blur with no edit since the last one fires no second change.
    await ui.name.blur();
    assertEquals(events, ["input", "input", "change", "blur", "blur"]);
  } finally {
    await ui.dispose();
  }
});

Deno.test("change: the live tier fires change on blur too (one decider)", async () => {
  const events: string[] = [];
  const App = () =>
    h(
      "div",
      null,
      h("input", {
        t: "name",
        onInput: () => events.push("input"),
        onChange: () => events.push("change"),
      }),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    const root = ui.surface().component;
    await runUITrigger({ path: `${root}:name`, action: "type", text: "hi" });
    await runUITrigger({ path: `${root}:name`, action: "blur" });
    assertEquals(events, ["input", "input", "change"]);
  } finally {
    await ui.dispose();
  }
});

// ── 4. what a browser refuses, the harness refuses ───────────────────

Deno.test("strict: type() into a <div> is refused (it is not a text field)", async () => {
  const App = () => h("div", null, h("div", { t: "box", onClick: () => {} }));
  const ui = await testUI(App as ComponentFn);
  try {
    const e = await assertRejects(() => ui.box.type("x"), Error);
    assert(e.message.includes("cannot type into"), e.message);
    const root = ui.surface().component;
    const res = await runUITrigger({
      path: `${root}:box`,
      action: "type",
      text: "x",
    });
    assertEquals(res.ok, false, JSON.stringify(res));
    assertEquals(
      (ui.box.info as { value?: string }).value,
      undefined,
      "no `value` expando may be written onto a <div>",
    );
  } finally {
    await ui.dispose();
  }
});

Deno.test("strict: type() past maxLength is refused", async () => {
  const App = () =>
    h("div", null, h("input", { t: "pin", maxLength: 3, onInput: () => {} }));
  const ui = await testUI(App as ComponentFn);
  try {
    const e = await assertRejects(() => ui.pin.type("1234"), Error);
    assert(e.message.includes("maxLength"), e.message);
    assertEquals(ui.pin.value, "123", "the allowed characters still landed");
  } finally {
    await ui.dispose();
  }
});

Deno.test("strict: click() on a hidden element is refused in both tiers", async () => {
  let fired = 0;
  const App = () =>
    h(
      "div",
      null,
      h("button", {
        t: "none",
        style: "display:none",
        onClick: () => fired++,
      }, "Ghost"),
      h("button", { t: "attr", hidden: true, onClick: () => fired++ }, "Attr"),
      h(
        "div",
        { style: "display:none" },
        h("button", { t: "buried", onClick: () => fired++ }, "Buried"),
      ),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    const handle = (name: string) =>
      (ui as unknown as Record<string, { click(): Promise<void> }>)[name]!;
    for (const name of ["none", "attr", "buried"]) {
      const e = await assertRejects(
        () => handle(name).click(),
        Error,
        undefined,
        `${name} must be refused`,
      );
      assert(e.message.includes("not visible"), e.message);
    }
    const root = ui.surface().component;
    const res = await runUITrigger({ path: `${root}:none`, action: "click" });
    assertEquals(res.ok, false, JSON.stringify(res));
    assert(String(res.error).includes("not visible"), String(res.error));
    assertEquals(fired, 0, "no hidden element may reach its handler");
  } finally {
    await ui.dispose();
  }
});

Deno.test("strict: type() into a hidden input is refused", async () => {
  const App = () =>
    h(
      "div",
      null,
      h("input", { t: "tok", type: "hidden", value: "secret" }),
      h("input", { t: "ok", onInput: () => {} }),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    const e = await assertRejects(() => ui.tok.type("x"), Error);
    assert(e.message.includes("hidden"), e.message);
    await ui.ok.type("fine"); // the visible one still works
    assertEquals(ui.ok.value, "fine");
  } finally {
    await ui.dispose();
  }
});

// ── 5. the cheap ones that were still silent ─────────────────────────

Deno.test("hover: mouseenter does not bubble to ancestors", async () => {
  const seen: string[] = [];
  const App = () =>
    h(
      "div",
      { onMouseEnter: () => seen.push("parent") },
      h("button", { t: "row", onMouseEnter: () => seen.push("row") }, "Row"),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    await ui.row.hover();
    assertEquals(
      seen,
      ["row"],
      "a real mouseenter does not bubble — the parent's handler must not run",
    );
  } finally {
    await ui.dispose();
  }
});

Deno.test("dragTo: refuses a hidden target in both tiers", async () => {
  const drops: string[] = [];
  const App = () =>
    h(
      "div",
      null,
      h("div", { t: "src", onDragStart: () => drops.push("start") }, "card"),
      h("div", {
        t: "dst",
        style: "display:none",
        onDrop: () => drops.push("drop"),
      }, "bin"),
    );
  const ui = await testUI(App as ComponentFn);
  try {
    const e = await assertRejects(() => ui.src.dragTo(ui.dst), Error);
    assert(e.message.includes("not visible"), e.message);
    const root = ui.surface().component;
    const res = await runUITrigger({
      path: `${root}:src`,
      action: "dragTo",
      text: `${root}:dst`,
    });
    assertEquals(res.ok, false, JSON.stringify(res));
    assertEquals(drops, [], "no drag sequence may reach a hidden target");
  } finally {
    await ui.dispose();
  }
});

Deno.test("surface: a duplicate explicit t= is reported, not silently renamed", async () => {
  _resetSurfaceWarnings();
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) =>
    void warnings.push(a.map(String).join(" "));
  let ui;
  try {
    const App = () =>
      h(
        "div",
        null,
        h("button", { t: "save", onClick: () => {} }, "A"),
        h("button", { t: "save", onClick: () => {} }, "B"),
      );
    ui = await testUI(App as ComponentFn);
    const all = warnings.join("\n");
    assert(all.includes('duplicate t="save"'), all);
    assert(all.includes("save2"), all);
    // …and the second element is still addressable, as the message says.
    assertEquals(ui.present("save2"), true);
  } finally {
    console.warn = orig;
    await ui?.dispose();
    _resetSurfaceWarnings();
  }
});

Deno.test("am trigger type: a control that leaves the surface mid-word fails loud", async () => {
  const App = () => {
    const [v, setV] = useLocal("");
    return h(
      "div",
      null,
      v.length >= 1 ? h("span", { t: "done" }, "saved") : h("input", {
        t: "f",
        onInput: (e: { target: { value: string } }) => setV(e.target.value),
      }),
    );
  };
  const ui = await testUI(App as ComponentFn);
  try {
    const root = ui.surface().component;
    const res = await runUITrigger({
      path: `${root}:f`,
      action: "type",
      text: "abc",
    });
    assertEquals(
      res.ok,
      false,
      "typing into a control that vanished must not report success: " +
        JSON.stringify(res),
    );
    assert(
      String(res.error).includes("left the live surface"),
      String(res.error),
    );
  } finally {
    await ui.dispose();
  }
});
