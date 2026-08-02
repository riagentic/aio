// a field report R4 🔴 regression — ui.surface() staleness after a memo-skip.
//
// Sequence that corrupted the surface:
//   1. parent re-renders for its OWN reason → child is auto-memo SKIPPED
//      (props shallow-equal) — the tree now holds a FRESH child vnode, but
//      the child's instance kept pointing at the OLD one
//   2. the child SELF re-renders (own signal dep, outside the action queue)
//      and structurally swaps its branch (login form → header) — the new
//      `_rendered` landed on the detached old vnode
//   3. every tree walk (ui.surface(), testUI name resolution) kept seeing the
//      skip-time snapshot: LogOutButton "visibly in the DOM" but never
//      resolvable, stale SignInButton still listed.
// Fix: beforeComponent's skip path re-points `inst.vnode` to the tree vnode
// (src/air/renderer-rerender.ts).
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { cell } from "../src/state/cell-create.ts";
import { testUI } from "../src/testing/ui-test.ts";

const theme = cell("surfstale-theme", {
  scope: "client",
  state: { dark: false },
  methods: {
    toggle(s: { dark: boolean }) {
      s.dark = !s.dark;
    },
  },
});
const session = cell("surfstale-session", {
  scope: "client",
  state: { loggedIn: false },
  methods: {
    login(s: { loggedIn: boolean }) {
      s.loggedIn = true;
    },
    logout(s: { loggedIn: boolean }) {
      s.loggedIn = false;
    },
  },
});

Deno.test("surface: memo-skipped child's structural self-swap stays resolvable", async () => {
  let logoutClicks = 0;
  function Auth(_props: { mode: string }) {
    // deno-lint-ignore no-explicit-any
    return (session as any).loggedIn
      ? h(
        "header",
        null,
        h("span", null, "hi"),
        h("button", { onClick: () => logoutClicks++ }, "LogOut"),
      )
      : h(
        "form",
        null,
        h("input", { onInput: () => {} }),
        h("button", { type: "submit", onClick: () => {} }, "SignIn"),
      );
  }
  function App() {
    // Parent reads its OWN signal so it re-renders without changing Auth's
    // props — a fresh-but-equal props object defeats static-vnode hoisting
    // and triggers the auto-memo skip.
    // deno-lint-ignore no-explicit-any
    const dark = (theme as any).dark;
    return h(
      "div",
      { className: dark ? "dark" : "light" },
      h("span", null, dark ? "D" : "L"),
      h(Auth as ComponentFn, { mode: "inline" }),
    );
  }
  const ui = await testUI(App as ComponentFn);
  try {
    // 1. parent re-render → Auth memo-skipped
    // deno-lint-ignore no-explicit-any
    (theme as any).toggle();
    await ui.settle();
    // 2. child self re-render swaps the branch structurally
    // deno-lint-ignore no-explicit-any
    (session as any).login();
    await ui.settle();

    // 3. surface must reflect the swap: new branch resolvable, old gone
    const surf = JSON.stringify(ui.surface());
    assert(surf.includes("LogOutButton"), `LogOutButton missing: ${surf}`);
    assert(
      !surf.includes("SignInButton"),
      `stale SignInButton still listed: ${surf}`,
    );
    // …and genuinely interactive, not just listed.
    await ui.Auth.LogOutButton.click();
    assertEquals(logoutClicks, 1);

    // Swap BACK (second self-swap through the same instance) — stays fresh.
    // deno-lint-ignore no-explicit-any
    (session as any).logout();
    await ui.settle();
    const surf2 = JSON.stringify(ui.surface());
    assert(surf2.includes("SignInButton"), `SignInButton missing: ${surf2}`);
    assert(!surf2.includes("LogOutButton"), `stale LogOutButton: ${surf2}`);
  } finally {
    await ui.dispose();
  }
});
