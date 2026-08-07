// a field report #1 — "testUI cannot mount an authenticated app".
//
// An app that opens with `useUser()` renders `<SignIn/>` for null — the
// documented shape — so every UI test of every authenticated screen rendered
// the login form instead of the app. The way through was a hand-rolled fetch
// stub plus reaching into `_resetAuthUi`/`authUser` (underscore internals,
// coupled to any refactor). `testUI({ user })` is that stub, done once,
// mirroring `serverUser()`'s ambience: set before the FIRST render, no /me
// fetch to race, reset per mount.
import { assert, assertStringIncludes } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { authUser, useUser } from "../src/browser/browser-auth-ui.ts";
import type { AioUser } from "../mod.ts";

function App() {
  const user = useUser();
  if (user === undefined) return <p class="loading">resolving…</p>;
  if (user === null) return <div class="signin">sign in</div>;
  return (
    <div class="dash">
      <span class="who">{user.id}:{user.role}</span>
      {user.role === "admin" ? <div class="adminpanel">admin</div> : null}
    </div>
  );
}

Deno.test("testUI({ user }): the FIRST render is signed in", async () => {
  await using ui = await testUI(App, {
    user: { id: "sita", role: "customer" },
  });
  assertStringIncludes(ui.html(), "sita:customer");
  assert(
    !ui.html().includes("signin"),
    "an authenticated mount must not render <SignIn/>",
  );
  assert(
    !ui.html().includes("adminpanel"),
    "customer must not see the admin panel",
  );
});

Deno.test("testUI({ user }): role branches are testable", async () => {
  await using ui = await testUI(App, { user: { id: "root", role: "admin" } });
  assertStringIncludes(ui.html(), "adminpanel");
});

Deno.test("testUI({ user: null }): mounts anonymous — the SignIn branch", async () => {
  await using ui = await testUI(App, { user: null });
  assertStringIncludes(ui.html(), "signin");
});

Deno.test("testUI({ user }): identity resets on dispose — no cross-test inheritance", async () => {
  {
    await using ui = await testUI(App, {
      user: { id: "root", role: "admin" } as AioUser,
    });
    assertStringIncludes(ui.html(), "root:admin");
  }
  // The second test in a file inheriting the first test's user is the exact
  // trap the option closes: after dispose the ambient identity is unresolved
  // again, so an option-less mount renders the loading branch, not root.
  assert(
    authUser.value === undefined,
    "dispose must reset the ambient auth user",
  );
  {
    // An option-less mount resolves on its own (the /me fetch has no server
    // and lands anonymous) — what matters is it can NOT still be root.
    await using ui = await testUI(App);
    assert(
      !ui.html().includes("root:admin"),
      "a later mount must not inherit the previous mount's user",
    );
  }
});
