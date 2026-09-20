// A snapshot restore that DIES halfway must not leave the next boot EMPTY.
//
// `checkIntegrityOnBoot` quarantines a damaged `state.db` and restores
// `state.db.snapshot` over it. It used to quarantine FIRST, then quick_check
// the snapshot (seconds on a large file), then `copyFile` it onto the live
// path — so a process that died in that stretch (SIGKILL, power cut, or just
// a SIGTERM during boot, which exits at once because no runtime is registered
// yet) left NO file at the live path. The next boot created a fresh empty
// database, passed its own check, and served an empty app beside a verified
// snapshot, silently. Measured on a real app: snapshot `{n:42}`, reboot `{n:0}`.
//
// The kill here is not a timed guess: the recovery's own install step
// ANNOUNCES the window (the injected fs sees the first write aimed at the live
// path), writes a marker, and SIGKILLs the process on the spot. The marker is
// asserted, so a run where the kill never landed cannot pass as "clean".
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const INTEGRITY = new URL("../src/server/db-integrity.ts", import.meta.url)
  .href;
const ASYNC_DB = new URL("../src/db/async-db.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const APP = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const box = cell("box", {
  state: { n: 0, pad: "" },
  methods: { set(s, n) { s.n = n; }, fill(s, k) { s.pad = "x".repeat(k); } },
});
const app = await aio.run({
  cells: [box],
  appId: "restore-window-probe",
  client: "server-only",
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
  checkIntegrityOnBoot: true,
});
if (Deno.env.get("PHASE") === "seed") {
  await box.fill(200_000); // enough pages that damage lands inside the file
  await box.set(42);
}
Deno.writeTextFileSync(DIR + "/n.json", JSON.stringify(box.n));
await app.close();
Deno.exit(0);
`;

// The recovery exactly as boot runs it, with an fs whose first write aimed at
// the live database path is the moment the process dies.
const CRASH = `
import { checkAndRecover } from "${INTEGRITY}";
import { createDB } from "${ASYNC_DB}";
const DIR = Deno.env.get("DIR");
const dbPath = DIR + "/data/state.db";
const die = (op) => {
  Deno.writeTextFileSync(DIR + "/killed-at", op);
  Deno.kill(Deno.pid, "SIGKILL");
};
await checkAndRecover({
  db: createDB(dbPath),
  dbPath,
  log: { info() {}, warn() {}, error() {} },
  fs: {
    rename: async (from, to) => {
      if (to === dbPath) die("rename " + from);
      await Deno.rename(from, to);
    },
    copyFile: async (from, to) => {
      if (to === dbPath) die("copyFile " + from);
      await Deno.copyFile(from, to);
    },
    stat: async (p) => ({ size: (await Deno.stat(p)).size }),
    remove: (p) => Deno.remove(p),
  },
});
Deno.writeTextFileSync(DIR + "/finished", "the kill never landed");
`;

async function child(dir: string, file: string, phase: string) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, file)],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

Deno.test("integrity restore: a death between quarantine and install still boots on the snapshot", async () => {
  const dir = await tempDir("aio-restore-window-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), APP);
    await Deno.writeTextFile(join(dir, "crash.ts"), CRASH);
    const seedLog = await child(dir, "app.ts", "seed");
    assertEquals(
      await Deno.readTextFile(join(dir, "n.json")).catch(() => seedLog),
      "42",
    );

    // A clean snapshot, then damage past the header: the file opens and only
    // quick_check notices — a bad sector or a torn write.
    const dbPath = join(dir, "data", "state.db");
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.exec(`VACUUM INTO '${dbPath}.snapshot'`);
    raw.close();
    const bytes = await Deno.readFile(dbPath);
    assert(bytes.length > 8 * 4096, `a multi-page database (${bytes.length})`);
    bytes.fill(0xa5, 4096, 4096 + 64);
    bytes.fill(0xa5, 4 * 4096, 6 * 4096);
    await Deno.writeFile(dbPath, bytes);

    const crashLog = await child(dir, "crash.ts", "crash");
    const killedAt = await Deno.readTextFile(join(dir, "killed-at")).catch(
      () => {
        throw new Error(`the kill never landed:\n${crashLog}`);
      },
    );

    const bootLog = await child(dir, "app.ts", "read");
    assertEquals(
      await Deno.readTextFile(join(dir, "n.json")),
      "42",
      `killed at "${killedAt}"; the next boot must come up on the verified ` +
        `snapshot, not on an empty database created over it.\n${bootLog}`,
    );
    assertStringIncludes(bootLog, "FINISHED an interrupted restore");
  } finally {
    await dropTempDir(dir);
  }
});
