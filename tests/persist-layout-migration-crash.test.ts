// A `persistMode` switch whose layout migration DIES between the copy and the
// retire must not leave a stale twin that a later switch resurrects.
//
// Boot migrates the stored document into the configured layout in three
// steps — copy, verify, retire the old layout — so a death after the copy
// left the SAME document in both layouts. Every later boot then took the
// "both layouts hold data, never guess" branch: it booted on the configured
// copy and left the other one untouched. The app kept writing to its layout,
// the other stayed frozen at the moment of the crash, and the next switch
// back booted on THAT — every acknowledged write since the crash invisible
// (measured: `n` written as 2 and closed cleanly, read back as 1).
//
// Two identical layouts are not an ambiguity — they are exactly the
// signature of that interrupted migration, and retiring one loses nothing.
//
// The kill is announced, not timed: the store the migration runs against
// SIGKILLs the process at the retire call, after writing a marker the test
// asserts, so a run where it never landed cannot pass as clean.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const BOOT = new URL("../src/server/aio-boot.ts", import.meta.url).href;
const ASYNC_DB = new URL("../src/db/async-db.ts", import.meta.url).href;
const SKV = new URL("../src/server/skv-sqlite.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const APP = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const box = cell("box", { state: { n: 0 }, methods: { set(s, n) { s.n = n; } } });
const other = cell("other", { state: { k: 7 }, methods: { set(s, k) { s.k = k; } } });
const app = await aio.run({
  cells: [box, other],
  appId: "layout-crash-probe",
  client: "server-only",
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
  persistMode: Deno.env.get("MODE"),
});
const write = Deno.env.get("WRITE");
if (write) await box.set(Number(write));
Deno.writeTextFileSync(DIR + "/n.json", JSON.stringify(box.n));
await app.close();
Deno.exit(0);
`;

// The boot's migration step exactly as boot runs it, over a store that dies
// at the retire.
const CRASH = `
import { loadAndMigrateSnapshot } from "${BOOT}";
import { createDB } from "${ASYNC_DB}";
import { sqliteKv } from "${SKV}";
const DIR = Deno.env.get("DIR");
const db = createDB(DIR + "/data/state.db");
const kv = sqliteKv(db);
const die = (op) => {
  Deno.writeTextFileSync(DIR + "/killed-at", op);
  Deno.kill(Deno.pid, "SIGKILL");
};
const store = {
  ...kv,
  del: async (k) => { die("del " + k); },
  setMulti: async (prefix, obj, prev) => {
    if (Object.keys(obj).length === 0) die("setMulti retire " + prev);
    return await kv.setMulti(prefix, obj, prev);
  },
};
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
await loadAndMigrateSnapshot(store, "layout-crash-probe", "state", Deno.env.get("MODE"), quiet);
Deno.writeTextFileSync(DIR + "/finished", "the kill never landed");
`;

async function child(
  dir: string,
  file: string,
  env: Record<string, string>,
): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, file)],
    env: { DIR: dir, PORT: String(freePort()), AIO_APPS_DIR: dir, ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

const readN = (dir: string) => Deno.readTextFile(join(dir, "n.json"));

for (const [from, to] of [["single", "multi"], ["multi", "single"]]) {
  Deno.test(`persistMode ${from} → ${to}: a death between copy and retire loses no later write`, async () => {
    const dir = await tempDir("aio-layout-crash-");
    try {
      await Deno.writeTextFile(join(dir, "app.ts"), APP);
      await Deno.writeTextFile(join(dir, "crash.ts"), CRASH);
      const seedLog = await child(dir, "app.ts", { MODE: from!, WRITE: "1" });
      assertEquals(await readN(dir).catch(() => seedLog), "1");

      const crashLog = await child(dir, "crash.ts", { MODE: to! });
      await Deno.readTextFile(join(dir, "killed-at")).catch(() => {
        throw new Error(`the kill never landed:\n${crashLog}`);
      });

      // The new layout boots, and the app writes — acknowledged, cleanly shut.
      const afterLog = await child(dir, "app.ts", { MODE: to!, WRITE: "2" });
      assertEquals(await readN(dir).catch(() => afterLog), "2", afterLog);

      // Switching back must read what was written, not the frozen twin.
      const backLog = await child(dir, "app.ts", { MODE: from! });
      assertEquals(
        await readN(dir),
        "2",
        `the write acknowledged after the interrupted migration was lost on ` +
          `the switch back.\n--- boot after the crash ---\n${afterLog}\n` +
          `--- switch back ---\n${backLog}`,
      );
      assertStringIncludes(afterLog, "interrupted");
    } finally {
      await dropTempDir(dir);
    }
  });
}
