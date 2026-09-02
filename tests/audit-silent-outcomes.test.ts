// The second audit batch — every one a silent-wrong-outcome or a silent hang,
// which is the class this project treats as disqualifying.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { matchRoute } from "../src/server/route.ts";

// ── M9: a `*` that is not last silently over-matches ─────────────────────────
// `matchRoute` returns the moment it reaches a `*`, so everything written after
// it is never checked. The docstring only advertised a TRAILING wildcard;
// nothing enforced it, so a pattern that answers requests it does not describe
// was accepted at boot and wrong at runtime.

Deno.test("M9: the over-matching is real — this is why it is refused", () => {
  // Documenting the mechanism, not endorsing it: `/files/*/x` demands an `/x`
  // that is never verified.
  assert(matchRoute("/files/*/x", "/files/foo") !== null);
  assert(matchRoute("/files/*/x", "/files/a/b/c") !== null);
  // …while a TRAILING wildcard means exactly what it says.
  assertEquals(matchRoute("/files/*", "/files/a/b")?.["*"], "a/b");
  assertEquals(matchRoute("/files/*", "/other/a"), null);
});

Deno.test("M9: a non-trailing wildcard is refused at boot", async () => {
  const { aio, cell } = await import("../mod.ts");
  const c = cell("m9probe", { state: { n: 0 }, methods: {} });
  const err = await assertRejects(() =>
    aio.run({
      cells: [c],
      appId: `m9-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      port: 0,
      baseDir: Deno.makeTempDirSync(),
      routes: { "/files/*/x": () => new Response("no") },
    } as never)
  );
  const msg = (err as Error).message;
  assert(msg.includes('"*" must be the LAST segment'), msg);
  // A refusal that does not say what to write instead is half a refusal.
  assert(msg.includes("/files/*"), `must suggest the fix: ${msg}`);
});

// ── M8: a subscriber's bug cannot un-commit a write ──────────────────────────

Deno.test("M8: a throwing live-query subscriber does not fail the write", async () => {
  const { createDB } = await import("../src/server-entry.ts");
  const { reactiveDB } = await import("../src/db/reactive.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-m8-" });
  const db = reactiveDB(await createDB(`${dir}/t.db`));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const q = await db.select("SELECT * FROM t");
    q.subscribe(() => {
      throw new Error("subscriber bug");
    });
    // The write COMMITS. Before this, the throw propagated out of invalidate()
    // → execute(), so the caller was told a landed write had failed — and might
    // retry it.
    await db.execute("INSERT INTO t (v) VALUES ('a')");
    const rows = await db.query("SELECT * FROM t");
    assertEquals(rows.rows.length, 1, "the write is committed and visible");
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("M8: one bad subscriber does not starve the others", async () => {
  const { createDB } = await import("../src/server-entry.ts");
  const { reactiveDB } = await import("../src/db/reactive.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-m8b-" });
  const db = reactiveDB(await createDB(`${dir}/t.db`));
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const q = await db.select("SELECT * FROM t");
    let good = 0;
    q.subscribe(() => {
      throw new Error("bad");
    });
    q.subscribe(() => good++);
    await db.execute("INSERT INTO t (v) VALUES ('a')");
    assertEquals(good, 1, "the second subscriber still ran");
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── L20: `kid` binds a token to the key that signed it ───────────────────────
// The old `|| keys.length === 1` dropped that binding whenever the issuer
// published exactly one key. Not an auth bypass — the signature check still ran
// — but the binding is what makes key ROTATION meaningful, and "correct until
// the issuer adds a second key" is not a property worth having.

Deno.test("L20: a declared kid must match, even with one published key", async () => {
  const { _selectJwk } = await import("../src/server/auth-oidc.ts");
  const keys = [{ kid: "real", kty: "RSA" }];
  assertEquals(_selectJwk(keys, "real"), keys[0], "the right kid resolves");
  assertEquals(
    _selectJwk(keys, "forged"),
    undefined,
    "a token naming another key must not verify against the only one there",
  );
});

Deno.test("L20: an issuer publishing no kid at all still works", async () => {
  // Some issuers publish none; refusing them would break a working setup to
  // enforce a field they never send.
  const { _selectJwk } = await import("../src/server/auth-oidc.ts");
  const keys = [{ kty: "RSA" }];
  assertEquals(_selectJwk(keys, undefined), keys[0]);
  assertEquals(
    _selectJwk([{ kty: "RSA" }, { kty: "RSA" }], undefined),
    undefined,
  );
});

// The same rule one level up: the SUBSCRIBERS were isolated, the re-run that
// feeds them was not. `rerun()` calls `db.query(sql)`, and that can throw on
// its own — a busy database, a view whose SQL stopped resolving — travelling
// the identical road (invalidate → execute) to reject a write that had already
// committed. One rule for the whole path: after the commit, nothing a REFRESH
// does can describe the write as undone. Stale rows are loud instead.
Deno.test("M8: a live query that fails to REFRESH does not fail the write", async () => {
  const { createDB } = await import("../src/server-entry.ts");
  const { reactiveDB } = await import("../src/db/reactive.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-m8c-" });
  const inner = await createDB(`${dir}/t.db`);
  await inner.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

  // A DB whose query() starts failing after the live view is established —
  // the transient failure, without needing to wedge a real SQLite.
  let failQueries = false;
  const flaky = new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "query") {
        return (sql: string, params?: unknown[]) =>
          failQueries
            ? Promise.reject(new Error("database is locked"))
            : target.query(sql, params);
      }
      return Reflect.get(target, prop, recv);
    },
  });
  // deno-lint-ignore no-explicit-any
  const db = reactiveDB(flaky as any);
  try {
    const q = await db.select("SELECT * FROM t"); // initial fill still works
    let notified = 0;
    q.subscribe(() => notified++);
    failQueries = true;

    // The write must land and REPORT that it landed.
    await db.execute("INSERT INTO t (v) VALUES ('a')");

    failQueries = false;
    const rows = await inner.query("SELECT * FROM t");
    assertEquals(rows.rows.length, 1, "the write is committed and visible");
    assertEquals(notified, 0, "a refresh that failed notifies nobody");
    // …and the query recovers on the next successful refresh, rather than
    // being permanently detached from the feed.
    await q.refresh();
    assertEquals(q.rows.length, 1, "the live view catches up");
  } finally {
    await inner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

// The initial fill is the one place a query failure MUST still throw: no write
// has happened, and a select() that cannot run is the caller's own error.
Deno.test("M8: select() itself still fails loudly when the query cannot run", async () => {
  const { createDB } = await import("../src/server-entry.ts");
  const { reactiveDB } = await import("../src/db/reactive.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-m8d-" });
  const db = reactiveDB(await createDB(`${dir}/t.db`));
  try {
    await assertRejects(
      () => db.select("SELECT * FROM does_not_exist"),
      Error,
      undefined,
      "a live query over a missing table is a broken select, not stale rows",
    );
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── A declared route with no handler answered 200 text/html ──────────────────
// The boot loop that refuses a bad route KEY never looked at the handler, and
// `Object.keys` visits a key whose value is `undefined` — which is exactly what
// a typo'd or missing import leaves behind. `matchRoute` treats a falsy handler
// as no match, so the request fell through to the app shell: HTTP 200,
// content-type text/html, on a route the app declared as an API. A caller sees
// success and parses HTML as JSON, failing far from the cause. Nothing was
// logged, at boot or per request. A non-function value is the same mistake one
// step louder — a 500 and a `handler is not a function` line, but only once
// someone hits the path, and forever after.

async function runWithRoutes(routes: unknown, tag: string): Promise<string> {
  const { aio, cell } = await import("../mod.ts");
  const c = cell(`rh${tag}probe`, { state: { n: 0 }, methods: {} });
  const dir = Deno.makeTempDirSync();
  try {
    const err = await assertRejects(() =>
      aio.run({
        cells: [c],
        appId: `rh-${tag}-${Deno.pid}`,
        client: "server-only",
        persist: false,
        libraryMode: true,
        port: 0,
        baseDir: dir,
        routes,
      } as never)
    );
    return (err as Error).message;
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("a route whose handler is undefined is refused at boot", async () => {
  const msg = await runWithRoutes(
    { "/api/things": undefined },
    "undef",
  );
  assert(msg.includes('"/api/things"'), `must name the route: ${msg}`);
  assert(msg.includes("undefined"), `must name the value: ${msg}`);
  // A refusal that does not say what to look for is half a refusal — and the
  // cause is almost always the import, not the route.
  assert(msg.includes("import"), `must name the likely cause: ${msg}`);
});

Deno.test("a route whose handler is not a function is refused at boot", async () => {
  const msg = await runWithRoutes({ "/api/things": "hello" }, "str");
  assert(msg.includes('"/api/things"'), `must name the route: ${msg}`);
  assert(msg.includes("string"), `must name the value's type: ${msg}`);
});

// ── A hook that never runs was completely invisible ──────────────────────────
// `onStart: mod.bootUP` — one letter off, so `undefined` — booted an app that
// reported `"status": "healthy"` while the startup work it names never
// happened. Nothing was logged, at boot or after. Measured, not reasoned about.
//
// The two cases are not equally knowable, so they get different answers: a
// non-function has no working reading and throws, while an explicit `undefined`
// warns — `onStart: opts.onStart` and `onStart: isDev ? devBoot : undefined`
// are both legitimate, so refusing them would break working apps. An ABSENT
// key says nothing at all; writing the key is what declares the intent.

/** See warningsDuring in big-state-warning-uds.test.ts: a LogSink receives
 *  `pub(level, category, message)`. A mock shaped like the CALLER intercepts
 *  nothing and reads as "the code never warned". */
async function warnsFrom(config: Record<string, unknown>): Promise<string[]> {
  const { validateCallableConfig } = await import("../src/server/config.ts");
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    validateCallableConfig(config);
  } finally {
    setLogger(prev);
  }
  return seen;
}

Deno.test("a hook declared as undefined warns — it would otherwise never run", async () => {
  const warnings = await warnsFrom({ onStart: undefined });
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assert(warnings[0]!.includes("onStart"), warnings[0]);
  assert(
    warnings[0]!.includes("import"),
    `must name the likely cause: ${warnings[0]}`,
  );
  // …and it must say how to make the absence deliberate, or the only way to
  // silence a false positive is to stop reading warnings.
  assert(warnings[0]!.includes("omit the key"), warnings[0]);
});

Deno.test("an ABSENT hook is silent — writing the key is what declares intent", async () => {
  assertEquals(await warnsFrom({ appId: "x" }), []);
  assertEquals(await warnsFrom({ onStart: () => {} }), []);
});

Deno.test("every callable config key is checked, not just onStart", async () => {
  for (
    const key of [
      "onAction",
      "onEffect",
      "onConnect",
      "onDisconnect",
      "onStopping",
      "onStop",
      "onError",
      "onRestore",
      "beforeReduce",
      "resolveUser",
    ]
  ) {
    const warnings = await warnsFrom({ [key]: undefined });
    assertEquals(warnings.length, 1, `${key} was not checked`);
    assert(warnings[0]!.includes(key), warnings[0]);
  }
});

Deno.test("a hook that is not a function is refused at boot", async () => {
  const { aio, cell } = await import("../mod.ts");
  const c = cell("hookprobe", { state: { n: 0 }, methods: {} });
  const dir = Deno.makeTempDirSync();
  try {
    const err = await assertRejects(() =>
      aio.run({
        cells: [c],
        appId: `hook-${Deno.pid}`,
        client: "server-only",
        persist: false,
        libraryMode: true,
        port: 0,
        baseDir: dir,
        onStart: "boot",
      } as never)
    );
    const msg = (err as Error).message;
    assert(msg.includes("onStart must be a function"), msg);
    assert(msg.includes("string"), `must name the value's type: ${msg}`);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a db mapping that is not a table is refused, by name", async () => {
  // Same shape as the cells[] fix: a typo'd `table()` import leaves undefined,
  // which reached `dbMappingOf` as `"table" in entry` — "Cannot use 'in'
  // operator to search for 'table' in undefined", naming neither the mapping
  // nor the cause, while the loop had the key in scope the whole time.
  const { aio, cell } = await import("../mod.ts");
  const c = cell("dbmapprobe", {
    state: { items: [] as Array<{ id: number }> },
    methods: {},
  });
  const dir = Deno.makeTempDirSync();
  try {
    const err = await assertRejects(() =>
      aio.run({
        cells: [c],
        appId: `dbmap-${Deno.pid}`,
        client: "server-only",
        persist: false,
        libraryMode: true,
        singleton: false,
        port: 0,
        baseDir: dir,
        dbPath: ":memory:",
        db: { "dbmapprobe.items": undefined },
      } as never)
    );
    const msg = (err as Error).message;
    assertStringIncludes(msg, '"dbmapprobe.items"');
    assertStringIncludes(msg, "not a table");
    assertStringIncludes(msg, "import");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

// ── The hook guard must not warn about hooks the app never wrote ─────────────
// The callable-hook check warns when a hook key is PRESENT but undefined,
// because writing the key is what declares the intent. That signal survives
// only as far as the cells bridge, which spreads keys mechanically
// (`onStopping: fc.onStopping`) and therefore materialises every hook the app
// omitted as an explicit `undefined`. Validating after that point warned on
// every boot of every app, about hooks it had never mentioned.
//
// Every unit test of the validator passed throughout — they all hand it a
// clean object. So did the first version of THIS test, which booted an app
// with `libraryMode: true` and never reached the bridge at all: it stayed green
// with the bug reinstated, which is how it was caught.

Deno.test("the bridge materialises omitted hooks — so the post-bridge check must not warn", async () => {
  const { buildLegacyConfig } = await import(
    "../src/server/aio-cells-bridge.ts"
  );
  const { composeCellsWiring } = await import(
    "../src/server/aio-composition.ts"
  );
  const { validateCallableConfig } = await import("../src/server/config.ts");
  const { cell } = await import("../src/state/cell-create.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );

  _resetAioRuntime();
  const c = cell("hookbridgeprobe", { state: { n: 0 }, methods: {} });
  // deno-lint-ignore no-explicit-any
  const { composed } = composeCellsWiring({ cellEntries: [c] as any });
  // An app that declares NO hooks at all.
  const bridged = buildLegacyConfig({
    // deno-lint-ignore no-explicit-any
    fc: { appId: "hookbridgeprobe-app" } as any,
    composed,
    beforeReduce: undefined,
    onRestore: undefined,
    autoGetUIState: undefined,
    autoGetDBState: (s) => s,
    cellPatchStrategies: new Map(),
    cellFilterFieldsMap: new Map(),
    cellReportOpts: {},
    logger: null,
    appRef: { current: null },
  }) as unknown as Record<string, unknown>;

  // The premise, asserted rather than assumed: the bridge really does put the
  // key there. If this ever stops being true the test below proves nothing.
  assert(
    "onStopping" in bridged && bridged.onStopping === undefined,
    "the bridge no longer materialises omitted hooks — this test is moot",
  );

  const warnings: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") warnings.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    validateCallableConfig(bridged, false); // how the post-bridge site calls it
  } finally {
    setLogger(prev);
  }
  assertEquals(
    warnings.filter((w) => w.includes("is declared but its value is")),
    [],
    "warned about a hook the app never wrote",
  );

  // …and the app-authored path still warns, or the check would be pointless.
  const seen: string[] = [];
  const prev2 = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    validateCallableConfig({ onStart: undefined });
  } finally {
    setLogger(prev2);
  }
  assertEquals(seen.length, 1, "the app-authored warning stopped working");
});

Deno.test("plugins compose hooks — an app that declares none still gets no warnings", async () => {
  // The bridge is not the only rebuild. The plugin merge writes
  // `onStopping: fc.onStopping` and composes onAction/onEffect/onConnect/
  // onDisconnect/onStart/onStop, so an app using ANY plugin had every one of
  // those keys materialised — seven false warnings on boot. The first fix
  // covered only the bridge; this is why authorship is now read from the
  // object the app itself passed, before any merge runs.
  const { aio, cell, definePlugin } = await import("../mod.ts");
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  const c = cell("plughookprobe", { state: { n: 0 }, methods: {} });
  const plugin = definePlugin({
    name: "plughookprobe-plugin",
    routes: { "/plughookprobe": () => new Response("ok") },
  });
  const dir = Deno.makeTempDirSync();
  const warnings: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") warnings.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    const app = await aio.run({
      cells: [c],
      plugins: [plugin],
      appId: `plughook-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port: 0,
      baseDir: dir,
      dbPath: ":memory:",
    } as never);
    await (app as unknown as { close?: () => Promise<void> }).close?.();
  } finally {
    setLogger(prev);
    Deno.removeSync(dir, { recursive: true });
  }
  assertEquals(
    warnings.filter((w) => w.includes("is declared but its value is")),
    [],
    "warned about hooks the app never wrote (the plugin merge materialised them)",
  );
});
