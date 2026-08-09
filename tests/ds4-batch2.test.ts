// The second ds4 batch — every one a silent-wrong-outcome or a silent hang,
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
