// testUI — semantic, selector-free UI testing (spec:
// docs/specs/2026-07-10-semantic-ui-testing.md). Proves: deterministic
// TSX→API naming (SubmitButton from a div.button), client-only interactions
// (useLocal typing), keyed component instances, cell round-trips, and
// stupid-proof errors.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { Window } from "happy-dom";
import { h, lazy, Portal, Suspense } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { useLocal } from "../src/browser-air.ts";
import { cell } from "../src/state/cell-create.ts";
import { testUI } from "../src/testing/ui-test.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

// The user's canonical example: a div with class "button" and text Submit
// must surface as SubmitButton.
function makeApp(onSubmit: () => void): ComponentFn {
  function Submit() {
    return h(
      "div",
      null,
      h("div", { className: "button", onClick: onSubmit }, "Submit"),
    );
  }
  function App() {
    return h("div", null, h(Submit as ComponentFn, {}));
  }
  return App as ComponentFn;
}

Deno.test("testUI: div.button 'Submit' → App…SubmitButton.click()", async () => {
  let clicks = 0;
  const win = new Window();
  const ui = await testUI(makeApp(() => clicks++), { document: win.document });
  // deep resolution from the root handle — reads like the user wrote it
  await ui.Submit.SubmitButton.click();
  assertEquals(clicks, 1);
  // surface is the intuitive machine-readable map
  const s = ui.surface();
  assertEquals(s.component, "App");
  assertEquals(s.children[0]!.component, "Submit");
  assertEquals(s.children[0]!.elements[0]!.name, "SubmitButton");
  ui.unmount();
  await win.happyDOM.close();
});

Deno.test("testUI: client-only typing via useLocal — no cells involved", async () => {
  function Form() {
    const { local: text, set } = useLocal("");
    return h(
      "div",
      null,
      h("input", {
        placeholder: "Title",
        value: text,
        onChange: (e: Event) =>
          set((e.currentTarget as HTMLInputElement).value),
      }),
      h("span", { t: "echo", onClick: () => {} }, text),
    );
  }
  const win = new Window();
  const ui = await testUI(Form as ComponentFn, { document: win.document });
  await ui.Form.TitleInput.type("buy milk");
  assertEquals(ui.Form.TitleInput.value, "buy milk");
  assertEquals(ui.Form.echo.text, "buy milk"); // t= handle, verbatim
  ui.unmount();
  await win.happyDOM.close();
});

Deno.test("testUI: keyed instances + cell round-trip on the real loop", async () => {
  const list = cell("uitest-list", {
    state: { items: [{ id: 1, done: false }, { id: 2, done: false }] },
    methods: {
      toggle(s, id: number) {
        const it = s.items.find((i) => i.id === id);
        if (it) it.done = !it.done;
      },
    },
  });
  function Row({ id, done }: { id: number; done: boolean }) {
    return h(
      "li",
      null,
      h("button", { onClick: () => list.toggle(id) }, done ? "Undo" : "Done"),
    );
  }
  function App() {
    // deno-lint-ignore no-explicit-any
    return h(
      "ul",
      null,
      // deno-lint-ignore no-explicit-any
      ...(list as any).items.map((i: { id: number; done: boolean }) =>
        h(Row as ComponentFn, { key: i.id, id: i.id, done: i.done })
      ),
    );
  }
  const win = new Window();
  const ui = await testUI(App as ComponentFn, {
    document: win.document,
    cells: [list],
  });
  await ui.find("Row", 2).DoneButton.click(); // keyed instance addressing
  // deno-lint-ignore no-explicit-any
  await ui.expectCell(list, (l: any) => l.items[1].done === true);
  // the clicked row re-rendered — its button is now UndoButton
  assertEquals(ui.find("Row", 2).UndoButton.text, "Undo");
  ui.unmount();
  await win.happyDOM.close();
});

Deno.test("testUI: unknown names fail with helpful, listing errors", async () => {
  const win = new Window();
  const ui = await testUI(makeApp(() => {}), { document: win.document });
  const err = assertThrows(() => ui.Submit.NopeButton) as Error;
  assert(err.message.includes("SubmitButton"), err.message);
  assert(err.message.includes("t prop"), err.message);
  ui.unmount();
  await win.happyDOM.close();
});

Deno.test("ui-remote: live-surface executor drives the same mounts (am path)", async () => {
  const { getSerializedSurfaces, runUITrigger } = await import(
    "../src/air/ui-remote.ts"
  );
  let clicks = 0;
  const win = new Window();
  const ui = await testUI(makeApp(() => clicks++), { document: win.document });

  // the live registry sees the mounted app…
  const surfaces = getSerializedSurfaces();
  assertEquals(surfaces.length >= 1, true);
  const path = surfaces.at(-1)!.children[0]!.elements[0]!.path;
  assertEquals(path.endsWith(":SubmitButton"), true);

  // …and triggers through the exact same event sequences as testUI
  const res = await runUITrigger({ path, action: "click" });
  assertEquals(res.ok, true);
  assertEquals(clicks, 1);

  // a miss self-describes with the available paths (AI/human self-correction)
  const miss = await runUITrigger({ path: "Nope:Button", action: "click" });
  assertEquals(miss.ok, false);
  assertEquals(miss.available!.includes(path), true);
  ui.unmount();
  await win.happyDOM.close();
});

Deno.test("testUI: t= exposes assertion targets with no handlers", async () => {
  function Stat() {
    return h("div", null, h("span", { t: "count" }, "42"));
  }
  const win = new Window();
  const ui = await testUI(Stat as ComponentFn, { document: win.document });
  assertEquals(ui.Stat.count.text, "42"); // no handler needed — t= is enough
  ui.unmount();
  await win.happyDOM.close();
});

Deno.test("testUI: select / check / clear / waitFor comfort APIs", async () => {
  const prefs = cell("uitest-prefs", {
    state: { theme: "light", agreed: false },
    methods: {
      setTheme(s, v: string) {
        s.theme = v;
      },
      agree(s, v: boolean) {
        s.agreed = v;
      },
    },
  });
  function Prefs() {
    return h(
      "form",
      null,
      h(
        "select",
        {
          t: "theme",
          onChange: (e: Event) =>
            prefs.setTheme((e.currentTarget as HTMLSelectElement).value),
        },
        h("option", { value: "light" }, "Light"),
        h("option", { value: "dark" }, "Dark"),
      ),
      h("input", {
        type: "checkbox",
        t: "agree",
        onChange: (e: Event) =>
          prefs.agree((e.currentTarget as HTMLInputElement).checked),
      }),
      h("input", { placeholder: "Name", onChange: () => {} }),
    );
  }
  const win = new Window();
  const ui = await testUI(Prefs as ComponentFn, {
    document: win.document,
    cells: [prefs],
  });
  await ui.Prefs.theme.select("dark");
  // deno-lint-ignore no-explicit-any
  await ui.waitFor(() => (prefs as any).theme === "dark");
  await ui.Prefs.agree.check();
  await ui.Prefs.agree.check(); // idempotent — still checked once
  // deno-lint-ignore no-explicit-any
  await ui.expectCell(prefs, (p: any) => p.agreed === true);
  await ui.Prefs.NameInput.type("Ann");
  assertEquals(ui.Prefs.NameInput.value, "Ann");
  await ui.Prefs.NameInput.clear();
  assertEquals(ui.Prefs.NameInput.value, "");
  ui.unmount();
  await win.happyDOM.close();
});

Deno.test("surface is a full observation space (AI-natural: see + act in one)", async () => {
  const { runUITrigger } = await import("../src/air/ui-remote.ts");
  const flag = cell("uitest-flag", {
    state: { on: false },
    methods: {
      toggle(s) {
        s.on = !s.on;
      },
    },
  });
  function Panel() {
    return h(
      "div",
      null,
      // deno-lint-ignore no-explicit-any
      h("span", { t: "status" }, (flag as any).on ? "ON" : "OFF"),
      h("button", { onClick: () => flag.toggle() }, "Toggle"),
      h("input", { placeholder: "Note", onChange: () => {} }),
    );
  }
  const win = new Window();
  const ui = await testUI(Panel as ComponentFn, {
    document: win.document,
    cells: [flag],
  });
  // observation: surface carries live text + values
  let s = ui.surface();
  const panel = s.component === "Panel" ? s : s.children[0]!;
  assertEquals(panel.elements.find((e) => e.name === "status")!.text, "OFF");
  await ui.Panel.NoteInput.type("hi");
  s = ui.surface();
  const p2 = s.component === "Panel" ? s : s.children[0]!;
  assertEquals(p2.elements.find((e) => e.name === "NoteInput")!.value, "hi");

  // act → observe in ONE round-trip (the agent loop over the wire)
  const togglePath = p2.elements.find((e) => e.name === "ToggleButton")!.path;
  const res = await runUITrigger({ path: togglePath, action: "click" });
  assertEquals(res.ok, true);
  const after = res.surface!.at(-1)!;
  const p3 = after.component === "Panel" ? after : after.children[0]!;
  assertEquals(p3.elements.find((e) => e.name === "status")!.text, "ON");
  ui.unmount();
  await win.happyDOM.close();
});

Deno.test("testgen: generated typed client compiles and matches the surface", async () => {
  const { testgen } = await import("../src/testing/ui-testgen.ts");
  function Row({ id }: { id: number }) {
    return h("li", null, h("button", { onClick: () => void id }, "Remove"));
  }
  function App() {
    return h(
      "div",
      null,
      h("input", { placeholder: "Title", onChange: () => {} }),
      h("div", { className: "button", onClick: () => {} }, "Submit"),
      h("span", { t: "status-line" }, "ok"), // non-identifier name → quoted key
      h(Row as ComponentFn, { key: 1, id: 1 }),
      h(Row as ComponentFn, { key: 2, id: 2 }),
    );
  }
  const win = new Window();
  const src = await testgen(App as ComponentFn, {
    document: win.document,
    // point the generated import at the real repo path so deno check works
    importFrom: new URL("../src/cell-test.ts", import.meta.url).href,
  });
  await win.happyDOM.close();

  // structure: one interface per component, quoted non-identifier keys, root type
  assert(src.includes("export interface AppUI extends UIComponentHandle"));
  assert(src.includes("export interface RowUI"));
  assert(src.includes("readonly TitleInput: UIElementHandle;"));
  assert(src.includes("readonly SubmitButton: UIElementHandle;"));
  assert(src.includes('readonly "status-line": UIElementHandle;'));
  assert(src.includes("readonly Row: RowUI;"));
  assert(src.includes("export type TypedTestUI = TestUI & {"));

  // diamond check: the generated module actually type-checks
  const tmp = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(tmp, src);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--no-lock", tmp],
    stdout: "null",
    stderr: "piped",
  }).output();
  const err = new TextDecoder().decode(out.stderr);
  await Deno.remove(tmp);
  assertEquals(out.code, 0, `generated types failed deno check:\n${err}`);
});

// ── Gestures: scroll + dragTo ─────────────────────────────────────────

Deno.test("testUI: scroll and dragTo fire faithful gesture sequences", async () => {
  const scrolls: number[] = [];
  const dndLog: string[] = [];
  function App() {
    return h(
      "div",
      null,
      h("div", {
        t: "feed",
        onScroll: (e: { target: { scrollTop: number } }) =>
          scrolls.push(e.target.scrollTop),
      }, "long list"),
      h("div", {
        t: "card",
        draggable: true,
        onDragStart: () => dndLog.push("start"),
        onDragEnd: () => dndLog.push("end"),
      }, "Card"),
      h("div", {
        t: "bin",
        onDragOver: () => dndLog.push("over"),
        onDrop: (e: { dataTransfer?: unknown }) =>
          dndLog.push(e.dataTransfer ? "drop+dt" : "drop"),
      }, "Bin"),
    );
  }
  const win = new Window();
  const ui = await testUI(App as ComponentFn, { document: win.document });

  await ui.App.feed.scroll({ top: 250 });
  assertEquals(scrolls, [250]);

  await ui.App.card.dragTo(ui.App.bin);
  // full HTML5 sequence: dragstart, dragover, drop (with a DataTransfer), dragend
  assertEquals(dndLog, ["start", "over", "drop+dt", "end"]);

  ui.unmount();
  await win.happyDOM.close();
});

// ── Pins: Portal and Suspense content stay on the surface ────────────

Deno.test("ui-surface pin: elements inside a Portal are on the surface and clickable", async () => {
  let clicks = 0;
  const win = new Window();
  const target = win.document.createElement("div");
  win.document.body.appendChild(target);
  function App() {
    return h(
      "div",
      null,
      h(
        Portal,
        { target },
        h("button", { onClick: () => clicks++ }, "Close"),
      ),
    );
  }
  const ui = await testUI(App as ComponentFn, { document: win.document });
  await ui.App.CloseButton.click(); // portal content is addressable like any other
  assertEquals(clicks, 1);
  ui.unmount();
  await win.happyDOM.close();
});

Deno.test("ui-surface pin: resolved lazy content under Suspense reaches the surface", async () => {
  let clicks = 0;
  function Loaded() {
    return h("button", { onClick: () => clicks++ }, "Ready");
  }
  const LazyComp = lazy(() =>
    Promise.resolve({ default: Loaded as ComponentFn })
  );
  function App() {
    return h(
      "div",
      null,
      h(
        Suspense,
        { fallback: h("span", null, "loading…") },
        h(LazyComp, {}),
      ),
    );
  }
  const win = new Window();
  const ui = await testUI(App as ComponentFn, { document: win.document });
  await ui.waitFor(() => ui.html().includes("Ready"));
  await ui.Loaded.ReadyButton.click();
  assertEquals(clicks, 1);
  ui.unmount();
  await win.happyDOM.close();
});
