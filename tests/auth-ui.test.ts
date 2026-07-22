// AUTH-2 UI — <SignIn/> renders correctly in every mode (SSR smoke: the same
// vdom the browser mounts). No chromium needed to lock the component shape.
import { assert, assertStringIncludes } from "@std/assert";
import { renderToString } from "../src/air/vdom-ssr.ts";
import {
  _resetAuthUi,
  _setAuthFeatures,
  SignIn,
} from "../src/browser/browser-auth-ui.ts";
import { h } from "../src/air/vdom.ts";

Deno.test("SignIn: login mode renders id/password form + signup toggle", () => {
  _resetAuthUi();
  const html = renderToString(h(SignIn, {}));
  assertStringIncludes(html, 'name="id"');
  assertStringIncludes(html, 'name="password"');
  assertStringIncludes(html, '="current-password"');
  assertStringIncludes(html, "Sign in");
  assertStringIncludes(html, "Create an account");
  assert(!html.includes('name="email"'), "email only shows on signup");
});

Deno.test("SignIn: props — custom title, signup toggle hidden", () => {
  _resetAuthUi();
  const html = renderToString(
    h(SignIn, { title: "Staff login", signup: false }),
  );
  assertStringIncludes(html, "Staff login");
  assert(!html.includes("Create an account"), "signup toggle hidden");
});

Deno.test("SignIn: adapts to server features — SSO button, signup auto-hidden", () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: false, oidc: true, totp: true, mail: true });
  const html = renderToString(h(SignIn, {}));
  assertStringIncludes(html, "Continue with SSO");
  assertStringIncludes(html, "/__aio/auth/oidc/start");
  assert(
    !html.includes("Create an account"),
    "server disabled signup → toggle gone without any prop",
  );
  // And the opposite server: no OIDC → no button.
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: true, mail: false });
  const html2 = renderToString(h(SignIn, { ssoLabel: "Google" }));
  assert(!html2.includes("Google"), "no provider → no SSO button");
  assertStringIncludes(html2, "Create an account");
});
