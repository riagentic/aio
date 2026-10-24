// A database made read-only once leaves a read-only `-shm` beside it (SQLite
// creates it with the database's mode). After `chmod u+w state.db` every boot
// still failed `attempt to write a readonly database`, and the refusal said
// "make the data directory and the db file writable" — the one file already
// fixed. Measured on a real app. The refusal now names the paths this user
// cannot write.
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

Deno.test({
  name: "persist: a read-only refusal names the stale -shm, not the db file",
  ignore: Deno.build.os === "windows" || Deno.uid?.() === 0,
  fn: async () => {
    const dir = await tempDir("aio-ro-shm-");
    const appId = `ro-${crypto.randomUUID().slice(0, 8)}`;
    const dbPath = join(dir, "data", "state.db");
    const boot = () =>
      aio.run({
        cells: [cell("counter", { state: { n: 0 }, methods: {} })],
        appId,
        client: "server-only",
        libraryMode: true,
        singleton: false,
        port: freePort(),
        appDir: dir,
        baseDir: dir,
      });
    try {
      await (await boot()).close();
      await Deno.writeFile(dbPath + "-shm", new Uint8Array(32768));
      await Deno.chmod(dbPath + "-shm", 0o444);
      const err = await assertRejects(boot);
      const msg = String((err as Error).message);
      assertStringIncludes(msg, "readonly database");
      assertStringIncludes(msg, `cannot write: ${dbPath}-shm`);
      assert(!msg.includes(`${dbPath},`), "the writable db is not named");
    } finally {
      await Deno.chmod(dbPath + "-shm", 0o644).catch(() => {});
      await dropTempDir(dir);
    }
  },
});
