// The testUI gaps four field reports hit, pinned as behaviour.
//
// Each one cost real time in a real build, and each is the same shape: the
// harness answered a question with something that LOOKED like an answer —
// a plain click for a ctrl+click, a 0×0 viewport for a real one, "component
// not found" for an element that exists, a miss for UI a queued action was
// about to create.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testUI } from "aio/testing";
import { onMount, signal } from "aio/air";

// ── 1. modified clicks ────────────────────────────────────────────
const mods = signal("");
function ModApp() {
  return (
    <div>
      <button
        t="target"
        onClick={(e: MouseEvent) =>
          mods.set(
            [
              e.ctrlKey && "ctrl",
              e.shiftKey && "shift",
              e.altKey && "alt",
              e.metaKey && "meta",
            ].filter(Boolean).join("+") || "plain",
          )}
      >
        hit me
      </button>
    </div>
  );
}

testUI(ModApp, "click carries modifiers, like press does", async (ui) => {
  await ui.target.click();
  assertEquals(mods(), "plain");
  await ui.target.click({ ctrlKey: true });
  assertEquals(mods(), "ctrl", "ctrl+click is the app's core gesture");
  await ui.target.click({ ctrlKey: true, shiftKey: true });
  assertEquals(mods(), "ctrl+shift");
  await ui.target.dblclick({ altKey: true });
  assertEquals(mods(), "alt");
});

// ── 2. a real viewport, and a loud fake layout ────────────────────
const seen = signal("");
function ViewApp() {
  onMount(() => {
    const d = (globalThis as { document?: Document }).document!;
    seen.set(
      `${d.documentElement.clientWidth}x${d.documentElement.clientHeight}`,
    );
  });
  return <div t="box">v</div>;
}

testUI(
  ViewApp,
  "the mount reports the viewport it was given",
  { viewport: { width: 1440, height: 900 } },
  async (ui) => {
    await ui.settle();
    // Without this a component asking "am I inside the viewport?" silently
    // takes its degenerate branch and the test passes for the wrong reason.
    assertEquals(seen(), "1440x900");
  },
);

testUI(ViewApp, "the default viewport is a real size, not 0×0", async (ui) => {
  await ui.settle();
  assertEquals(seen(), "1024x768");
});

// ── 3. document listeners fire ────────────────────────────────────
const keys = signal(0);
function DocApp() {
  onMount(() => {
    const d = (globalThis as { document?: Document }).document!;
    const h = () => keys.set(keys() + 1);
    d.addEventListener("keydown", h);
    return () => d.removeEventListener("keydown", h);
  });
  return <input t="field" />;
}

testUI(
  DocApp,
  "a document-level listener is reachable and fires",
  async (ui) => {
    await ui.field.press("Escape");
    await ui.settle();
    assert(
      keys() > 0,
      "document.addEventListener is the common form and must not be inert",
    );
  },
);

// ── 4. names: one miss, both namespaces ──────────────────────────
function Row() {
  return <div t="row-7">row</div>;
}
function NameApp() {
  return (
    <div>
      <Row />
    </div>
  );
}

testUI(NameApp, "a miss names the namespace the thing IS in", async (ui) => {
  // The element exists — deep. `find()` resolves components only, and used to
  // answer with a component listing that sent the reader looking in the wrong
  // place entirely.
  let msg = "";
  try {
    // find() resolves at USE time, like every other handle.
    ui.find("row-7").surface();
  } catch (e) {
    msg = String(e);
  }
  assertStringIncludes(msg, 'no COMPONENT named "row-7"');
  assertStringIncludes(msg, "IS an element by that name");
  assertStringIncludes(msg, 'ui["row-7"]');
  // …and the spelling it names actually works.
  assertEquals(ui["row-7"].text, "row");
});

// ── 5. lazy resolution reaches UI a queued action creates ────────
const open = signal(false);
function LazyApp() {
  return (
    <div>
      <button t="reveal" onClick={() => open.set(true)}>open</button>
      {open() ? <Form /> : null}
    </div>
  );
}
function Form() {
  return <input t="username" />;
}

testUI(LazyApp, "un-awaited actions can target UI they reveal", async (ui) => {
  // The documented promise, on the ordinary shape: the revealed input lives
  // inside a CHILD component, so resolving it needs the same hoist the eager
  // path does. No await between the two lines — that is the point.
  ui.reveal.click();
  ui.username.type("editor");
  await ui.settle();
  assertEquals(ui.username.value, "editor");
});
