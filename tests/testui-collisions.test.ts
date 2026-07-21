// Regression tests for the testUI semantic-surface collision cluster:
//  risoto (2026-07-21) — same-type sibling aio-components: only the FIRST
//    instance was addressable (shared surface path), so per component type
//    only one `t` handle survived. Now: instance paths are deduped (#2, #3 …),
//    every element stays reachable, and the ordinal form `ui.….Button2`
//    addresses the 2nd instance (2-based, tree order — mirrors element
//    name de-duping). Listings annotate duplicates ("Button ×2 — use …").
//  inews R4 P2 — component/element name shadowing: `ui.X` used to resolve the
//    COMPONENT, so `.type()`/`.click()` threw. Now the handle is a hybrid —
//    element actions win, component navigation still works underneath.
//  inews P1 follow-up — interacting with a DISABLED element fails with a clear
//    "is disabled" error (never "not a function"); `.disabled` is assertable.
//  inews audit 7 — matchMedia is shimmed (real happy-dom impl when owned,
//    minimal always-false stub otherwise) so media-query components boot.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";

// ── 1a. same-type sibling components ─────────────────────────────────

function makeToolbarApp(clicks: string[]): ComponentFn {
  function Button(props: { t: string }) {
    return h(
      "button",
      { t: props.t, onClick: () => clicks.push(props.t) },
      props.t,
    );
  }
  function ToolBar() {
    return h(
      "div",
      null,
      h(Button as ComponentFn, { t: "Home" }),
      h(Button as ComponentFn, { t: "Settings" }),
    );
  }
  function App() {
    return h("div", null, h(ToolBar as ComponentFn, {}));
  }
  return App as ComponentFn;
}

Deno.test("siblings: same-type instances get distinct surface paths (#2)", async () => {
  const ui = await testUI(makeToolbarApp([]));
  try {
    const bar = ui.surface().children[0]!;
    assertEquals(bar.children.length, 2);
    assertEquals(bar.children[0]!.path, "App/ToolBar/Button");
    assertEquals(bar.children[1]!.path, "App/ToolBar/Button#2");
    // BOTH t-handles are on the surface — none is swallowed.
    assertEquals(bar.children[0]!.elements[0]!.name, "Home");
    assertEquals(bar.children[1]!.elements[0]!.name, "Settings");
  } finally {
    await ui.dispose();
  }
});

Deno.test("siblings: ordinal access ui.….Button2 reaches the 2nd instance", async () => {
  const clicks: string[] = [];
  const ui = await testUI(makeToolbarApp(clicks));
  try {
    await ui.ToolBar.Button.Home.click(); //   1st instance, explicit
    await ui.ToolBar.Button2.Settings.click(); // 2nd instance via ordinal
    await ui.Button2.Settings.click(); //      ordinal works from the top too
    assertEquals(clicks, ["Home", "Settings", "Settings"]);
  } finally {
    await ui.dispose();
  }
});

Deno.test("siblings: unique t-handles hoist through any instance (ui.Settings)", async () => {
  const clicks: string[] = [];
  const ui = await testUI(makeToolbarApp(clicks));
  try {
    await ui.Settings.click(); //         top-level hoist (risoto #2)
    await ui.ToolBar.Settings.click(); // component-scoped hoist
    assertEquals(clicks, ["Settings", "Settings"]);
  } finally {
    await ui.dispose();
  }
});

Deno.test("siblings: miss errors point at the live instance + annotate ×N", async () => {
  const ui = await testUI(makeToolbarApp([]));
  try {
    // Settings lives in the SECOND Button — the first's error says where.
    const e1 = await assertRejects(
      () => ui.ToolBar.Button.Settings.click(),
      Error,
    );
    assert(e1.message.includes("Button#2"), e1.message);
    assert(!e1.message.includes("is not a function"), e1.message);
    // Unknown-name listing annotates the duplicated component type.
    const e2 = await assertRejects(() => ui.ToolBar.Nope.click(), Error);
    assert(e2.message.includes("Button ×2"), e2.message);
    assert(e2.message.includes("Button2"), e2.message);
  } finally {
    await ui.dispose();
  }
});

Deno.test("siblings: same-named elements in same-type instances stay distinct", async () => {
  const clicks: string[] = [];
  function IconBtn(props: { onGo: () => void }) {
    return h("button", { t: "Go", onClick: props.onGo }, "Go");
  }
  function App() {
    return h(
      "div",
      null,
      h(IconBtn as ComponentFn, { onGo: () => clicks.push("first") }),
      h(IconBtn as ComponentFn, { onGo: () => clicks.push("second") }),
    );
  }
  const ui = await testUI(App as ComponentFn);
  try {
    // Ambiguous top-level hoist fails (at access) with BOTH paths + the
    // ordinal recipe.
    const e = assertThrows(() => ui.Go, Error);
    assert(e.message.includes("App/IconBtn:Go"), e.message);
    assert(e.message.includes("App/IconBtn#2:Go"), e.message);
    assert(e.message.includes("2"), e.message);
    // The ordinal form clicks the RIGHT instance (path dedupe, not just #1).
    await ui.App.IconBtn2.Go.click();
    await ui.App.IconBtn.Go.click();
    assertEquals(clicks, ["second", "first"]);
  } finally {
    await ui.dispose();
  }
});

// ── 1b. component/element name shadowing (inews R4 P2) ───────────────

Deno.test("shadow: ui.X acts as the element when a component shadows it", async () => {
  function PasswordInput() {
    // Inner input names itself "PasswordInput" (placeholder + role) — the
    // exact collision from the inews report.
    return h(
      "div",
      null,
      h("input", { placeholder: "Password", onInput: () => {} }),
    );
  }
  function App() {
    return h("div", null, h(PasswordInput as ComponentFn, {}));
  }
  const ui = await testUI(App as ComponentFn);
  try {
    // Element semantics win: type/clear/value work directly on ui.X …
    await ui.PasswordInput.type("hunter2");
    assertEquals(ui.PasswordInput.value, "hunter2");
    await ui.PasswordInput.clear();
    assertEquals(ui.PasswordInput.value, "");
    // …while component navigation stays available on the same handle.
    assertEquals(ui.PasswordInput.surface().component, "PasswordInput");
    // The explicit long form keeps working too.
    await ui.PasswordInput.PasswordInput.type("x");
    assertEquals(ui.PasswordInput.value, "x");
  } finally {
    await ui.dispose();
  }
});

// ── 2. disabled elements (inews P1) ──────────────────────────────────

Deno.test("disabled: resolvable + assertable, interactions fail loud", async () => {
  let saved = 0;
  function Formy() {
    return h(
      "form",
      null,
      h("button", { disabled: true, onClick: () => saved++ }, "Save"),
      h("input", { disabled: true, placeholder: "Title" }),
      h("button", { onClick: () => saved++ }, "Other"),
    );
  }
  const ui = await testUI(Formy as ComponentFn);
  try {
    // Resolves; disabledness is a first-class assertion.
    assertEquals(ui.Formy.SaveButton.disabled, true);
    assertEquals(ui.Formy.OtherButton.disabled, false);
    // Interacting throws a CLEAR error — not "not a function".
    const e1 = await assertRejects(() => ui.Formy.SaveButton.click(), Error);
    assert(e1.message.includes("is disabled"), e1.message);
    assert(e1.message.includes("SaveButton"), e1.message);
    assert(!e1.message.includes("not a function"), e1.message);
    assertEquals(saved, 0, "disabled handler must not run");
    const e2 = await assertRejects(
      () => ui.Formy.TitleInput.type("x"),
      Error,
    );
    assert(e2.message.includes("is disabled"), e2.message);
    // Enabled sibling still interacts normally.
    await ui.Formy.OtherButton.click();
    assertEquals(saved, 1);
  } finally {
    await ui.dispose();
  }
});

// ── 3. waitFor description string (inews P3) — timeout carries it ────

Deno.test("waitFor: trailing string description reaches the timeout error", async () => {
  function App() {
    return h("div", null, h("button", { onClick: () => {} }, "Go"));
  }
  const ui = await testUI(App as ComponentFn);
  try {
    await ui.waitFor(() => true, "resolves fine");
    const e = await assertRejects(
      () =>
        ui.waitFor(() => false, {
          timeoutMs: 50,
          msg: "flag never flipped",
        }),
      Error,
    );
    assert(e.message.includes("flag never flipped"), e.message);
  } finally {
    await ui.dispose();
  }
});

// ── 4. matchMedia shim (inews audit 7) ───────────────────────────────

Deno.test("matchMedia: media-query components boot; listeners are safe", async () => {
  const hadBefore = !!(globalThis as { matchMedia?: unknown }).matchMedia;
  let observed: boolean | null = null;
  function App() {
    const mq = (globalThis as unknown as {
      matchMedia: (q: string) => {
        matches: boolean;
        addEventListener: (t: string, f: () => void) => void;
        removeEventListener: (t: string, f: () => void) => void;
        addListener: (f: () => void) => void;
        removeListener: (f: () => void) => void;
      };
    }).matchMedia("(max-width: 600px)");
    observed = mq.matches;
    const noop = () => {};
    mq.addEventListener("change", noop); //  modern API — no-throw
    mq.removeEventListener("change", noop);
    mq.addListener(noop); //                 legacy API — no-throw
    mq.removeListener(noop);
    return h("div", null, observed ? "narrow" : "wide");
  }
  const ui = await testUI(App as ComponentFn);
  try {
    assertEquals(observed, false); // default viewport is not ≤600px
    assert(ui.html().includes("wide"));
  } finally {
    await ui.dispose();
  }
  if (!hadBefore) {
    // The shim is testUI-owned — removed with the harness.
    assertEquals(
      (globalThis as { matchMedia?: unknown }).matchMedia,
      undefined,
    );
  }
});
