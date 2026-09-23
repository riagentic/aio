// The RUNTIME half of profiles, on real boots: `--profile=<name>` and
// `AIO_PROFILE` put the app in `<base>-<name>` under the lock `<appId>@<name>`
// and stamp the profile into meta.json; `profiles: false` refuses; an app that
// declares its own `--profile` keeps it. And the pre-existing bug: an app that
// names its folder (`appDir`) booted from two AIO_APPS_DIR scopes
// (`--instance`) no longer opens one database twice.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  _resetParsedCli,
  declareAppFlags,
  homeRequest,
  parseCli,
} from "../src/server/aio-cli.ts";
import { args as cliArgs } from "../src/cli/args.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** A minimal non-library app: server-only, no persistence. */
async function writeApp(
  dir: string,
  appId: string,
  extra = "",
): Promise<string> {
  const f = join(dir, `${appId}.ts`);
  await Deno.writeTextFile(
    f,
    `import { aio, cell } from "${REPO}/mod.ts";
const c = cell("c", { state: { n: 1 }, methods: {} });
await aio.run({ cells: [c], appId: ${JSON.stringify(appId)}, persist: false,
  client: "server-only", port: 0 ${extra} });
await new Promise(() => {});
`,
  );
  return f;
}

/** Boot `file` with `args`/`env` until `ready(home)` holds or it exits. */
async function boot(
  file: string,
  args: string[],
  env: Record<string, string>,
  ready: () => boolean,
): Promise<
  { exited?: { code: number; out: string }; kill: () => Promise<void> }
> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(REPO, "deno.json"), file, ...args],
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out = child.output();
  const deadline = Date.now() + 30_000;
  let done: Deno.CommandOutput | undefined;
  out.then((o) => (done = o), () => {});
  while (Date.now() < deadline && !done && !ready()) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const text = (o: Deno.CommandOutput) =>
    new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr);
  if (done) {
    return {
      exited: { code: done.code, out: text(done) },
      kill: async () => {},
    };
  }
  return {
    kill: async () => {
      child.kill("SIGTERM");
      await out;
    },
  };
}

const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test({
  name:
    "runtime: --profile=dev / AIO_PROFILE=dev boot in <base>-dev, stamped, keyed <appId>@dev",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("prof-rt-");
    const apps = join(dir, "apps");
    const env = { AIO_APPS_DIR: apps, XDG_RUNTIME_DIR: join(dir, "rt") };
    await Deno.mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    try {
      const file = await writeApp(dir, "pa");
      for (
        const [args, extraEnv] of [[["--profile=dev"], {}], [[], {
          AIO_PROFILE: "dev",
        }]] as [string[], Record<string, string>][]
      ) {
        const meta = join(apps, "pa-dev", "data", "meta.json");
        const b = await boot(
          file,
          args,
          { ...env, ...extraEnv },
          () => exists(meta),
        );
        try {
          assert(!b.exited, `the profile boot exited: ${b.exited?.out}`);
          const m = JSON.parse(Deno.readTextFileSync(meta));
          assertEquals([m.appId, m.profile], ["pa", "dev"]);
          assert(
            !exists(join(apps, "pa", "data")),
            "the base home was touched",
          );
          // The lock: named by the profile, recording it.
          const lockDirs = [...Deno.readDirSync(env.XDG_RUNTIME_DIR)]
            .filter((e) => e.isDirectory && e.name.startsWith("aio"))
            .map((e) => join(env.XDG_RUNTIME_DIR, e.name));
          const lock = lockDirs.map((d) => join(d, "pa@dev.lock")).find(exists);
          assert(lock, `no pa@dev.lock in ${lockDirs.join(", ")}`);
          assertEquals(JSON.parse(Deno.readTextFileSync(lock)).profile, "dev");
        } finally {
          await b.kill();
        }
        await Deno.remove(meta);
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "runtime: profiles:false refuses --profile, AIO_PROFILE and --home (exit 1)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("prof-off-");
    const env = {
      AIO_APPS_DIR: join(dir, "apps"),
      XDG_RUNTIME_DIR: join(dir, "rt"),
    };
    await Deno.mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    try {
      const file = await writeApp(dir, "po", ", profiles: false");
      for (
        const [args, extra] of [
          [["--profile=dev"], {}],
          [[], { AIO_PROFILE: "./x" }],
          [[`--home=${join(dir, "h")}`], {}],
        ] as [string[], Record<string, string>][]
      ) {
        const b = await boot(file, args, { ...env, ...extra }, () => false);
        assert(b.exited, "profiles:false booted anyway");
        assertEquals(b.exited.code, 1, b.exited.out);
        assertStringIncludes(b.exited.out, "profiles: false");
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "bug: an appDir app from two AIO_APPS_DIR scopes never opens one database twice",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("prof-scope-");
    const rt = join(dir, "rt");
    await Deno.mkdir(rt, { mode: 0o700 });
    try {
      const fixed = join(dir, "fixed");
      const file = await writeApp(
        dir,
        "pf",
        `, appDir: ${JSON.stringify(fixed)}`,
      );
      const meta = join(fixed, "data", "meta.json");
      const first = await boot(
        file,
        [],
        { AIO_APPS_DIR: join(dir, "a"), XDG_RUNTIME_DIR: rt },
        () => exists(meta),
      );
      try {
        assert(!first.exited, `first boot exited: ${first.exited?.out}`);
        const second = await boot(
          file,
          [],
          { AIO_APPS_DIR: join(dir, "b"), XDG_RUNTIME_DIR: rt },
          () => false,
        );
        if (!second.exited) await second.kill();
        assert(second.exited, "a second scope booted on the same appDir");
        assertEquals(second.exited.code, 1, second.exited.out);
        assertStringIncludes(second.exited.out, "already running from");
      } finally {
        await first.kill();
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test("runtime: an app that claims --profile keeps it; aio reads AIO_PROFILE only", () => {
  const prev = Deno.env.get("AIO_PROFILE");
  try {
    Deno.env.delete("AIO_PROFILE");
    _resetParsedCli();
    assertEquals(parseCli(["--profile=dev"]).profile, "dev");
    assertEquals(homeRequest(["--profile=./x"]).profile, "./x");
    assertEquals(homeRequest(["--home=/h"]).home, "/h");
    // Declared by the app: the flag is the app's, aio does not take it —
    // and declaring it is not refused as "one of aio's own flags".
    declareAppFlags(["--profile="]);
    assertEquals(parseCli(["--profile=dev"]).profile, undefined);
    Deno.env.set("AIO_PROFILE", "env");
    assertEquals(homeRequest(["--profile=dev"]).profile, "env");
  } finally {
    _resetParsedCli();
    if (prev === undefined) Deno.env.delete("AIO_PROFILE");
    else Deno.env.set("AIO_PROFILE", prev);
  }
});

Deno.test("aio/cli args(): an undeclared --profile= passes through to aio", () => {
  const r = cliArgs(
    { name: "t", flags: { verbose: { type: "boolean" } } },
    { argv: ["--profile=dev", "--verbose"] },
  );
  assertEquals((r as { flags: { verbose?: boolean } }).flags.verbose, true);
});
