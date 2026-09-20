// Two processes recovering the SAME damaged database at once.
//
// `singleton: false` lets two instances share one data directory, and both
// run `checkIntegrityOnBoot` before either has opened anything for real. Each
// recovery clears `<db>.restoring` / `.restoring.partial` before staging its
// own, and drops a staged copy it finds beside a live database as "stale" —
// so B deleted the copy A was in the middle of writing or installing: A
// failed its install (or started EMPTY), and a second quarantine of the
// already-restored file could follow. Recovery is now serialized by an
// exclusive lock beside the database: B waits, then finds a sound file.
//
// Both children are released by one barrier file, so their recoveries run
// side by side; a large snapshot keeps the copy window wide.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell, pk, table, text } from "../mod.ts";
import {
  recoveryLockPathFor,
  snapshotPathFor,
  withRecoveryLock,
} from "../src/server/db-integrity.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell, pk, table, text } from "${MOD}";
const DIR = Deno.env.get("DIR");
const ME = Deno.env.get("ME");
while (true) {
  try { Deno.statSync(DIR + "/go"); break; } catch { await new Promise((r) => setTimeout(r, 2)); }
}
let out;
try {
  const app = await aio.run({
    cells: [cell("notes", { state: { n: 0 }, methods: {} })],
    appId: "concurrent-recovery-" + ME,
    client: "server-only",
    singleton: false,
    port: Number(Deno.env.get("PORT")),
    appDir: DIR,
    checkIntegrityOnBoot: true,
    db: { rows: table({ id: pk(), v: text() }) },
  });
  const { rows } = await app.db.query("SELECT id FROM rows");
  out = { ok: true, rows: rows.length };
  await app.close();
} catch (e) {
  out = { ok: false, error: String(e) };
}
Deno.writeTextFileSync(DIR + "/r-" + ME + ".json", JSON.stringify(out));
Deno.exit(0);
`;

Deno.test("integrity: two instances recovering one damaged database at once both boot on the snapshot", async () => {
  const dir = await tempDir("aio-concurrent-recovery-");
  const dbPath = join(dir, "data", "state.db");
  try {
    // A database worth keeping, with a big snapshot beside it.
    const app = await aio.run({
      cells: [cell("notes", { state: { n: 0 }, methods: {} })],
      appId: `concurrent-recovery-seed-${Deno.pid}`,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      port: freePort(),
      appDir: dir,
      db: { rows: table({ id: pk(), v: text() }) },
    });
    const blob = "x".repeat(1 << 20);
    for (let i = 1; i <= 40; i++) {
      await app.db!.execute("INSERT INTO rows (id, v) VALUES (?, ?)", [
        i,
        blob,
      ]);
    }
    await app.db!.snapshot!(snapshotPathFor(dbPath));
    await app.close();
    const bytes = await Deno.readFile(dbPath);
    bytes.fill(0x5a, 4096, Math.min(1 << 20, bytes.length));
    await Deno.writeFile(dbPath, bytes);

    await Deno.writeTextFile(join(dir, "child.ts"), CHILD);
    const kids = ["a", "b"].map((me) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", CONFIG, join(dir, "child.ts")],
        env: { DIR: dir, ME: me, PORT: String(freePort()) },
        stdout: "piped",
        stderr: "piped",
      }).output()
    );
    // Both are importing; release them together.
    await new Promise((r) => setTimeout(r, 1500));
    await Deno.writeTextFile(join(dir, "go"), "");
    const outs = await Promise.all(kids);
    const logs = outs.map((o) =>
      new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr)
    );
    const results = await Promise.all(
      ["a", "b"].map(async (me) =>
        JSON.parse(
          await Deno.readTextFile(join(dir, `r-${me}.json`)).catch(() =>
            JSON.stringify({ ok: false, error: "no result" })
          ),
        )
      ),
    );
    assertEquals(
      results,
      [{ ok: true, rows: 40 }, { ok: true, rows: 40 }],
      `both instances boot on the recovered data:\n${logs.join("\n----\n")}`,
    );
    const names = [...Deno.readDirSync(join(dir, "data"))].map((e) => e.name);
    const quarantined = names.filter((n) => /\.corrupt-[0-9T-]+Z$/.test(n));
    assertEquals(
      quarantined.length,
      1,
      `one damaged file, one quarantine: ${names}\n${logs.join("\n----\n")}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("withRecoveryLock: a second holder waits — and says so — until the first is done", async () => {
  const dir = await tempDir("aio-recovery-lock-");
  try {
    const dbPath = join(dir, "state.db");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const aIn = new Promise<void>((r) => (entered = r));
    const a = withRecoveryLock(dbPath, async () => {
      order.push("a:in");
      entered();
      await gate;
      order.push("a:out");
    });
    await aIn;
    const waits: string[] = [];
    const b = withRecoveryLock(
      dbPath,
      () => {
        order.push("b:in");
        return Promise.resolve();
      },
      (lock) => {
        waits.push(lock);
        release();
      },
      50,
    );
    await Promise.all([a, b]);
    assertEquals(order, ["a:in", "a:out", "b:in"]);
    assertEquals(waits, [recoveryLockPathFor(dbPath)]);
  } finally {
    await dropTempDir(dir);
  }
});
