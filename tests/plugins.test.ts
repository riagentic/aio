// Plugins — a reusable piece of app, and the four rules that make it safe.
//
// The design is deliberately small: a plugin contributes through the SAME
// config keys `aio.run()` already has, so it can never do anything the app
// could not have written itself, and reading the merged config still explains
// the whole app. What this file pins is the part that is easy to get wrong —
// who wins a conflict, and whether a conflict is even noticed.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { definePlugin } from "../src/server/plugin.ts";
import {
  composeAsyncHooks,
  composeHooks,
  resolvePlugins,
} from "../src/server/plugin.ts";

const CTX = { appId: "test-app", dev: true };

const cellA = cell("plug-a", {
  state: { n: 0 },
  methods: {
    go(s) {
      s.n++;
    },
  },
});
const cellB = cell("plug-b", {
  state: { m: 0 },
  methods: {
    go(s) {
      s.m++;
    },
  },
});

async function rejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw, got none");
}

Deno.test("plugin: definePlugin refuses an unnamed plugin, and says why", () => {
  const e = assertThrows(
    () => definePlugin({ name: "" } as never),
  ) as Error;
  assertStringIncludes(e.message, "needs a `name`");
  assertStringIncludes(
    e.message,
    "collision message",
    "the message must say what the name is FOR",
  );
});

Deno.test("plugin: nothing declared, nothing changes", async () => {
  const r = await resolvePlugins(undefined, CTX);
  assertEquals(r.names, []);
  assertEquals(r.cells, []);
  assertEquals(r.routes, {});
  assertEquals(r.onAction, []);
});

Deno.test("plugin: contributions are collected in declaration order", async () => {
  const one = definePlugin({
    name: "one",
    cells: [cellA],
    routes: { "/one": () => new Response("1") },
    allowedOrigins: ["a.com"],
  });
  const two = definePlugin({
    name: "two",
    cells: [cellB],
    routes: { "/two": () => new Response("2") },
    allowedOrigins: ["a.com", "b.com"],
  });
  const r = await resolvePlugins([one, two], CTX);
  assertEquals(r.names, ["one", "two"]);
  assertEquals(r.cells.map((c) => c.__aio.id), ["plug-a", "plug-b"]);
  assertEquals(Object.keys(r.routes), ["/one", "/two"]);
  assertEquals(
    r.allowedOrigins,
    ["a.com", "b.com"],
    "origins merge and dedupe — a plugin must not be able to REPLACE the list",
  );
});

// ── Rule 3: a collision is loud, at boot, naming both sides ──

Deno.test("plugin: two plugins claiming one route throw, naming BOTH", async () => {
  const e = await rejects(() =>
    resolvePlugins([
      definePlugin({
        name: "metrics",
        routes: { "/health": () => new Response("a") },
      }),
      definePlugin({
        name: "probes",
        routes: { "/health": () => new Response("b") },
      }),
    ], CTX)
  );
  assertStringIncludes(e.message, "/health");
  assertStringIncludes(e.message, "metrics");
  assertStringIncludes(e.message, "probes");
  assertStringIncludes(
    e.message,
    "silently shadow",
    "the message must say WHY this is refused rather than resolved",
  );
});

Deno.test("plugin: two plugins claiming one cell throw", async () => {
  const e = await rejects(() =>
    resolvePlugins([
      definePlugin({ name: "p1", cells: [cellA] }),
      definePlugin({ name: "p2", cells: [cellA] }),
    ], CTX)
  );
  assertStringIncludes(e.message, "cell");
  assertStringIncludes(e.message, "plug-a");
  assertStringIncludes(e.message, "p1");
  assertStringIncludes(e.message, "p2");
});

Deno.test("plugin: the same plugin listed twice is refused", async () => {
  const p = definePlugin({ name: "dup", onAction: () => {} });
  const e = await rejects(() => resolvePlugins([p, p], CTX));
  assertStringIncludes(e.message, "listed twice");
  assertStringIncludes(
    e.message,
    "double every hook",
    "an app author needs to know what listing it twice WOULD have done",
  );
});

Deno.test("plugin: a non-plugin in the list is refused by position", async () => {
  const e = await rejects(() =>
    resolvePlugins(
      [definePlugin({ name: "ok" }), null as never],
      CTX,
    )
  );
  assertStringIncludes(e.message, "definePlugin");
});

// ── setup() ──

Deno.test("plugin: setup() runs once and its result merges the same way", async () => {
  let calls = 0;
  const p = definePlugin({
    name: "lazy",
    routes: { "/static": () => new Response("s") },
    setup() {
      calls++;
      return { routes: { "/computed": () => new Response("c") } };
    },
  });
  const r = await resolvePlugins([p], CTX);
  assertEquals(calls, 1);
  assertEquals(Object.keys(r.routes).sort(), ["/computed", "/static"]);
});

Deno.test("plugin: setup() is told who else is present", async () => {
  let seen: readonly string[] = [];
  const r = await resolvePlugins([
    definePlugin({ name: "first" }),
    definePlugin({
      name: "second",
      setup(ctx) {
        seen = ctx.plugins;
        assertEquals(ctx.appId, "test-app");
        assertEquals(ctx.dev, true);
      },
    }),
  ], CTX);
  assertEquals(seen, ["first", "second"]);
  assertEquals(r.names, ["first", "second"]);
});

Deno.test("plugin: a setup() that throws refuses the boot and NAMES the plugin", async () => {
  const e = await rejects(() =>
    resolvePlugins([
      definePlugin({
        name: "needs-env",
        setup() {
          throw new Error("STRIPE_KEY is not set");
        },
      }),
    ], CTX)
  );
  assertStringIncludes(e.message, 'plugin "needs-env" failed to set up');
  assertStringIncludes(
    e.message,
    "STRIPE_KEY is not set",
    "the plugin's own reason must survive — it is the actionable half",
  );
  assert(e.cause instanceof Error, "and the original error is the cause");
});

Deno.test("plugin: an async setup() is awaited", async () => {
  const r = await resolvePlugins([
    definePlugin({
      name: "async",
      async setup() {
        await new Promise((res) => setTimeout(res, 5));
        return { allowedOrigins: ["late.com"] };
      },
    }),
  ], CTX);
  assertEquals(r.allowedOrigins, ["late.com"]);
});

// ── Rule 4: hooks compose, and one bad hook never stops the next ──

Deno.test("hooks: every hook runs, plugins first and the app LAST", () => {
  const order: string[] = [];
  const composed = composeHooks(
    [() => order.push("p1"), () => order.push("p2")],
    () => order.push("app"),
    () => {},
  )!;
  composed();
  assertEquals(order, ["p1", "p2", "app"]);
});

Deno.test("hooks: a throwing hook is reported and the rest still run", () => {
  const order: string[] = [];
  const errors: unknown[] = [];
  const composed = composeHooks(
    [
      () => {
        order.push("p1");
        throw new Error("bad plugin");
      },
      () => order.push("p2"),
    ],
    () => order.push("app"),
    (e) => errors.push(e),
  )!;
  composed();
  assertEquals(
    order,
    ["p1", "p2", "app"],
    "lifecycle hooks are observe-only and never break dispatch — one " +
      "plugin's bug must not silence the app's own hook",
  );
  assertEquals(errors.length, 1);
});

Deno.test("hooks: no hooks at all stays undefined, not an empty function", () => {
  assertEquals(composeHooks([], undefined, () => {}), undefined);
  assertEquals(
    composeAsyncHooks([], undefined, "start", () => {}),
    undefined,
    "an app with no hooks must not pay for a wrapper on every action",
  );
});

Deno.test("hooks: one hook is passed through untouched", () => {
  const only = () => {};
  assertEquals(composeHooks([], only, () => {}), only);
});

Deno.test("hooks: onStop unwinds in the REVERSE of onStart", async () => {
  const order: string[] = [];
  const start = composeAsyncHooks(
    [() => void order.push("p1-up"), () => void order.push("p2-up")],
    () => void order.push("app-up"),
    "start",
    () => {},
  )!;
  const stop = composeAsyncHooks(
    [() => void order.push("p1-down"), () => void order.push("p2-down")],
    () => void order.push("app-down"),
    "stop",
    () => {},
  )!;
  await start();
  await stop();
  assertEquals(
    order,
    ["p1-up", "p2-up", "app-up", "app-down", "p2-down", "p1-down"],
    "a plugin that opened something on start closes it AFTER the app code " +
      "that was using it has finished",
  );
});

Deno.test("hooks: an async hook is awaited before the next one starts", async () => {
  const order: string[] = [];
  const composed = composeAsyncHooks(
    [
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("slow");
      },
    ],
    () => void order.push("fast"),
    "start",
    () => {},
  )!;
  await composed();
  assertEquals(order, ["slow", "fast"]);
});

Deno.test("hooks: a rejecting async hook is reported, and the rest still run", async () => {
  const order: string[] = [];
  const errors: unknown[] = [];
  const composed = composeAsyncHooks(
    [
      () => Promise.reject(new Error("plugin start failed")),
      () => void order.push("p2"),
    ],
    () => void order.push("app"),
    "start",
    (e) => errors.push(e),
  )!;
  await composed();
  assertEquals(order, ["p2", "app"]);
  assertEquals(errors.length, 1);
});

// ── End to end: a plugin in a real booted app ──
//
// Everything above tests the merge in isolation. This is the part that would
// otherwise be a claim: that `plugins: [...]` on a real `aio.run()` actually
// serves the route, composes the cell, and fires the hook.

Deno.test("plugin e2e: a plugin's route, cell and hook are all live", async () => {
  const seen: string[] = [];
  const audit = cell("plugin-audit", {
    state: { count: 0 },
    methods: {
      record(s) {
        s.count++;
      },
    },
  });
  const plugin = definePlugin({
    name: "audit",
    cells: [audit],
    routes: {
      "/__plugin/audit": () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        }),
    },
    onAction: (a) => {
      seen.push((a as { type: string }).type);
    },
    onStart: () => {
      seen.push("started");
    },
  });

  await using server = await testServer({
    cells: [plugin.cells![0]!],
    plugins: [plugin],
  });

  // The route the plugin contributed is served by the app.
  const res = await server.fetch("/__plugin/audit");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });

  // The cell it contributed is composed and dispatchable.
  await audit.record();
  assertEquals(
    (server.state() as { "plugin-audit": { count: number } })["plugin-audit"]
      .count,
    1,
  );

  // And its onAction saw the dispatch.
  assert(
    seen.some((t) => t.includes("record")),
    `the plugin's onAction never fired — saw ${JSON.stringify(seen)}`,
  );
});

Deno.test("plugin e2e: the APP's route wins over a plugin's", async () => {
  const plugin = definePlugin({
    name: "shadowed",
    routes: { "/__plugin/who": () => new Response("plugin") },
  });
  const marker = cell("plugin-who", { state: { x: 0 }, methods: {} });
  await using server = await testServer({
    cells: [marker],
    plugins: [plugin],
    routes: { "/__plugin/who": () => new Response("app") },
  });
  assertEquals(
    await (await server.fetch("/__plugin/who")).text(),
    "app",
    "adding a plugin must never take a behaviour away from the app",
  );
});

Deno.test("plugin e2e: a plugin that cannot set itself up refuses the BOOT", async () => {
  const marker = cell("plugin-boom", { state: { x: 0 }, methods: {} });
  const e = await rejects(async () => {
    const s = await testServer({
      cells: [marker],
      plugins: [
        definePlugin({
          name: "broken",
          setup() {
            throw new Error("no credentials");
          },
        }),
      ],
    });
    await s.close();
  });
  assertStringIncludes(e.message, 'plugin "broken" failed to set up');
  assertStringIncludes(
    e.message,
    "no credentials",
    "a half-existing plugin — cells composed, routes absent — is the failure " +
      "this refusal prevents",
  );
});

// ── Found by the randomized audit (scripts/audit-round.ts) ──

Deno.test("plugin: a duplicate inside ONE plugin's list is a duplicate, not a collision", async () => {
  // `cells: [...core, ...extra]` with an overlap, or a `setup()` returning
  // something the static list already had, produced
  // `claimed by both "audit" and "audit"` — a message naming one plugin twice
  // and telling its author nothing. Found by `audit-round.ts 6`.
  const r = await resolvePlugins([
    definePlugin({
      name: "dup-inside",
      cells: [cellA, cellA, cellB],
      routes: { "/x": () => new Response("1") },
      setup: () => ({
        cells: [cellA],
        routes: { "/x": () => new Response("2") },
      }),
    }),
  ], CTX);
  assertEquals(
    r.cells.map((c) => c.__aio.id),
    ["plug-a", "plug-b"],
    "the same cell twice means once",
  );
  assertEquals(Object.keys(r.routes), ["/x"]);
});

Deno.test("plugin: a lone plugin hook is guarded too", () => {
  // A single hook used to be returned by identity, so ONE plugin's throwing
  // onAction propagated while TWO plugins' were both caught — installing a
  // second plugin silently changed the first one's error behaviour. The
  // passthrough is only safe when the one function is the APP's own.
  // Found by `audit-round.ts 7`.
  const errs: unknown[] = [];
  const composed = composeHooks(
    [() => {
      throw new Error("lone plugin");
    }],
    undefined,
    (e) => errs.push(e),
  )!;
  composed(); // must not throw
  assertEquals(errs.length, 1);

  // An app's own lone hook keeps exactly the behaviour it had before plugins
  // existed: passed through, its errors handled by whoever handled them.
  const own = () => {};
  assertEquals(composeHooks([], own, () => {}), own);
});
