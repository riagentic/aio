// `am restore` of a `dbPath` app stages the archive's database BESIDE its
// place (`<dbPath>.am-restore-<stamp>/`). Killed between staging and swap
// (SIGKILL, every kill on Windows) that stage carried no incomplete-mark and
// no later restore looked for it: disk eaten forever, unnamed. And the
// `mkdir -p` of the database's directory ran before a refusal, so a refused
// restore left a fresh empty directory tree behind.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdRestore, INCOMPLETE_MARK } from "../src/am/am-cmd-data.ts";
import {
  _resetAppDirs,
  appDirs,
  ensureAppDirs,
} from "../src/server/app-dirs.ts";
import { ownerIdentity } from "../src/server/lock-owner.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "dbpath-stage-probe";
const SUITE_HOME = Deno.env.get("AIO_APPS_DIR");

async function am(
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
    await cmdRestore(args, { app: APP, json: true } as never);
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

async function withApp(fn: (dir: string) => Promise<void>) {
  const dir = await tempDir("am-dbpath-stage-");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  _resetAppDirs();
  try {
    ensureAppDirs(appDirs(APP));
    await fn(dir);
  } finally {
    if (SUITE_HOME === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", SUITE_HOME);
    _resetAppDirs();
    await dropTempDir(dir);
  }
}

function archive(dir: string, dbPath: string, files: Record<string, string>) {
  const a = join(dir, "archive");
  Deno.mkdirSync(join(a, ".am-dbpath"), { recursive: true });
  for (const [n, v] of Object.entries(files)) {
    Deno.writeTextFileSync(join(a, ".am-dbpath", n), v);
  }
  Deno.writeTextFileSync(
    join(a, "meta.json"),
    JSON.stringify({ appId: APP, aio: "test", dbPath }),
  );
  return a;
}

Deno.test("am restore: a refused dbPath restore takes back the parents it created", () =>
  withApp(async (dir) => {
    const db = join(dir, "new", "deep", "app.db");
    // The archive names the database but holds none of its files.
    const r = await am([archive(dir, db, { "other.db": "X" })]);
    assertEquals(r.exited, 1, r.out);
    assertStringIncludes(r.out, "Nothing was touched");
    let made = true;
    try {
      Deno.statSync(join(dir, "new"));
    } catch {
      made = false;
    }
    assertEquals(made, false, "a refused restore left new/deep/ behind");
  }));

Deno.test("am restore: a killed restore's staged database is swept by the next", () =>
  withApp(async (dir) => {
    const db = join(dir, "outside", "app.db");
    Deno.mkdirSync(join(dir, "outside"));
    // What a restore SIGKILLed between staging and swap leaves: a stage with
    // the mark naming a process that is gone.
    const dead = new Deno.Command(Deno.execPath(), { args: ["--version"] })
      .spawn();
    await dead.status;
    const left = `${db}.am-restore-20260101-000000`;
    Deno.mkdirSync(left);
    Deno.writeTextFileSync(join(left, "app.db"), "STALE");
    Deno.writeTextFileSync(
      join(left, INCOMPLETE_MARK),
      JSON.stringify({
        op: "am restore",
        pid: dead.pid,
        host: Deno.hostname(),
        ...ownerIdentity(Deno.pid),
      }),
    );
    const r = await am([archive(dir, db, { "app.db": "NEW" })]);
    assertEquals(r.exited, null, r.out);
    assertStringIncludes(r.out, `removed ${left}`);
    assertEquals(Deno.readTextFileSync(db), "NEW");
    const names = [...Deno.readDirSync(join(dir, "outside"))].map((e) =>
      e.name
    );
    assertEquals(names, ["app.db"], "stage or mark left beside the database");
    assert(!names.includes(INCOMPLETE_MARK));
  }));
