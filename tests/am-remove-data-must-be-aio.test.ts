// `am remove ssh --data --force` deleted ~/.ssh.
//
// The data side of `am remove` took `appDirs(name).home` — `~/.<name>` — on the
// strength of the NAME alone. The program side has required evidence since
// `isAioInstall` (a record, the launcher, versions/); the unrecoverable side
// required none, so any dot-directory in the home was one flag pair away from
// a recursive delete. Measured by a hunter running `am` as a user.
//
// And the names that point at those directories were accepted at birth:
// `am create aio` made an app whose home is `~/.aio` — the framework's own
// machine directory, holding the local CA and release keys.
//
// Every case runs with HOME / AIO_APPS_DIR / AIO_INSTALL_ROOT in a temp dir.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdRemove, isAioDataDir } from "../src/am/am-cmd-remove.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";
import { parseCreateArgs } from "../src/am/am-cmd-create.ts";
import {
  RESERVED_APP_NAMES,
  reservedAppNameError,
} from "../src/am/am-utils.ts";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

async function withHomes(fn: (base: string) => Promise<void>): Promise<void> {
  const base = await Deno.makeTempDir({ prefix: "am-remove-own-" });
  const keys = ["AIO_INSTALL_ROOT", "AIO_APPS_DIR", "HOME"] as const;
  const prev = keys.map((k) => Deno.env.get(k));
  Deno.env.set("AIO_INSTALL_ROOT", join(base, "opt"));
  Deno.env.set("AIO_APPS_DIR", join(base, "apps"));
  Deno.env.set("HOME", join(base, "home"));
  for (const d of ["opt", "apps", "home/.local/bin"]) {
    await Deno.mkdir(join(base, d), { recursive: true });
  }
  try {
    await fn(base);
  } finally {
    keys.forEach((k, i) =>
      prev[i] === undefined ? Deno.env.delete(k) : Deno.env.set(k, prev[i]!)
    );
    await Deno.remove(base, { recursive: true }).catch(() => {});
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

Deno.test("am remove --data --force: a directory aio did not write is never deleted", async () => {
  await withHomes(async () => {
    // What `~/.ssh` looks like: a dot-dir named like an app, with no aio layout.
    const foreign = appDirs("ssh-like").home;
    await Deno.mkdir(foreign, { recursive: true });
    await Deno.writeTextFile(join(foreign, "id_ed25519"), "PRIVATE KEY");
    await Deno.writeTextFile(join(foreign, "known_hosts"), "github.com …");

    const r = await run(["ssh-like"], { data: true, force: true });
    assertEquals(r.code, 1, `expected a refusal, got: ${r.said}`);
    assertStringIncludes(r.said, "not an aio app's data directory");
    assert(
      await there(join(foreign, "id_ed25519")),
      "--data --force deleted a directory aio never wrote",
    );
  });
});

Deno.test("am remove: a foreign directory is not offered for deletion either", async () => {
  await withHomes(async () => {
    const foreign = appDirs("notmine").home;
    await Deno.mkdir(foreign, { recursive: true });
    await Deno.writeTextFile(join(foreign, "config"), "x");
    // "nothing installed … its DATA is still at … remove it with --data" would
    // hand the reader the command that deletes it.
    const r = await run(["notmine"], {});
    assertEquals(r.code, 1);
    assert(!r.said.includes("--data"), r.said);
  });
});

Deno.test("am remove --data --force: an aio data dir still goes", async () => {
  await withHomes(async () => {
    const home = appDirs("notes").home;
    await Deno.mkdir(join(home, "data"), { recursive: true });
    await Deno.writeTextFile(join(home, "data", "meta.json"), "{}");
    const r = await run(["notes"], { data: true, force: true });
    assertEquals(r.code, null, r.said);
    assertEquals(await there(home), false);
  });
});

Deno.test("am remove --data: a reserved name is refused even with aio's layout", async () => {
  await withHomes(async () => {
    // `~/.aio` carries data/meta.json when an app was once booted as "aio" —
    // and it is ALSO where the machine CA and release keys live.
    const home = appDirs("aio").home;
    await Deno.mkdir(join(home, "data"), { recursive: true });
    await Deno.mkdir(join(home, "ca"), { recursive: true });
    await Deno.writeTextFile(join(home, "data", "meta.json"), "{}");
    await Deno.writeTextFile(join(home, "ca", "root.key"), "CA KEY");
    const r = await run(["aio"], { data: true, force: true });
    assertEquals(r.code, 1, r.said);
    assertStringIncludes(r.said, "reserved");
    assert(await there(join(home, "ca", "root.key")), "the machine CA went");
  });
});

Deno.test("isAioDataDir: aio's layout, and nothing else", async () => {
  const dir = await Deno.makeTempDir({ prefix: "am-aio-data-" });
  try {
    assertEquals(await isAioDataDir(dir), false);
    await Deno.writeTextFile(join(dir, "state.db"), "x"); // wrong level
    assertEquals(await isAioDataDir(dir), false);
    await Deno.writeTextFile(join(dir, "launch.json"), "{}");
    assertEquals(await isAioDataDir(dir), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("am create: a reserved name is refused, before anything is written", async () => {
  for (const name of ["aio", "ssh", "SSH", "gnupg", "config"]) {
    assert(reservedAppNameError(name, "am create"), `${name} accepted`);
  }
  assertEquals(reservedAppNameError("my-app", "am create"), null);
  assert(RESERVED_APP_NAMES.has("aio"));

  const cwd = await Deno.makeTempDir({ prefix: "am-create-reserved-" });
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL("../src/am.ts", import.meta.url).pathname,
        "create",
        "aio",
        "--json",
      ],
      cwd,
      env: { ...Deno.env.toObject(), AIO_AM_NO_DELEGATE: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    assertEquals(out.code, 1, text);
    assertStringIncludes(text, "reserved");
    assertEquals(await there(join(cwd, "aio")), false, "it scaffolded anyway");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("am create: a second name is refused, not dropped", () => {
  let threw: Error | null = null;
  try {
    parseCreateArgs(["my", "app"]);
  } catch (e) {
    threw = e as Error;
  }
  assert(threw, "`am create my app` created `my` and dropped `app`");
  assertStringIncludes(threw.message, `unexpected argument "app"`);
  // The space form of a value flag lost its value the same way.
  let t2: Error | null = null;
  try {
    parseCreateArgs(["x", "--template", "todo"]);
  } catch (e) {
    t2 = e as Error;
  }
  assert(t2, "--template todo (space) silently created the default template");
  // One name is still fine.
  assertEquals(parseCreateArgs(["my-app"]).name, "my-app");
});
