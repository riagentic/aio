// THE BETA PROMISE, made mechanical.
//
// `.katana/goals.md`: "an app that worked will work — or will work after
// `am fix`. A break discovered by debugging is a broken promise."
//
// Until alpha72 that promise was kept by three things that all look at the
// SHAPE of the surface and none that runs it: `check:api` (the export list and
// its signatures), `removals-registry` (what was dropped, and that every
// surface says the same words about it), and `docs-snippets` (every fenced
// example type-checks). All three are necessary. None of them would notice a
// change that keeps the signature, keeps the export, keeps the doc — and
// changes what the code DOES.
//
// So: a corpus. Each case is a small app written the way the docs write it,
// booted on the current build and DRIVEN. The assertion is never "this API
// exists"; it is "this app still behaves". A future change that breaks one
// fails here, naming the shape, instead of failing in someone's product.
//
// The rule for adding to this file: a case earns its place by being a shape
// the documentation TEACHES. It is not a place for edge cases — every other
// test file is — and a case here should read like a page of the docs.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell, race, until } from "../mod.ts";
import { testCell } from "../src/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";

// ── The two files an app is ──────────────────────────────────────────

const counter = cell("promise-counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});

testCell(counter, "the README's counter still counts", async (t) => {
  await t.send.increment();
  await t.send.increment(5);
  assertEquals(t.getState().count, 6);
  await t.send.reset();
  assertEquals(t.getState().count, 0);
});

// ── Async methods: await, cancel, race, until ────────────────────────

const checkout = cell("promise-checkout", {
  state: { status: "idle", paid: false, orderId: null as string | null },
  cancelOn: { place: ["promise-cart:clear"] },
  methods: {
    markPaid(s) {
      s.paid = true;
    },
    async place(s, item: string) {
      s.status = "placing";
      const r = await race({
        paid: until(() => s.paid, { timeoutMs: 5_000 }),
        timeout: 3_000,
      });
      if (r.winner === "timeout") {
        s.status = "expired";
        return;
      }
      if (s.$signal.aborted) return;
      s.orderId = `order-${item}`;
      s.status = "placed";
    },
  },
});

const cart = cell("promise-cart", {
  state: { items: [] as string[] },
  methods: {
    clear(s) {
      s.items = [];
    },
  },
});

testCell(cart, "`cancelOn` still names another cell's method", (t) => {
  // The shape mod.ts's header teaches: `cancelOn: { place: ["cart:clear"] }`.
  // A rename that silently stopped matching would leave a method that can no
  // longer be cancelled and nothing to see, so pin the wiring itself.
  assertEquals(
    checkout.__aio.cancelTriggers,
    { place: ["promise-cart:clear"] },
    "cancelOn must survive as declared — a triggering action that no longer " +
      "matches is a cancellation that silently never happens",
  );
  assertEquals(t.getState().items, []);
});

testCell(checkout, "mod.ts's own header example still runs", async (t) => {
  // The `race` + `until` + `$signal` shape is the first code in mod.ts. If it
  // stops working, the framework's own front page is wrong.
  t.send.place("widget");
  await t.send.markPaid();
  await t.settle();
  assertEquals(t.getState().status, "placed");
  assertEquals(t.getState().orderId, "order-widget");
});

// ── Selectors, machines, validate, access ────────────────────────────

const todos = cell("promise-todos", {
  state: {
    items: [] as { id: string; title: string; done: boolean }[],
  },
  selectors: {
    remaining: (s) => s.items.filter((i) => !i.done).length,
  },
  methods: {
    add(s, title: string) {
      s.items.push({ id: `t${s.items.length}`, title, done: false });
    },
    toggle(s, id: string) {
      const t = s.items.find((i) => i.id === id);
      if (t) t.done = !t.done;
    },
  },
});

testCell(todos, "a selector is still a derived read", async (t) => {
  await t.send.add("one");
  await t.send.add("two");
  // Called, not read — `docs/state/methods.md` writes `todo.remaining()`.
  assertEquals(todos.remaining(), 2);
  await t.send.toggle("t0");
  assertEquals(todos.remaining(), 1);
});

// `machine:` is retired (alpha27). What the docs teach in its place is a guard
// line — one `if` at the top of a method — and it must keep giving the same
// guarantee: a transition that is not legal from the current status is
// IGNORED, not applied.
const door = cell("promise-door", {
  state: { status: "closed" as "closed" | "opened", opens: 0 },
  methods: {
    open(s) {
      if (s.status !== "closed") return; // ignored in any other state
      s.status = "opened";
      s.opens++;
    },
    close(s) {
      if (s.status !== "opened") return;
      s.status = "closed";
    },
  },
});

testCell(
  door,
  "a guard line still refuses an illegal transition",
  async (t) => {
    assertEquals(t.getState().status, "closed");
    await t.send.open();
    assertEquals(t.getState().status, "opened");
    assertEquals(t.getState().opens, 1);
    // Opening an open door is a no-op, silently and deliberately — the whole
    // point of the shape that replaced `machine:`.
    await t.send.open();
    assertEquals(t.getState().opens, 1, "an illegal transition must not apply");
    await t.send.close();
    assertEquals(t.getState().status, "closed");
  },
);

// ── Everything the SERVER promises ───────────────────────────────────

Deno.test("beta promise: state, routes and persist excludes on a real server", async () => {
  const settings = cell("promise-settings", {
    state: { theme: "dark", apiKey: "secret-value" },
    // The two independent channels, exactly as the auth doc writes them.
    persist: { exclude: ["apiKey"] },
    visible: { exclude: ["apiKey"] },
    methods: {
      setTheme(s, t: string) {
        s.theme = t;
      },
    },
  });

  await using server = await testServer({
    cells: [settings],
    routes: {
      "/promise/theme": () => Response.json({ theme: settings.theme }),
      "/promise/echo/*": (req) => new Response(new URL(req.url).pathname),
    },
  });

  // A route sees live cell state.
  assertEquals(await (await server.fetch("/promise/theme")).json(), {
    theme: "dark",
  });
  await settings.setTheme("light");
  assertEquals(await (await server.fetch("/promise/theme")).json(), {
    theme: "light",
  });

  // A wildcard route still matches below its prefix.
  assertEquals(
    await (await server.fetch("/promise/echo/a/b")).text(),
    "/promise/echo/a/b",
  );

  // `visible: { exclude }` keeps the secret out of what a client sees. The
  // shell is the first thing every client fetches, so it is the first place a
  // leak would show — and this is the shape the auth doc tells people to trust
  // with an API key.
  const html = await (await server.fetch("/")).text();
  assertEquals(
    html.includes("secret-value"),
    false,
    "a `visible: exclude` field reached the served page",
  );
  assertEquals(settings.__aio.ui, { exclude: ["apiKey"] });
  assertEquals(settings.__aio.persist, { exclude: ["apiKey"] });
});

Deno.test("beta promise: lifecycle hooks still fire, in order", async () => {
  const seen: string[] = [];
  const marker = cell("promise-hooks", {
    state: { n: 0 },
    methods: {
      go(s) {
        s.n++;
      },
    },
  });
  {
    await using server = await testServer({
      cells: [marker],
      onStart: () => void seen.push("start"),
      onAction: (a) => void seen.push(`action:${(a as { type: string }).type}`),
      onStop: () => void seen.push("stop"),
    });
    await marker.go();
    assertEquals(server.state !== undefined, true);
  }
  // The real order, pinned rather than assumed: a cell's own `__init` action
  // runs BEFORE the app's `onStart` (the cells are up before the app is told
  // it started), the method's action lands between start and stop, and `stop`
  // is last. Writing down the order is the point — a change to it is a change
  // an app can see.
  const startAt = seen.indexOf("start");
  const goAt = seen.findIndex((s) => s.endsWith(":go"));
  assert(startAt >= 0, `onStart never fired: ${JSON.stringify(seen)}`);
  assert(
    goAt > startAt,
    `the dispatch must land after start: ${JSON.stringify(seen)}`,
  );
  assertEquals(seen.at(-1), "stop", JSON.stringify(seen));
});

Deno.test("beta promise: the health endpoint still answers", async () => {
  const marker = cell("promise-health", { state: { n: 0 }, methods: {} });
  await using server = await testServer({ cells: [marker] });
  const res = await server.fetch("/__aio/health");
  assertEquals(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert("status" in body || "ok" in body, JSON.stringify(body).slice(0, 200));
});

Deno.test("beta promise: the shell is served, and it is a page", async () => {
  const marker = cell("promise-shell", { state: { n: 0 }, methods: {} });
  await using server = await testServer({ cells: [marker] });
  const html = await (await server.fetch("/")).text();
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "<html lang=");
  assertStringIncludes(html, "<title>");
  assert(
    /<script[^>]*>/.test(html),
    "the page has to load a client module, or nothing an app does is visible",
  );
});

// ── What alpha72 ADDED must not have changed what alpha71 DID ────────

Deno.test("beta promise: an app that declares no `security` is served as before", async () => {
  // The new response finisher runs on EVERY response. The compatibility rule
  // it obeys is that a body comes back byte-identical unless the client asked
  // for an encoding — so an app upgrading from alpha71 sees the same bytes.
  const marker = cell("promise-bytes", { state: { n: 0 }, methods: {} });
  await using server = await testServer({
    cells: [marker],
    routes: {
      "/promise/plain": () =>
        new Response("x".repeat(5000), {
          headers: { "Content-Type": "text/plain" },
        }),
    },
  });
  // `fetch` sends `Accept-Encoding` of its own and decodes transparently, so
  // the caller sees the bytes the route wrote — which IS the compatibility
  // guarantee: the transfer encoding changed, the body did not.
  const res = await server.fetch("/promise/plain");
  const body = await res.text();
  assertEquals(body.length, 5000);
  assertEquals(body, "x".repeat(5000));

  // And a client that asks for nothing gets exactly what the route wrote,
  // unencoded — the alpha71 wire, byte for byte.
  const plain = await fetch(`${server.url}/promise/plain`, {
    headers: { "Accept-Encoding": "identity" },
  });
  assertEquals(plain.headers.get("Content-Encoding"), null);
  assertEquals((await plain.text()).length, 5000);
});

Deno.test("beta promise: an app that declares no `plugins` boots identically", async () => {
  const marker = cell("promise-noplugins", {
    state: { n: 0 },
    methods: {
      go(s) {
        s.n++;
      },
    },
  });
  await using server = await testServer({ cells: [marker] });
  await marker.go();
  assertEquals(
    (server.state() as { "promise-noplugins": { n: number } })[
      "promise-noplugins"
    ].n,
    1,
  );
});

Deno.test("beta promise: `ui.dir` absent means the html tag is unchanged", async () => {
  const marker = cell("promise-dir", { state: { n: 0 }, methods: {} });
  await using server = await testServer({ cells: [marker] });
  const html = await (await server.fetch("/")).text();
  assertEquals(
    html.includes(" dir="),
    false,
    "an app that never asked for a direction must not suddenly declare one",
  );
});
