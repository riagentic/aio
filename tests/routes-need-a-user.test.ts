// Two per-user auth modes disagreed about what an anonymous request to a
// declared `routes:` path gets.
//
//   users: {…}      →  401. No token, no bytes.
//   auth: true      →  200 text/html — the SPA shell.
//
// `auth: true` makes the app SHELL public so the sign-in page can render, and
// that anonymous branch called `serveStatic` without ever calling `tryRoutes`.
// A declared route therefore did not exist for an anonymous caller: it fell
// through to the static handler, which answers `/` for any unknown path, and
// the caller got 200 + HTML. docs/examples/05-integrations.md documents
// exactly this shape — a `/hooks/payment` webhook receiver — so on an
// `auth: true` app the payment provider's delivery log said 200 while the cell
// method never ran and nothing was logged. (audit a3/H5)
//
// One rule for both modes: a route runs for a signed-in user, and an anonymous
// caller is told so.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";

const ran: string[] = [];

async function bootApp(
  mode: "users" | "authFlows",
): Promise<{ base: string; close: () => Promise<void> }> {
  const { aio, cell } = await import("../mod.ts");
  const c = cell(`hookcell_${mode}`, {
    state: { hits: 0 },
    visible: "all",
    methods: {
      hit(s: { hits: number }) {
        s.hits += 1;
      },
    },
  });
  const port = freePort();
  const app = await aio.run({
    cells: [c],
    appId: `test-routes-need-a-user-${mode}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
    routes: {
      "/hooks/payment": () => {
        ran.push(mode);
        return new Response("charged");
      },
    },
    ...(mode === "users"
      ? { users: { "tok-admin": { id: "admin", role: "admin" } } }
      : { auth: true }),
  } as never);
  return { base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

for (const mode of ["users", "authFlows"] as const) {
  Deno.test(`routes (${mode}): an anonymous webhook POST is refused, not answered with HTML`, async () => {
    ran.length = 0;
    const app = await bootApp(mode);
    try {
      const res = await fetch(`${app.base}/hooks/payment`, {
        method: "POST",
        body: "{}",
      });
      const body = await res.text();
      assertEquals(
        res.status,
        401,
        `both per-user modes must refuse an anonymous route the same way — ` +
          `got ${res.status} ${res.headers.get("content-type")} (${
            body.slice(0, 80)
          })`,
      );
      assert(
        !body.includes("<!DOCTYPE") && !body.includes("<html"),
        `the caller is a machine reading a delivery log; it must not be ` +
          `handed the SPA shell: ${body.slice(0, 120)}`,
      );
      assertEquals(
        ran.length,
        0,
        "the handler must not have run for an anonymous caller",
      );
    } finally {
      await app.close();
    }
  });
}

// The CONTROL — without it a test that passes because nothing ever reaches a
// route at all would look like enforcement.
Deno.test("routes (users): a signed-in caller still reaches the handler", async () => {
  ran.length = 0;
  const app = await bootApp("users");
  try {
    const res = await fetch(`${app.base}/hooks/payment`, {
      method: "POST",
      headers: { Authorization: "Bearer tok-admin" },
      body: "{}",
    });
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "charged");
    assertEquals(ran, ["users"]);
  } finally {
    await app.close();
  }
});
