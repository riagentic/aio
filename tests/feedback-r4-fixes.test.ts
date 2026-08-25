// Regression tests for the Round-4 field-report fixes:
//  P1 — disabled form controls (no live handlers) are on the surface,
//       resolvable, and marked disabled: true
//  P1/P2 — invoking a never-resolving handle fails with the aio name listing
//       (and a shadowing hint), never a bare "not a function" TypeError
//  P3 — waitFor accepts a trailing description string like expectCell
//  P4 — the auto-DOM installs location/history so navigate() needs no shims
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";

Deno.test("testUI: disabled button (no onClick) is on the surface with disabled: true", async () => {
  function Login() {
    // Handler conditionally ABSENT while disabled — the exact shape that used
    // to vanish from the surface.
    return h(
      "form",
      null,
      h("button", { disabled: true, type: "submit" }, "Sign in"),
    );
  }
  function App() {
    return h("div", null, h(Login as ComponentFn, {}));
  }
  const ui = await testUI(App as ComponentFn);
  try {
    const surface = JSON.stringify(ui.surface());
    assert(surface.includes("Sign in"), `button missing from: ${surface}`);
    assert(surface.includes('"disabled":true'), `no disabled flag: ${surface}`);
    // Resolvable by name — asserting its state needs no selectors.
    const info = ui.Login.SignInButton.info;
    assertEquals(info.disabled, true);
  } finally {
    await ui.dispose();
  }
});

Deno.test("testUI: invoking an unknown action fails with the name listing, not a bare TypeError", async () => {
  // Component named like its inner input — `ui.PasswordInput` resolves to the
  // COMPONENT, so `.type()` used to be `undefined(...)` → TypeError.
  function PasswordInput() {
    return h("div", null, h("input", { type: "password", onInput: () => {} }));
  }
  function App() {
    return h("div", null, h(PasswordInput as ComponentFn, {}));
  }
  const ui = await testUI(App as ComponentFn);
  try {
    let msg = "";
    try {
      await ui.PasswordInput.frobnicate("x");
    } catch (e) {
      msg = String(e);
    }
    assert(msg.includes("testUI:"), `expected aio error, got: ${msg}`);
    assert(!msg.includes("is not a function"), `bare TypeError leaked: ${msg}`);
    assert(msg.includes("available:"), `no name listing: ${msg}`);
  } finally {
    await ui.dispose();
  }
});

Deno.test("testUI: waitFor accepts a trailing description string (expectCell symmetry)", async () => {
  function App() {
    return h("div", null, h("button", { onClick: () => {} }, "Go"));
  }
  const ui = await testUI(App as ComponentFn);
  try {
    // Passing form: resolves immediately.
    await ui.waitFor(() => true, "should resolve");
    // Failing form: the description must reach the timeout error.
    let msg = "";
    try {
      await ui.waitFor(() => false, { timeoutMs: 50, msg: "flag never set" });
    } catch (e) {
      msg = String(e);
    }
    assert(msg.includes("flag never set"), `description lost: ${msg}`);
  } finally {
    await ui.dispose();
  }
});

Deno.test("testUI: auto-DOM installs location + history (navigate works shim-free)", async () => {
  const hadLocation = "location" in globalThis &&
    !!(globalThis as { location?: unknown }).location;
  function App() {
    return h("div", null, "home");
  }
  const ui = await testUI(App as ComponentFn);
  try {
    const g = globalThis as { location?: { href?: string }; history?: unknown };
    assert(g.location, "globalThis.location missing under testUI");
    assert(g.history, "globalThis.history missing under testUI");
    if (!hadLocation) {
      // Owned window base URL is a real origin, not about:blank — routers
      // can resolve relative paths.
      assert(
        String(g.location?.href).startsWith("http"),
        `bad base URL: ${g.location?.href}`,
      );
    }
  } finally {
    await ui.dispose();
  }
});
