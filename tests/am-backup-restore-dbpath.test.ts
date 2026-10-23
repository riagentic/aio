// `am backup` / `am restore` of an app whose database `dbPath` keeps OUTSIDE
// data/.
//
// `am backup` copied data/ only: for such an app it exited 0 with an archive
// holding no state.db and no journal, and `am restore` of it said "restored"
// while the app went on booting on the database it already had. The boot now
// records the database's place in meta.json, the backup carries its files
// (and the journal beside it), and the restore puts them back there.
//
// A REAL app, end to end: persist 5, acknowledge +7 that only the journal
// holds (SIGKILL inside the persist debounce), back up, then change or wipe
// everything, restore, boot — the app must come back at 12.
import "./store-sandbox.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, resolve } from "@std/path";
import { cmdBackup, cmdRestore } from "../src/am/am-cmd-data.ts";
import {
  _resetAppDirs,
  appDirs,
  ensureAppDirs,
  externalDbPath,
  writeAppMeta,
} from "../src/server/app-dirs.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const APP = "dbpath-backup-probe";
const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));
const SUITE_HOME = Deno.env.get("AIO_APPS_DIR");

const CHILD = `
import { aio, cell } from "${spec(MOD)}";
const DIR = Deno.env.get("DIR");
const bank = cell("bank", {
  state: { balance: 0 },
  methods: { deposit(s, n) { s.balance += n; } },
});
const app = await aio.run({
  cells: [bank],
  appId: ${JSON.stringify(APP)},
  client: "server-only",
  journal: true,
  persistDebounceMs: 5000,
  port: Number(Deno.env.get("PORT")),
  dbPath: DIR + "/outside/app.db",
});
const phase = Deno.env.get("PHASE");
if (phase === "base") {
  await bank.deposit(5);
  await app.close();
  Deno.exit(0);
} else if (phase === "crash") {
  await bank.deposit(7); // acked: in the journal, not yet in app.db
  Deno.kill(Deno.pid, "SIGKILL");
} else if (phase === "more") {
  await bank.deposit(100);
  await app.close();
  Deno.exit(0);
} else {
  Deno.writeTextFileSync(DIR + "/balance.json", JSON.stringify(bank.balance));
  await app.close();
  Deno.exit(0);
}
`;

async function child(dir: string, phase: string): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: join(dir, "apps"),
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(o.stdout) +
    new TextDecoder().decode(o.stderr);
  if (phase !== "crash" && !o.success) {
    throw new Error(`${phase} child failed:\n${text}`);
  }
  return text;
}

async function am(
  fn: (args: string[], flags: Record<string, unknown>) => Promise<void>,
  args: string[],
): Promise<{ out: string; exited: number | null }> {
  const chunks: string[] = [];
  const [log, err, exit] = [console.log, console.error, Deno.exit];
  let exited: number | null = null;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (code = 0) => {
    exited = code;
    throw new Error("__exit__");
  };
  try {
    await fn(args, { app: APP, json: true });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    console.log = log;
    console.error = err;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = exit;
  }
  return { out: chunks.join("\n"), exited };
}

for (const after of ["changed", "wiped"] as const) {
  Deno.test(`am backup/restore: a dbPath app's database and journal round-trip (${after})`, async () => {
    const dir = await tempDir("am-dbpath-");
    Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
    _resetAppDirs();
    try {
      await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
      await child(dir, "base");
      await child(dir, "crash");
      const db = join(dir, "outside", "app.db");
      assertEquals(
        JSON.parse(Deno.readTextFileSync(appDirs(APP).meta)).dbPath,
        db,
        "the boot records where the database lives",
      );

      const archive = join(dir, "archive");
      const b = await am(cmdBackup, [archive]);
      assertEquals(b.exited, null, b.out);
      const bk = JSON.parse(b.out.slice(b.out.indexOf("{")));
      assertEquals(bk.dbPath, db);
      assertEquals(
        ["app.db", "app.db.journal"].every((f) => bk.dbFiles.includes(f)),
        true,
        `the database and its journal are in the backup: ${b.out}`,
      );

      if (after === "changed") {
        await child(dir, "more"); // app.db now holds 112
      } else {
        await Deno.remove(join(dir, "outside"), { recursive: true });
        await Deno.remove(appDirs(APP).data, { recursive: true });
      }

      const r = await am(cmdRestore, [archive]);
      assertEquals(r.exited, null, r.out);
      assertStringIncludes(r.out, `"dbPath":${JSON.stringify(db)}`);

      const boot = await child(dir, "read");
      assertEquals(
        JSON.parse(Deno.readTextFileSync(join(dir, "balance.json"))),
        12,
        `restored, the app must come back at 5 + the journalled 7:\n${boot}`,
      );
    } finally {
      if (SUITE_HOME === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", SUITE_HOME);
      _resetAppDirs();
      await dropTempDir(dir);
    }
  });
}

Deno.test({
  name:
    "am restore: a dbPath archive whose database place is not writable refuses, nothing touched",
  // chmod cannot make a dir read-only on Windows, and root writes anyway
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
}, async () => {
  const dir = await tempDir("am-dbpath-ro-");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  _resetAppDirs();
  const ro = join(dir, "ro");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    await child(dir, "base");
    const archive = join(dir, "archive");
    assertEquals((await am(cmdBackup, [archive])).exited, null);
    // The archive says its database came from a place this user cannot write.
    const metaPath = join(archive, "meta.json");
    const meta = JSON.parse(Deno.readTextFileSync(metaPath));
    Deno.mkdirSync(ro);
    meta.dbPath = join(ro, "app.db");
    Deno.writeTextFileSync(metaPath, JSON.stringify(meta));
    Deno.chmodSync(ro, 0o500);
    await Deno.remove(appDirs(APP).data, { recursive: true });
    const r = await am(cmdRestore, [archive]);
    assertEquals(r.exited, 1, r.out);
    assertStringIncludes(r.out, `${ro} cannot take it`);
    assertStringIncludes(r.out, "Nothing was touched");
    const left = [...Deno.readDirSync(appDirs(APP).home)].map((e) => e.name)
      .filter((n) => n.startsWith("data"));
    assertEquals(left, ["data"], "no staging left, data/ not swapped");
  } finally {
    try {
      Deno.chmodSync(ro, 0o700);
    } catch { /* never made */ }
    if (SUITE_HOME === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", SUITE_HOME);
    _resetAppDirs();
    await dropTempDir(dir);
  }
});

Deno.test("am restore: an archive from another dbPath than the app boots on refuses, nothing touched", async () => {
  const dir = await tempDir("am-dbpath-mismatch-");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  _resetAppDirs();
  try {
    const d = appDirs(APP);
    ensureAppDirs(d);
    const live = join(dir, "now", "app.db");
    writeAppMeta(d, { appId: APP, aio: "test", dbPath: live });
    const archive = join(dir, "archive");
    Deno.mkdirSync(join(archive, ".am-dbpath"), { recursive: true });
    Deno.writeTextFileSync(join(archive, ".am-dbpath", "app.db"), "OLD");
    const was = join(dir, "was", "app.db");
    Deno.writeTextFileSync(
      join(archive, "meta.json"),
      JSON.stringify({ appId: APP, aio: "test", dbPath: was }),
    );
    const r = await am(cmdRestore, [archive]);
    assertEquals(r.exited, 1, r.out);
    // The refusal is JSON: a Windows path's backslashes arrive escaped.
    assertStringIncludes(
      r.out,
      `last booted on ${JSON.stringify(live).slice(1, -1)}`,
    );
    assertStringIncludes(r.out, "Nothing was touched");
    assertEquals(
      JSON.parse(Deno.readTextFileSync(d.meta)).dbPath,
      live,
      "data/ was not swapped",
    );
  } finally {
    if (SUITE_HOME === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", SUITE_HOME);
    _resetAppDirs();
    await dropTempDir(dir);
  }
});

Deno.test("externalDbPath: only an on-disk database outside data/ is recorded", () => {
  const dirs = { data: "/h/app/data" };
  assertEquals(externalDbPath(dirs, undefined), undefined);
  assertEquals(externalDbPath(dirs, ":memory:"), undefined);
  assertEquals(externalDbPath(dirs, "/h/app/data/state.db"), undefined);
  assertEquals(externalDbPath(dirs, "/h/app/data/sub/x.db"), undefined);
  assertEquals(externalDbPath(dirs, "/h/app/x.db"), resolve("/h/app/x.db"));
  assertEquals(
    externalDbPath(dirs, "/h/app/data2.db"),
    resolve("/h/app/data2.db"),
  );
});
