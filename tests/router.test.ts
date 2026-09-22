import { assertEquals } from "@std/assert";
import { matchPath } from "../src/browser/browser-protocol.ts";

// ── matchPath ────────────────────────────────────────────────────────────

Deno.test("matchPath: exact static match", () => {
  assertEquals(matchPath("/users", "/users"), {});
  assertEquals(matchPath("/users", "/users/"), {});
  assertEquals(matchPath("/users", "/other"), null);
});

Deno.test("matchPath: root path", () => {
  assertEquals(matchPath("/", "/"), {});
  assertEquals(matchPath("/", "/users"), null);
});

Deno.test("matchPath: param extraction", () => {
  assertEquals(matchPath("/users/:id", "/users/42"), { id: "42" });
  assertEquals(matchPath("/users/:id", "/users/"), null);
  assertEquals(matchPath("/users/:id", "/users"), null);
});

Deno.test("matchPath: multiple params", () => {
  assertEquals(matchPath("/users/:userId/posts/:postId", "/users/1/posts/99"), {
    userId: "1",
    postId: "99",
  });
  assertEquals(
    matchPath("/users/:userId/posts/:postId", "/users/1/posts"),
    null,
  );
});

Deno.test("matchPath: URL-encoded params decoded", () => {
  const p = matchPath("/search/:q", "/search/hello%20world");
  assertEquals(p?.q, "hello world");
});

Deno.test("matchPath: prefix match (exact=false)", () => {
  assertEquals(matchPath("/dashboard", "/dashboard/users", false), {});
  assertEquals(matchPath("/dashboard", "/dashboard", false), {});
  assertEquals(matchPath("/dashboard", "/other", false), null);
});

Deno.test("matchPath: prefix does not match partial segments", () => {
  // /user should NOT prefix-match /users/42
  assertEquals(matchPath("/user", "/users/42", false), null);
});

Deno.test("matchPath: wildcard *", () => {
  assertEquals(matchPath("*", "/anything/here"), { "*": "/anything/here" });
  assertEquals(matchPath("*", "/"), { "*": "" });
});

Deno.test("matchPath: no false positives on similar paths", () => {
  assertEquals(matchPath("/about", "/about-us"), null);
  assertEquals(matchPath("/settings", "/settings-page"), null);
});

// ── SPA fallback (server.ts) ──────────────────────────────────────────────

import { createServer } from "../src/server/server.ts";

const SPA_PORT = freePort();

/** Wait until the fixture answers HTTP — not a duration.
 *
 *  `createServer` returns once Deno.serve has bound, but under a loaded suite
 *  the first request can still lose a race against accept. Sleeping 50 ms
 *  measured the machine; fetching until we get a response measures the
 *  server. */
async function waitUntilAnswering(url: string, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { redirect: "manual" });
      await resp.body?.cancel().catch(() => {});
      if (resp.status > 0) return;
      last = `status ${resp.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${what} never answered at ${url} — last: ${last}`);
}

Deno.test({
  name: "server: SPA fallback — unknown extensionless path returns HTML",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    // No App.tsx — SPA shell fallback does not need a client graph; a stub
    // used to start graph validation + esbuild for no assertion benefit.
    const server = createServer({
      port: SPA_PORT,
      title: "SPA",
      getUIState: () => ({}),
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: false,
    });
    const base = `http://localhost:${SPA_PORT}`;
    await waitUntilAnswering(base, "SPA fixture");
    try {
      // Client-side routes should return HTML, not 404
      for (
        const path of [
          "/users",
          "/users/42",
          "/dashboard/settings",
          "/any/deep/path",
        ]
      ) {
        const resp = await fetch(`${base}${path}`);
        assertEquals(resp.status, 200, `${path} should return 200`);
        const body = await resp.text();
        assertEquals(
          body.includes("<!DOCTYPE html>"),
          true,
          `${path} should return HTML`,
        );
      }
      // Assets with extensions should still 404
      const r = await fetch(`${base}/missing.js`);
      assertEquals(r.status, 404);
      await r.body?.cancel();
    } finally {
      await server.shutdown();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── typed route params + Link children ────────
import type { LinkProps, RouteState } from "../src/protocol/protocol-types.ts";
import { freePort } from "../src/testing/server-test.ts";

Deno.test("types: RouteState params parameterize; LinkProps children typed", () => {
  // Compile-time probes — fail `deno check` on regression.
  const rs: RouteState<{ id: string }> = {
    path: "/users/42",
    params: { id: "42" },
    search: new URLSearchParams(),
    matched: true,
  };
  const _id: string = rs.params.id;
  const lp: LinkProps = { to: "/x", children: ["text", 42, null] };
  assertEquals(_id, "42");
  assertEquals(lp.to, "/x");
});
