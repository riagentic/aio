// SQLite reports a clean commit into a file that no longer exists.
//
// Delete the database out from under a running app and POSIX keeps the inode
// alive for the already-open fd: every persist window after that "succeeds",
// `lastCycleError()` stays null, and the app exits `errors=0` having lost
// every write since. Measured before this check existed — the app said
// count=2, the disk had nothing, and no line anywhere said so.
//
// A real process, because the whole point is the file handle the process is
// holding: nothing in-process can reproduce an unlinked inode.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;
const MOD = new URL("../mod.ts", import.meta.url).href;

/** Boot a persisting app, optionally destroy its data dir, then close. */
async function run(dir: string, destroy: boolean): Promise<string> {
  const file = join(dir, "app.ts");
  await Deno.writeTextFile(
    file,
    `import { aio, cell } from ${JSON.stringify(MOD)};
const box = cell("box", {
  state: { count: 0 },
  methods: { set(s: { count: number }, n: number) { s.count = n; } },
});
const app = await aio.run({
  cells: [box],
  appId: "vanish",
  client: "server-only",
  libraryMode: true,
  singleton: false,
  port: 0,
  appDir: ${JSON.stringify(dir)},
  baseDir: ${JSON.stringify(dir)},
  persistDebounceMs: 20,
});
await box.set(1);
await new Promise((r) => setTimeout(r, 300));
if (${destroy}) Deno.removeSync(${
      JSON.stringify(join(dir, "data"))
    }, { recursive: true });
await box.set(2);
await new Promise((r) => setTimeout(r, 300));
await app.close();
Deno.exit(0);
`,
  );
  const { stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(REPO, "deno.json"), file],
    env: { AIO_APPS_DIR: dir, NO_COLOR: "1" },
    stdout: "null",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(stderr);
}

Deno.test({
  name:
    "persist: a database deleted under a running app is REPORTED at shutdown, not exited clean",
  fn: async () => {
    const gone = await tempDir("aio-db-vanish-");
    try {
      const err = await run(gone, true);
      assert(
        /database file is GONE/.test(err),
        `losing every write since the deletion must be said out loud: ${err}`,
      );
    } finally {
      await dropTempDir(gone);
    }

    // …and a healthy app must never say it, or the message is noise.
    const ok = await tempDir("aio-db-intact-");
    try {
      const err = await run(ok, false);
      assert(
        !/database file is GONE/.test(err),
        `a database that is still there must not be reported gone: ${err}`,
      );
    } finally {
      await dropTempDir(ok);
    }
  },
});

// `:memory:` is not a missing file.
//
// The check resolved SQLite's sentinel as a path (`<cwd>/:memory:`), found no
// file there, and ended every clean in-memory run with a FATAL-sounding "the
// database file is GONE … NONE of them are on disk" — about a database that was
// never meant to be on disk. A false alarm in the one message that has to be
// believed the day it is real is worse than no message at all: it is exactly
// how a reader learns to discount this line.
//
// Driven as a CHILD PROCESS like the two above, because the claim is about what
// the operator sees on stderr at shutdown, and a same-process assertion on a
// log call proves something narrower.
Deno.test({
  name: "persist: an in-memory app does not report its database as GONE",
  fn: async () => {
    const dir = await tempDir("aio-memdb-");
    try {
      const file = join(dir, "app.ts");
      await Deno.writeTextFile(
        file,
        `import { aio, cell } from ${JSON.stringify(MOD)};
const box = cell("box", {
  state: { count: 0 },
  methods: { set(s: { count: number }, n: number) { s.count = n; } },
});
const app = await aio.run({
  cells: [box],
  appId: "memdb-" + Deno.pid,
  client: "server-only",
  libraryMode: true,
  port: 0,
  dbPath: ":memory:",
});
// A write with NO settle before close, so the FINAL persist really runs —
// that is the only path the existence check is on, and a test that lets the
// state settle first never reaches it.
await box.set(1);
await app.close();
Deno.exit(0);
`,
      );
      const { stdout, stderr } = await new Deno.Command(Deno.execPath(), {
        // `--config` is load-bearing: the script lives outside the repo, so
        // without the import map its very first `@std/path` import fails and
        // the child dies before booting. That is how this assertion was vacuous
        // for its first draft — "the message was not printed" is trivially true
        // of a process that printed nothing.
        args: ["run", "-A", "--config", join(REPO, "deno.json"), file],
        env: { AIO_APPS_DIR: dir, NO_COLOR: "1" },
        // BOTH streams: the shutdown banner is INFO (stdout) and the alarm is
        // ERROR (stderr). Reading only stderr made "the alarm was not printed"
        // indistinguishable from "the child printed nothing at all".
        stdout: "piped",
        stderr: "piped",
      }).output();
      const dec = new TextDecoder();
      const out = dec.decode(stdout);
      const err = dec.decode(stderr);
      assert(
        (out + err).includes("stopped"),
        `the child must actually BOOT and shut down, or this assertion is vacuous:\n${err}`,
      );
      assert(
        !(out + err).includes("database file is GONE"),
        `an in-memory database has no file to lose:\n${err}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});
