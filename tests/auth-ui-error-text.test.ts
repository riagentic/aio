// <SignIn/>'s own wording for a failure was DEAD. `friendly()` looked the
// error up by `e.message` — but the auth client's `AuthError` already turns
// the server code into a sentence, and keeps the code on `.code`. So the
// lookup never hit: a wrong second-factor code (which BURNS the pending token
// and drops the person back at the password form) said "That code is not
// correct." — inviting a retry on a form that is gone — instead of the
// component's "Wrong code — sign in again."
//
// And the client's table had holes: codes the server really sends
// (`too_many_accounts`, `reserved_id`, `totp_already_enabled`,
// `body_too_large`) reached a signup form as "Sign-in failed (reserved_id)."
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import {
  _resetAuthUi,
  _setAuthFeatures,
  SignIn,
} from "../src/browser/browser-auth-ui.ts";
import { AuthError } from "../src/browser/auth-client.ts";
import { h } from "../src/air/vdom.ts";
import type { VNode } from "../src/air/vdom-types.ts";

type Handler = (e: unknown) => unknown;

const tree = (node: VNode): VNode =>
  typeof node.tag === "function"
    ? tree((node.tag as (p: unknown) => VNode)(node.props))
    : node;

async function submit(fields: Record<string, string>): Promise<void> {
  const root = tree(h(SignIn, {}) as VNode);
  assertEquals(root.tag, "form");
  const win = new Window();
  const form = win.document.createElement("form");
  for (const [name, value] of Object.entries(fields)) {
    const input = win.document.createElement("input");
    input.setAttribute("name", name);
    input.setAttribute("value", value);
    form.appendChild(input);
  }
  win.document.body.appendChild(form);
  const realFormData = globalThis.FormData;
  // deno-lint-ignore no-explicit-any
  globalThis.FormData = (win as any).FormData;
  try {
    (root.props.onSubmit as Handler)({
      preventDefault: () => {},
      currentTarget: form,
    });
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.FormData = realFormData;
    await closeWindow(win);
  }
}

function withFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(
      typeof input === "object" && "url" in input ? input.url : input,
    );
    const hit = routes[new URL(url, "http://localhost").pathname] ??
      { status: 404, body: { error: "not_found" } };
    return Promise.resolve(
      new Response(JSON.stringify(hit.body ?? {}), {
        status: hit.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

Deno.test("SignIn: a wrong second-factor code shows SignIn's own 'sign in again' text", async () => {
  _resetAuthUi();
  _setAuthFeatures({ signup: true, oidc: false, totp: true, mail: false });
  let restore = withFetch({
    "/__aio/auth/login": { body: { totpRequired: true, pending: "p-1" } },
  });
  try {
    await submit({ id: "alice", password: "correct-horse-9" });
  } finally {
    restore();
  }
  restore = withFetch({
    "/__aio/auth/totp": { status: 401, body: { error: "invalid_code" } },
  });
  try {
    await submit({ code: "000000" });
  } finally {
    restore();
  }
  const after = renderToString(h(SignIn, {}));
  assertStringIncludes(after, "Wrong code — sign in again.");
  assertStringIncludes(after, 'name="password"');
});

Deno.test("auth client: every error code the server sends has a sentence", async () => {
  // Read the codes from the SERVER source, so a code added there without a
  // sentence here turns this red instead of shipping snake_case to a user.
  const src = await Deno.readTextFile(
    new URL("../src/server/auth-flows.ts", import.meta.url),
  );
  const users = await Deno.readTextFile(
    new URL("../src/server/auth-users.ts", import.meta.url),
  );
  const codes = new Set<string>();
  for (const m of src.matchAll(/error: "([a-z_]+)"/g)) codes.add(m[1]!);
  // The store's policy refusals reach the wire verbatim (signup / password).
  for (
    const m of users.matchAll(
      /"(invalid_id|reserved_id|[a-z_]+_too_short|user_exists)"/g,
    )
  ) {
    codes.add(m[1]!);
  }
  assert(codes.size > 20, `found only ${codes.size} codes — the scan broke`);
  const untranslated = [...codes].filter((c) =>
    new AuthError(c, 400).message.includes(c)
  );
  assertEquals(untranslated, [], "codes with no human sentence");
});
