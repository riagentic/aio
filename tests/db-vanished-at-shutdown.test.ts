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
