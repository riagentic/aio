// `am remove <app> --data --force` deleted a RUNNING app's data out from under
// it: `--force` also skipped the "is it running?" check, so the home went while
// the app held state.db open — and the app (or its supervisor's relaunch)
// recreated a half-empty home over it. A live app's data is refused, --force
// or not; the program side and a profile's instance are unaffected.
//
// Every case runs with HOME / AIO_APPS_DIR / AIO_INSTALL_ROOT in a temp dir.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdRemove } from "../src/am/am-cmd-remove.ts";
import { appDirs, installedAppPaths } from "../src/server/app-dirs.ts";
import { writeLock } from "../src/server/single-instance-lock.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

async function withHomes(fn: () => Promise<void>): Promise<void> {
  const base = await tempDir("am-remove-live-");
  const keys = ["AIO_INSTALL_ROOT", "AIO_APPS_DIR", "HOME"] as const;
  const prev = keys.map((k) => Deno.env.get(k));
  Deno.env.set("AIO_INSTALL_ROOT", join(base, "opt"));
  Deno.env.set("AIO_APPS_DIR", join(base, "apps"));
  Deno.env.set("HOME", join(base, "home"));
  for (const d of ["opt", "apps", "home/.local/bin"]) {
    await Deno.mkdir(join(base, d), { recursive: true });
  }
  try {
    await fn();
  } finally {
    keys.forEach((k, i) =>
      prev[i] === undefined ? Deno.env.delete(k) : Deno.env.set(k, prev[i]!)
    );
    await dropTempDir(base);
  }
}

async function run(
  args: string[],
  flags: Partial<GlobalFlags>,
): Promise<{ code: number | null; said: string }> {
  const said: string[] = [];
  const l = console.log, e = console.error, realExit = Deno.exit;
  console.log = (...a: unknown[]) => said.push(a.join(" "));
  console.error = (...a: unknown[]) => said.push(a.join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  let code: number | null = null;
  try {
    await cmdRemove(args, { json: true, ...flags } as GlobalFlags);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    code = err.code;
  } finally {
    console.log = l;
    console.error = e;
    Deno.exit = realExit;
  }
  return { code, said: said.join("\n") };
}

const there = async (p: string) => {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
};

/** An installed app with booted data, and a live process holding its lock
 *  on `home`. */
async function liveApp(name: string, home: string, pid: number) {
  const data = appDirs(name).home;
  await Deno.mkdir(join(data, "data"), { recursive: true });
  await Deno.writeTextFile(join(data, "data", "state.db"), "db");
  const p = installedAppPaths(name);
  await Deno.mkdir(p.dir, { recursive: true });
  await Deno.writeTextFile(p.stable, "#!/bin/sh\n");
  writeLock({
    appId: name,
    pid,
    port: 0,
    startedAt: Date.now(),
    status: "started",
    cwd: p.dir,
    home,
  });
  return { data, dir: p.dir };
}

async function withHolder(fn: (pid: number) => Promise<void>) {
  const holder = new Deno.Command("sleep", { args: ["30"] }).spawn();
  try {
    await fn(holder.pid);
    Deno.kill(holder.pid, "SIGCONT"); // throws if remove killed it
  } finally {
    try {
      holder.kill("SIGKILL");
    } catch { /* aio-ok: already gone — the failure the test reports */ }
    await holder.status;
  }
}

Deno.test("am remove --data --force: a running app's data is refused, nothing removed", async () => {
  await withHomes(() =>
    withHolder(async (pid) => {
      const { data, dir } = await liveApp("notes", appDirs("notes").home, pid);
      const r = await run(["notes"], { data: true, force: true });
      assertEquals(r.code, 1, r.said);
      assertStringIncludes(r.said, "refusing to delete a live app's data");
      assertStringIncludes(r.said, "am stop --app=notes");
      assert(await there(join(data, "data", "state.db")), "data deleted live");
      assert(await there(dir), "program removed before the refusal");
    })
  );
});

Deno.test("am remove --data --force: an instance on a PROFILE home does not block the default home", async () => {
  await withHomes(() =>
    withHolder(async (pid) => {
      const { data } = await liveApp(
        "notes",
        `${appDirs("notes").home}-dev`,
        pid,
      );
      const r = await run(["notes"], { data: true, force: true });
      assertEquals(r.code, null, r.said);
      assertEquals(await there(data), false);
    })
  );
});
