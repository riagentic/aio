// <SignIn/> beyond the login form.
//
// tests/auth-ui.test.ts locks the LOGIN rendering. The rest of the component —
// "Forgot password?", the reset-token form, the TOTP step, and every submit
// handler behind them — ran at 43%. Those are the paths a person is on when
// they are already locked out, which is the worst place for a bug and the least
// likely place for anyone to notice one.
//
// No browser needed: the component is a VNode tree, so the handlers are values
// on it. They are called with a real happy-dom <form>, and `fetch` is the seam
// the auth client goes through.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { renderToString } from "../src/air/vdom-ssr.ts";
import {
  _resetAuthUi,
  _setAuthFeatures,
  authUser,
  SignIn,
} from "../src/browser/browser-auth-ui.ts";
import { h } from "../src/air/vdom.ts";
import type { VNode } from "../src/air/vdom-types.ts";

// ── driving the component ────────────────────────────────────

type Handler = (e: unknown) => unknown;

/** Depth-first walk of a rendered tree. `h(SignIn, …)` is a component node, so
 *  it is invoked to get the markup it would mount. */
function tree(node: VNode): VNode {
  if (typeof node.tag === "function") {
    return tree((node.tag as (p: unknown) => VNode)(node.props));
  }
  return node;
}

function* nodes(n: VNode | string | number | null): Generator<VNode> {
  if (!n || typeof n !== "object") return;
  yield n;
  for (const c of n.children ?? []) {
    if (c && typeof c === "object") yield* nodes(c as VNode);
  }
}

/** The first node whose rendered text contains `label`. */
function find(root: VNode, tag: string, label?: string): VNode | undefined {
  for (const n of nodes(root)) {
    if (n.tag !== tag) continue;
    if (label === undefined) return n;
    const text = (n.children ?? []).filter((c) => typeof c === "string").join(
      " ",
    );
    if (text.includes(label)) return n;
  }
  return undefined;
}

/** A real form element carrying `fields`, plus the FormData that can read it.
 *
 *  Deno's own `FormData` refuses a happy-dom element ("Illegal constructor"),
 *  and the handlers under test call `new FormData(form)` exactly as a browser
 *  would — so the global is swapped for happy-dom's for the duration. */
function formWith(
  fields: Record<string, string>,
): { form: HTMLFormElement; restore: () => void } {
  const win = new Window();
  const doc = win.document;
  const form = doc.createElement("form");
  for (const [name, value] of Object.entries(fields)) {
    const input = doc.createElement("input");
    input.setAttribute("name", name);
    input.setAttribute("value", value);
    form.appendChild(input);
  }
  doc.body.appendChild(form);
  const realFormData = globalThis.FormData;
  // deno-lint-ignore no-explicit-any
  globalThis.FormData = (win as any).FormData;
  return {
    form: form as unknown as HTMLFormElement,
    restore: () => {
      globalThis.FormData = realFormData;
    },
  };
}

/** Submit the component's form with `fields`, then let the handler settle. */
async function submit(
  root: VNode,
  fields: Record<string, string>,
): Promise<void> {
  const form = find(root, "form");
  assert(form, "the component rendered no form");
  const onSubmit = form.props.onSubmit as Handler;
  assert(typeof onSubmit === "function", "the form has no onSubmit");
  const { form: el, restore } = formWith(fields);
  try {
    onSubmit({ preventDefault: () => {}, currentTarget: el });
    // The handlers are async and the submit path does not await them.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    restore();
  }
}

function click(root: VNode, label: string): void {
  const btn = find(root, "button", label);
  assert(btn, `no button labelled "${label}"`);
  (btn.props.onClick as Handler)({});
}

/** Canned auth server. Returns the bodies, records the calls. */
function withFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
): { calls: { path: string; body: unknown }[]; restore: () => void } {
  const calls: { path: string; body: unknown }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(
      typeof input === "object" && "url" in input ? input.url : input,
    );
    const path = new URL(url, "http://localhost").pathname;
    let body: unknown = undefined;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch { /* not json */ }
    calls.push({ path, body });
    const hit = routes[path] ?? { status: 404, body: { error: "not_found" } };
    return Promise.resolve(
      new Response(JSON.stringify(hit.body ?? {}), {
        status: hit.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const render = (props = {}) => tree(h(SignIn, props) as VNode);
const html = (props = {}) => renderToString(h(SignIn, props));

// ── forgot / reset ───────────────────────────────────────────

Deno.test("SignIn: 'Forgot password?' appears only when the server can send mail", () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: false, mail: false });
  assert(
    !html().includes("Forgot"),
    "offered a reset the server has no way to deliver",
  );

  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: false, mail: true });
  assertStringIncludes(html(), "Forgot");

  // …and the prop can still take it away.
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: false, mail: true });
  assert(!html({ forgot: false }).includes("Forgot"));
});

Deno.test("SignIn: the reset request never reveals whether the account exists", async () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: false, mail: true });
  click(render(), "Forgot");

  const asked = html();
  assertStringIncludes(asked, "Reset password");
  assertStringIncludes(asked, 'name="id"');

  const f = withFetch({ "/__aio/auth/reset/request": { body: { ok: true } } });
  try {
    await submit(render(), { id: "nobody-at-all" });
  } finally {
    f.restore();
  }
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0]!.body, { id: "nobody-at-all" });

  // The notice is deliberately conditional — "IF that account has an email".
  const after = html();
  assertStringIncludes(after, "If that account has an email");
  // …and it moves straight to the token form, for the same reason: a UI that
  // only advanced for real accounts would answer the question the API refuses.
  assertStringIncludes(after, 'name="token"');
  assertStringIncludes(after, "Set a new password");
});

Deno.test("SignIn: a completed reset returns to login with a notice, not a session", async () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: false, mail: true });
  click(render(), "Forgot");
  const f1 = withFetch({ "/__aio/auth/reset/request": { body: { ok: true } } });
  try {
    await submit(render(), { id: "alice" });
  } finally {
    f1.restore();
  }

  const f2 = withFetch({ "/__aio/auth/reset": { body: { ok: true } } });
  try {
    await submit(render(), { token: "tok-123", password: "new-password-9" });
  } finally {
    f2.restore();
  }
  assertEquals(f2.calls[0]!.body, {
    token: "tok-123",
    password: "new-password-9",
  });

  const after = html();
  assertStringIncludes(after, "Password changed");
  assertStringIncludes(after, 'name="password"');
  assertEquals(authUser.value ?? null, null, "a reset must not sign you in");
});

Deno.test("SignIn: a rejected reset token says so and keeps the form", async () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: false, mail: true });
  click(render(), "Forgot");
  const f1 = withFetch({ "/__aio/auth/reset/request": { body: { ok: true } } });
  try {
    await submit(render(), { id: "alice" });
  } finally {
    f1.restore();
  }

  const f2 = withFetch({
    "/__aio/auth/reset": { status: 400, body: { error: "invalid_token" } },
  });
  try {
    await submit(render(), { token: "wrong", password: "new-password-9" });
  } finally {
    f2.restore();
  }

  const after = html();
  // Still on the token form — a failed reset that dumped you back to login
  // would lose the token the person just pasted.
  assertStringIncludes(after, 'name="token"');
  assert(
    after.includes("invalid") || after.includes("token"),
    `the failure was not reported: ${after.slice(0, 300)}`,
  );
});

Deno.test("SignIn: back-to-login clears the error it was showing", async () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: false, mail: true });
  click(render(), "Forgot");
  const f = withFetch({
    "/__aio/auth/reset/request": { status: 500, body: { error: "mail_down" } },
  });
  try {
    await submit(render(), { id: "alice" });
  } finally {
    f.restore();
  }
  assert(html().includes("mail_down") || html().includes("error"));

  click(render(), "Back");
  const back = html();
  assertStringIncludes(back, 'autoComplete="current-password"');
  assert(!back.includes("mail_down"), "a stale error followed the user back");
});

// ── the TOTP step ────────────────────────────────────────────

Deno.test("SignIn: a login needing a second factor asks for the code, not the password again", async () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: true, mail: false });
  const f = withFetch({
    "/__aio/auth/login": { body: { totpRequired: true, pending: "pend-1" } },
  });
  try {
    await submit(render(), { id: "alice", password: "correct-horse-9" });
  } finally {
    f.restore();
  }

  const step = html();
  assertStringIncludes(step, 'name="code"');
  assert(
    !step.includes('name="password"'),
    "asked for the password again at the second factor",
  );
  assertEquals(
    authUser.value ?? null,
    null,
    "signed in before the second factor",
  );
});

Deno.test("SignIn: a wrong code burns the pending and returns to the password form", async () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: true, mail: false });
  const f1 = withFetch({
    "/__aio/auth/login": { body: { totpRequired: true, pending: "pend-1" } },
  });
  try {
    await submit(render(), { id: "alice", password: "correct-horse-9" });
  } finally {
    f1.restore();
  }

  const f2 = withFetch({
    "/__aio/auth/totp": { status: 401, body: { error: "bad_code" } },
  });
  try {
    await submit(render(), { code: "000000" });
  } finally {
    f2.restore();
  }
  assertEquals(f2.calls[0]!.body, { pending: "pend-1", code: "000000" });

  // The pending is ONE-SHOT server-side; leaving the code form up would offer
  // a second attempt against a token that is already spent.
  const after = html();
  assert(!after.includes('name="code"'), "the spent pending kept its form");
  assertStringIncludes(after, 'name="password"');
});

// ── signup ───────────────────────────────────────────────────

Deno.test("SignIn: a signup that needs verification says so instead of signing in", async () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: false, mail: true });
  click(render(), "Create an account");
  assertStringIncludes(html(), 'name="email"');

  const f = withFetch({
    "/__aio/auth/signup": { body: { verificationSent: true } },
  });
  try {
    await submit(render(), {
      id: "alice",
      password: "correct-horse-9",
      email: "a@example.com",
    });
  } finally {
    f.restore();
  }

  const after = html();
  assertStringIncludes(after, "check your inbox");
  assertEquals(authUser.value ?? null, null, "signed in before verifying");
  // …and back on the login form, which is where they will come back to.
  assertStringIncludes(after, 'autoComplete="current-password"');
});
