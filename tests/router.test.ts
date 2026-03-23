import { assertEquals } from "@std/assert";
import { matchPath } from "../src/browser.ts";

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

import { createServer } from "../src/server.ts";
import { join } from "@std/path";

const SPA_PORT = 19960;

Deno.test("server: SPA fallback — unknown extensionless path returns HTML", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  const server = createServer({
    port: SPA_PORT,
    title: "SPA",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
  });
  await new Promise((r) => setTimeout(r, 50));
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
      const resp = await fetch(`http://localhost:${SPA_PORT}${path}`);
      assertEquals(resp.status, 200, `${path} should return 200`);
      const body = await resp.text();
      assertEquals(
        body.includes("<!DOCTYPE html>"),
        true,
        `${path} should return HTML`,
      );
    }
    // Assets with extensions should still 404
    const r = await fetch(`http://localhost:${SPA_PORT}/missing.js`);
    assertEquals(r.status, 404);
    await r.body?.cancel();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
