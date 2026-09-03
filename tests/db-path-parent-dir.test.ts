// `--db-path=/srv/app/data/state.db` into a directory that does not exist yet.
//
// SQLite said "unable to open database file", and aio added "Fix permissions
// or set persist: false to disable persistence" — advice for a cause that was
// not the cause, whose second half silently throws away the data the operator
// is trying to keep. The directory had simply never been created, and the
// DEFAULT db path gets its directories made (app-dirs.ts) — so the one path
// the operator names by hand was the one aio would not prepare.
//
// The file's directory is aio's to create, like the data dir it defaults to.
// And when it genuinely cannot be created, the message names THAT.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

Deno.test("dbPath: a missing parent directory is CREATED, not an unopenable file", async () => {
  _resetAioRuntime();
  const dir = await Deno.makeTempDir({ prefix: "aio-dbpath-" });
  try {
    const c = cell("dbparent-counter", {
      state: { n: 0 },
      methods: {
        inc(s) {
          s.n += 1;
        },
      },
    });
    // Three levels that do not exist — the shape of `~/apps/<app>/data/…`
    // on a fresh machine, and of a service unit's StateDirectory.
    const dbPath = join(dir, "srv", "app", "data", "state.db");
    const app = await aio.run({
      appId: "dbparent-test",
      cells: [c],
      libraryMode: true,
      client: "server-only",
      dbPath,
    });
    await c.inc();
    await app.close();
    assertEquals(
      (await Deno.stat(dbPath)).isFile,
      true,
      "the database is on disk",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    _resetAioRuntime();
  }
});

Deno.test("dbPath: when the directory truly cannot be made, the error names the directory", async () => {
  _resetAioRuntime();
  const dir = await Deno.makeTempDir({ prefix: "aio-dbpath-" });
  try {
    // A FILE where the directory would go — the one cause "fix permissions"
    // was never about.
    const blocker = join(dir, "blocker");
    await Deno.writeTextFile(blocker, "not a directory");
    const c = cell("dbparent-blocked", {
      state: { n: 0 },
      methods: {
        inc(s) {
          s.n += 1;
        },
      },
    });
    let err: unknown;
    try {
      const app = await aio.run({
        appId: "dbparent-blocked-test",
        cells: [c],
        libraryMode: true,
        client: "server-only",
        dbPath: join(blocker, "state.db"),
      });
      await app.close();
    } catch (e) {
      err = e;
    }
    assert(err !== undefined, "an unusable db path must not boot silently");
    const msg = String(err);
    assertStringIncludes(msg, blocker);
    assert(
      /cannot create/.test(msg),
      `the message must name the real fault (the directory): ${msg}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    _resetAioRuntime();
  }
});
