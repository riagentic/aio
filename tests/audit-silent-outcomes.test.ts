// The second audit batch — every one a silent-wrong-outcome or a silent hang,
// which is the class this project treats as disqualifying.
import { assert, assertEquals, assertRejects } from "@std/assert";
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
  const { createDB } = await import("../src/db/mod.ts");
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
  const { createDB } = await import("../src/db/mod.ts");
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
  const { createDB } = await import("../src/db/mod.ts");
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
  const { createDB } = await import("../src/db/mod.ts");
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
