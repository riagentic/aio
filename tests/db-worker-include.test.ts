/**
 * The SQLite worker in a compiled binary (field report #7).
 *
 * `new Worker(new URL("./db-worker.ts", import.meta.url))` is invisible to
 * `deno compile`'s module graph. A binary compiled without `--include` for it
 * boots, then dies on the first DB call — and the message the user got named
 * PERMISSIONS ("Fix permissions or set persist: false"), a fix that cannot work
 * for this cause. An error that suggests the wrong fix is a bug.
 *
 * Three things are pinned here: the knowledge is exported (`aio/build`), the
 * miss is detected before the worker is even spawned, and the boot-time error
 * site classifies it instead of guessing permissions.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dbWorkerMissingHint, dbWorkerMissingIn } from "../src/db/async-db.ts";
import { compileArgs, dbWorkerInclude } from "../src/build.ts";

const AIO_ROOT = join(import.meta.dirname ?? ".", "..");

// ── (a) the knowledge is reachable from outside the framework ───────────────

Deno.test("aio/build exports dbWorkerInclude — the include args, not folklore", async () => {
  const args = dbWorkerInclude();
  assertEquals(args.length, 2, "one --include pair");
  assertEquals(args[0], "--include");
  assert(
    args[1]!.endsWith(join("src", "db", "db-worker.ts")),
    `points at the worker, got ${args[1]}`,
  );
  // and at a file that actually exists — an --include of a wrong path is
  // accepted by deno compile and only fails in the user's hands
  assert((await Deno.stat(args[1]!)).isFile, "the worker file exists");
});

Deno.test("aio/build exports compileArgs — a hand-rolled compile can match aio's", () => {
  const args = compileArgs({
    hasDist: false,
    workerInclude: dbWorkerInclude(),
    assets: [],
    excludes: [],
    out: "myapp",
    entry: "src/app.ts",
  });
  assertEquals(args[0], "compile");
  assert(
    args.some((a) => a.endsWith(join("src", "db", "db-worker.ts"))),
    "the worker rides along in the argv",
  );
  assertEquals(args.slice(-3), ["-o", "myapp", "src/app.ts"]);
});

// ── (b) detected before the worker is spawned ───────────────────────────────

Deno.test("dbWorkerMissingIn: compiled + not embedded → the --include message", () => {
  const absent = new URL("file:///tmp/deno-compile-myapp/src/db/db-worker.ts");
  const msg = dbWorkerMissingIn(absent, true);
  assert(msg, "a compiled binary missing the worker is detected");
  assertStringIncludes(msg, "--include");
  assertStringIncludes(msg, "db-worker.ts");
  assertStringIncludes(msg, "deno compile");
  // it names WHY deno compile could not know, so the reader can generalise
  assertStringIncludes(msg, "module graph");
  // and it must not send the reader down the two dead ends
  assert(!msg.includes("Fix permissions"), "no permissions advice");
  assertStringIncludes(msg, "NOT a permissions problem");
});

Deno.test("dbWorkerMissingIn: present, or not compiled → never blocks", () => {
  const real = new URL("./db-worker.ts", import.meta.resolve("../src/db/"));
  assertEquals(dbWorkerMissingIn(real, true), null, "embedded → fine");
  const absent = new URL("file:///tmp/deno-compile-myapp/src/db/db-worker.ts");
  // Dev/JSR: the module graph IS the filesystem — the check must be inert, or
  // every uncompiled run would explode on a path that never existed.
  assertEquals(dbWorkerMissingIn(absent, false), null, "not compiled → fine");
  assertEquals(
    dbWorkerMissingIn(new URL("https://x.dev/db-worker.ts"), true),
    null,
    "remote specifier → fine",
  );
});

// ── (c) classified at the error site, never as "fix permissions" ────────────

Deno.test("dbWorkerMissingHint: a worker Module-not-found is reclassified", () => {
  const raw = new Error(
    "db worker error: Module not found: file:///tmp/deno-compile-myapp/src/db/db-worker.ts",
  );
  const hint = dbWorkerMissingHint(raw);
  assert(hint, "recognised");
  assertStringIncludes(hint, "--include");
  assertStringIncludes(hint, "aio/build");
  assert(!hint.includes("Fix permissions"), "no permissions advice");
  // the original error survives — the hint explains it, it does not hide it
  assertStringIncludes(hint, "Module not found");

  // The pre-flight message is already the right one: passed through, not
  // wrapped a second time.
  const precise = new Error(
    dbWorkerMissingIn(
      new URL("file:///tmp/deno-compile-myapp/src/db/db-worker.ts"),
      true,
    )!,
  );
  assertEquals(dbWorkerMissingHint(precise), precise.message);
});

Deno.test("dbWorkerMissingHint: unrelated db failures keep their own message", () => {
  assertEquals(
    dbWorkerMissingHint(new Error("PermissionDenied: writing to state.db")),
    null,
  );
  assertEquals(dbWorkerMissingHint(new Error("database is locked")), null);
  // a Module-not-found for something else is NOT this bug
  assertEquals(
    dbWorkerMissingHint(new Error("Module not found: file:///app/cells.ts")),
    null,
  );
  assertEquals(dbWorkerMissingHint("no db"), null);
});

Deno.test("aio-boot: the permissions advice is gated behind the worker classifier", async () => {
  // The failure this fixes is a WRONG SUGGESTION, so the guard is structural:
  // every place that offers "Fix permissions" for a db failure must ask the
  // classifier first. A future catch block that forgets fails here.
  const src = await Deno.readTextFile(join(AIO_ROOT, "src/server/aio-boot.ts"));
  const sites = [...src.matchAll(/Fix permissions/g)];
  assert(sites.length > 0, "the permissions message still exists");
  for (const m of sites) {
    const before = src.slice(Math.max(0, m.index - 600), m.index);
    assertStringIncludes(
      before,
      "dbWorkerMissingHint",
      "a db failure must be classified before permissions are blamed",
    );
  }
  // and the degrade-to-a-warning path must not swallow it either
  const warnIdx = src.indexOf("sqlite: unavailable");
  assert(warnIdx > 0);
  assertStringIncludes(
    src.slice(Math.max(0, warnIdx - 600), warnIdx),
    "dbWorkerMissingHint",
  );
});
