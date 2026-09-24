// `am remove <app> --data` deletes the app's OWN data home — never a profile's.
//
// A profile (`--profile=dev`) is a separate data home beside the app's
// (`<home>-dev`), stamped in its data/meta.json as `{ appId, profile }`. The
// removal is the one unrecoverable verb `am` has, and "the app's data" there
// means one folder: a profile's state, keys and user files outlive it, and the
// summary NAMES them (`profileHomes`) so they are found, not left behind
// unseen. Run as a real subprocess in a sandbox (HOME, AIO_APPS_DIR,
// AIO_INSTALL_ROOT, … in one temp dir, environment cleared) — nothing here can
// reach a real home.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const APP = "amrmprofiles";

async function denoDirOf(): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(o.stdout)).denoDir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
}

Deno.test("am remove --data --force: the app's data goes, its profile homes stay — and are named", async () => {
  const base = await tempDir("am-rm-profiles-");
  try {
    const home = join(base, "home");
    const apps = join(base, "apps");
    const cwd = join(base, "cwd");
    for (const d of [home, apps, cwd, join(base, "run")]) {
      await Deno.mkdir(d, { recursive: true, mode: 0o700 });
    }
    // The app's own data home — aio-written (data/meta.json), so --data
    // accepts it.
    const dataDir = join(apps, APP);
    await Deno.mkdir(join(dataDir, "data"), { recursive: true });
    await Deno.writeTextFile(
      join(dataDir, "data", "meta.json"),
      JSON.stringify({ appId: APP }),
    );
    // Its `dev` profile, stamped as a booted profile stamps it.
    const profile = join(apps, `${APP}-dev`);
    await Deno.mkdir(join(profile, "data"), { recursive: true });
    await Deno.writeTextFile(
      join(profile, "data", "meta.json"),
      JSON.stringify({ appId: APP, profile: "dev" }),
    );
    await Deno.writeTextFile(join(profile, "data", "keep.txt"), "user file\n");

    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        CONFIG,
        AM,
        "remove",
        APP,
        "--data",
        "--force",
        "--json",
      ],
      cwd,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        DENO_DIR: await denoDirOf(),
        HOME: home,
        AIO_APPS_DIR: apps,
        AIO_INSTALL_ROOT: join(home, "app"),
        DENO_INSTALL_ROOT: join(home, ".deno"),
        XDG_RUNTIME_DIR: join(base, "run"),
        AIO_AM_NO_DELEGATE: "1",
        NO_COLOR: "1",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(o.stdout);
    const said = `${stdout}\n${new TextDecoder().decode(o.stderr)}`;
    assertEquals(o.code, 0, said);
    const doc = JSON.parse(stdout.trim().split("\n").at(-1)!);

    assertEquals(doc.dataRemoved, true, said);
    assert(!await exists(dataDir), "the app's own data was not removed");
    assert(
      await exists(join(profile, "data", "keep.txt")),
      `am remove --data deleted a PROFILE's data home: ${profile}`,
    );
    assertEquals(doc.profileHomes, [profile], said);
  } finally {
    await dropTempDir(base);
  }
});
