import { assertEquals, assertNotEquals } from "@std/assert";
import { aio, cell } from "../src/browser/protocol-cell.ts";
import { matchPath } from "../src/browser/protocol-router.ts";

// ── protocol-cell: cell() — method catalog builder ─────────────────

Deno.test("protocol-cell: __aio internals contain state, id, action/effect keys", () => {
  const c = cell("app", {
    state: { count: 0 },
    methods: { inc: () => {} },
    effects: { log: (msg: string) => ({ msg }) },
  });
  const aioMeta = c.__aio as {
    state: { count: number };
    id: string;
    actionKeys: string[];
    effectKeys: string[];
  };
  assertEquals(aioMeta.state, { count: 0 });
  assertEquals(aioMeta.id, "app");
  assertEquals(aioMeta.actionKeys, ["inc"]);
  assertEquals(aioMeta.effectKeys, ["log"]);
});

Deno.test("protocol-cell: effects catalog has correct types", () => {
  const c = cell("app", {
    state: {},
    methods: { go: () => {} },
    effects: { persist: (v: number) => ({ v }), notify: () => ({}) },
  });
  const aioMeta = c.__aio as {
    effects: Record<
      string,
      { type: string } & ((...args: unknown[]) => unknown)
    >;
  };
  assertEquals(aioMeta.effects.persist!.type, "app:persist");
  assertEquals(aioMeta.effects.notify!.type, "app:notify");
  assertEquals(aioMeta.effects.persist!(42), {
    type: "app:persist",
    payload: { v: 42 },
  });
});

Deno.test("protocol-cell: methods mode generates args-style payload", () => {
  const c = cell("editor", {
    state: { text: "" },
    methods: {
      setText: (s: { text: string }, t: string) => {
        s.text = t;
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  const setText = c.setText as any;
  assertEquals(setText.type, "editor:setText");
  assertEquals(setText("hello"), {
    type: "editor:setText",
    payload: { args: ["hello"] },
  });
});

Deno.test("protocol-cell: methods with no args produces empty args array", () => {
  const c = cell("clock", {
    state: { running: false },
    methods: { toggle: () => {} },
  });
  const toggle = c.toggle as () => {
    type: string;
    payload: { args: unknown[] };
  };
  assertEquals(toggle(), { type: "clock:toggle", payload: { args: [] } });
});

Deno.test("protocol-cell: missing state defaults to empty object", () => {
  const c = cell("bare", { methods: { go: () => {} } });
  const aioMeta = c.__aio as { state: Record<string, unknown> };
  assertEquals(aioMeta.state, {});
});

Deno.test("protocol-cell: missing effects defaults to empty", () => {
  const c = cell("noeff", { methods: { go: () => {} } });
  const aioMeta = c.__aio as { effectKeys: string[] };
  assertEquals(aioMeta.effectKeys, []);
});

Deno.test("protocol-cell: bound flag starts false", () => {
  const c = cell("test", { methods: { x: () => {} } });
  const aioMeta = c.__aio as { bound: boolean };
  assertEquals(aioMeta.bound, false);
});

Deno.test("protocol-cell: multiple methods each get unique types", () => {
  const c = cell("multi", {
    methods: {
      a: () => {},
      b: (_s: Record<string, unknown>, _x: number) => {},
      c: (_s: Record<string, unknown>, _t: string, _n: number) => {},
    },
  });
  const a = c.a as { type: string };
  const b = c.b as { type: string };
  const cMethod = c.c as { type: string };
  assertEquals(a.type, "multi:a");
  assertEquals(b.type, "multi:b");
  assertEquals(cMethod.type, "multi:c");
});

// ── protocol-cell: aio stub ─────────────────────────────────────────

Deno.test("aio stub: run returns resolved promise", async () => {
  const result = await aio.run();
  assertEquals(result, undefined);
});

// ── protocol-router: matchPath() ───────────────────────────────────

Deno.test("matchPath: exact match of static path", () => {
  const result = matchPath("/about", "/about");
  assertNotEquals(result, null);
  assertEquals(result, {});
});

Deno.test("matchPath: exact match with trailing slash", () => {
  const result = matchPath("/about", "/about/");
  assertNotEquals(result, null);
});

Deno.test("matchPath: exact match fails on different path", () => {
  const result = matchPath("/about", "/contact");
  assertEquals(result, null);
});

Deno.test("matchPath: named param extraction", () => {
  const result = matchPath("/users/:id", "/users/42");
  assertNotEquals(result, null);
  assertEquals(result!.id, "42");
});

Deno.test("matchPath: multiple named params", () => {
  const result = matchPath("/users/:userId/posts/:postId", "/users/7/posts/99");
  assertNotEquals(result, null);
  assertEquals(result!.userId, "7");
  assertEquals(result!.postId, "99");
});

Deno.test("matchPath: wildcard captures rest of path", () => {
  const result = matchPath("/files/*", "/files/docs/readme.md");
  assertNotEquals(result, null);
  assertEquals(result!["*"], "docs/readme.md");
});

Deno.test("matchPath: wildcard strips trailing slash", () => {
  const result = matchPath("/files/*", "/files/docs/");
  assertNotEquals(result, null);
  assertEquals(result!["*"], "docs");
});

Deno.test("matchPath: non-exact mode matches prefix", () => {
  const result = matchPath("/app", "/app/dashboard/settings", false);
  assertNotEquals(result, null);
});

Deno.test("matchPath: exact mode rejects partial match", () => {
  const result = matchPath("/app", "/app/dashboard", true);
  assertEquals(result, null);
});

Deno.test("matchPath: root path matches root", () => {
  const result = matchPath("/", "/");
  assertNotEquals(result, null);
});

Deno.test("matchPath: decodes URI-encoded params", () => {
  const result = matchPath("/search/:query", "/search/hello%20world");
  assertNotEquals(result, null);
  assertEquals(result!.query, "hello world");
});

Deno.test("matchPath: empty path does not match non-root", () => {
  const result = matchPath("/users/:id", "/");
  assertEquals(result, null);
});

Deno.test("matchPath: param with special regex chars in static segment", () => {
  const result = matchPath("/api.v2/users/:id", "/api.v2/users/1");
  assertNotEquals(result, null);
  assertEquals(result!.id, "1");
});

Deno.test("matchPath: mixed static and param segments", () => {
  const result = matchPath(
    "/api/v1/users/:id/profile",
    "/api/v1/users/42/profile",
  );
  assertNotEquals(result, null);
  assertEquals(result!.id, "42");
});

Deno.test("matchPath: param with invalid URI encoding falls back to raw value", () => {
  // %ZZ is not valid percent-encoding — decodeURIComponent would throw
  const result = matchPath("/search/:q", "/search/%ZZ");
  assertNotEquals(result, null);
  assertEquals(result!.q, "%ZZ");
});
