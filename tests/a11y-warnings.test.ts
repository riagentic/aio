import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, mount, setDevMode } from "../src/air/aio-renderer.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers re-enabled

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  setDevMode(true);
  return {
    win,
    doc,
    root,
    cleanup: () => {
      setDevMode(false);
      return win.happyDOM.close();
    },
  };
}

function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

Deno.test({
  name: "a11y: warns on img without alt",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png" }));
    });
    assertEquals(
      warnings.some((w) => w.includes("missing") && w.includes("alt")),
      true,
    );
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on img with alt",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png", alt: "A photo" }));
    });
    assertEquals(warnings.some((w) => w.includes("alt")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on img with empty alt (decorative)",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png", alt: "" }));
    });
    assertEquals(warnings.some((w) => w.includes("alt")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: warns on onClick without keyboard handler on div",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("div", { onClick: () => {} }, "click me"));
    });
    assertEquals(warnings.some((w) => w.includes("keyboard")), true);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on button with onClick (interactive element)",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("button", { onClick: () => {} }, "click"));
    });
    assertEquals(warnings.some((w) => w.includes("keyboard")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on div with onClick + onKeyDown",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(
        root,
        () => h("div", { onClick: () => {}, onKeyDown: () => {} }, "ok"),
      );
    });
    assertEquals(warnings.some((w) => w.includes("keyboard")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: warns on input without label association",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("input", { type: "text" }));
    });
    assertEquals(warnings.some((w) => w.includes("label")), true);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on input with aria-label",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("input", { type: "text", "aria-label": "Name" }));
    });
    assertEquals(warnings.some((w) => w.includes("label")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on input with id",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("input", { type: "text", id: "name-field" }));
    });
    assertEquals(warnings.some((w) => w.includes("label")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warnings when dev mode disabled",
  async fn() {
    const { root, cleanup } = setup();
    setDevMode(false);
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png" }));
    });
    assertEquals(warnings.length, 0);
    await cleanup();
  },
});

Deno.test({
  name:
    "a11y: repeated offending element warns once, not per render (flood fix)",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      // Same offending <img> re-rendered many times — one warning, not N.
      let bump = () => {};
      const App = () => {
        const s = useSignalLocal();
        bump = s.bump;
        return h("div", null, [
          h("span", null, String(s.n)),
          h("img", { src: "x.png" }), // no alt — the offender
        ]);
      };
      mount(root, App);
      for (let i = 0; i < 25; i++) bump(); // force 25 re-renders
    });
    assertEquals(
      warnings.filter((w) => w.includes("alt")).length,
      1,
      "img-without-alt must warn once across many renders",
    );
    await cleanup();
  },
});

// minimal signal-backed local state to force re-renders
import { useSignal } from "../src/air/aio-renderer.ts";
function useSignalLocal() {
  const n = useSignal(0);
  return {
    get n() {
      return n.value;
    },
    bump: () => {
      n.set(n.value + 1);
    },
  };
}

// ── alpha72: the five a linter would catch and this one did not ──
//
// Each renders perfectly and fails only for someone using a keyboard, a screen
// reader or a zoomed page — the class of defect nobody finds by looking at the
// app. Warn-once and dev-only, like every check above: an a11y warning is an
// observation, never a behaviour.

/** Mount `vnode` in dev and return what was warned. */
async function warnsFor(
  make: () => ReturnType<typeof h>,
): Promise<string[]> {
  const { root, cleanup } = setup();
  const warnings = captureWarnings(() => mount(root, make));
  await cleanup();
  return warnings;
}

Deno.test("a11y: <button> with no type submits the form it is inside", async () => {
  const w = await warnsFor(() => h("button", {}, "Open menu"));
  assertEquals(
    w.some((m) => m.includes("<button> without type")),
    true,
    `expected the submit-by-default warning, got: ${JSON.stringify(w)}`,
  );
  assertEquals(
    (await warnsFor(() => h("button", { type: "button" }, "ok")))
      .some((m) => m.includes("without type")),
    false,
  );
});

Deno.test("a11y: <a onClick> with no href is not reachable by keyboard", async () => {
  const w = await warnsFor(() => h("a", { onClick: () => {} }, "Delete"));
  assertEquals(
    w.some((m) => m.includes("not focusable")),
    true,
    `got: ${JSON.stringify(w)}`,
  );
  assertEquals(
    (await warnsFor(() => h("a", { href: "/x", onClick: () => {} }, "go")))
      .some((m) => m.includes("not focusable")),
    false,
  );
});

Deno.test("a11y: a positive tabIndex re-orders the whole page", async () => {
  const w = await warnsFor(() => h("div", { tabIndex: 3 }, "x"));
  assertEquals(
    w.some((m) => m.includes("ENTIRE page")),
    true,
    `got: ${JSON.stringify(w)}`,
  );
  for (const ok of [0, -1]) {
    assertEquals(
      (await warnsFor(() => h("div", { tabIndex: ok }, "x")))
        .some((m) => m.includes("ENTIRE page")),
      false,
      `tabIndex={${ok}} is correct and must not warn`,
    );
  }
});

Deno.test("a11y: aria-hidden on something still focusable", async () => {
  const w = await warnsFor(() =>
    h("button", { type: "button", "aria-hidden": true }, "x")
  );
  assertEquals(
    w.some((m) => m.includes("still focusable")),
    true,
    `got: ${JSON.stringify(w)}`,
  );
  // Hiding a non-focusable decoration is the CORRECT use and must be silent.
  assertEquals(
    (await warnsFor(() => h("span", { "aria-hidden": true }, "★")))
      .some((m) => m.includes("still focusable")),
    false,
  );
});

Deno.test("a11y: aria-disabled describes a control, it does not disable it", async () => {
  const w = await warnsFor(() =>
    h(
      "button",
      { type: "button", "aria-disabled": true, onClick: () => {} },
      "x",
    )
  );
  assertEquals(
    w.some((m) => m.includes("does not disable")),
    true,
    `got: ${JSON.stringify(w)}`,
  );
  // With the real attribute alongside it, the author has said both things.
  assertEquals(
    (await warnsFor(() =>
      h("button", {
        type: "button",
        "aria-disabled": true,
        disabled: true,
        onClick: () => {},
      }, "x")
    )).some((m) => m.includes("does not disable")),
    false,
  );
});
