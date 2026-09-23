// `am pin <v>` moves dep/aio and the recorded pin TOGETHER, or not at all.
//
// It repointed the link first and wrote the pin second; a pin write that
// failed (here: a read-only deno.json) left dep/aio on the new version while
// the app still declared the old one — the disagreement doctor and aiol flag.
// Runs against a THROWAWAY framework repo, never this checkout.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const GIT_ENV = {
  GIT_AUTHOR_NAME: "aio test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "aio test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function sh(cwd: string, cmd: string, ...args: string[]) {
  const o = await new Deno.Command(cmd, {
    args,
    cwd,
    env: GIT_ENV,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(o.success, new TextDecoder().decode(o.stderr));
}

async function denoDir(): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(o.stdout)).denoDir;
}

Deno.test({
  name: "am pin: a pin that cannot be recorded puts dep/aio back",
  // A read-only file stops only a non-root writer.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    const base = await tempDir("am-pin-together-");
    const app = join(base, "app");
    try {
      const aio = join(base, "aio");
      await Deno.mkdir(aio);
      await Deno.writeTextFile(join(aio, "mod.ts"), "export {};\n");
      await Deno.writeTextFile(join(aio, "deno.json"), '{"imports":{}}\n');
      await sh(aio, "git", "init", "-q");
      await sh(aio, "git", "add", ".");
      await sh(aio, "git", "commit", "-q", "-m", "init");
      await sh(aio, "git", "tag", "v9.9.9");
      const old = join(base, "old-aio");
      await Deno.mkdir(old);
      await Deno.writeTextFile(join(old, "mod.ts"), "export {};\n");
      await Deno.mkdir(join(app, "dep"), { recursive: true });
      await Deno.symlink(old, join(app, "dep", "aio"));
      await Deno.writeTextFile(
        join(app, "deno.json"),
        '{\n  "name": "pinapp",\n  "imports": { "aio": "./dep/aio/mod.ts" }\n}\n',
      );
      await Deno.chmod(join(app, "deno.json"), 0o444);

      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          CONFIG,
          AM,
          "pin",
          "v9.9.9",
          `--aio=${aio}`,
          "--json",
        ],
        cwd: app,
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          DENO_DIR: await denoDir(),
          HOME: join(base, "home"),
          AIO_APPS_DIR: join(base, "apps"),
          AIO_VERSIONS_DIR: join(base, "store"),
          XDG_RUNTIME_DIR: base,
          AIO_AM_NO_DELEGATE: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(o.stdout);
      assertEquals(o.code, 1, out + new TextDecoder().decode(o.stderr));
      assertStringIncludes(out, "could not record v9.9.9");
      assertStringIncludes(out, "link and pin still agree");
      assertEquals(
        await Deno.readLink(join(app, "dep", "aio")),
        old,
        "dep/aio moved to a version the app does not declare",
      );
    } finally {
      await Deno.chmod(join(app, "deno.json"), 0o644).catch(() => {});
      await dropTempDir(base);
    }
  },
});

// A PATH pin writes `.aio/pin.local` and then git-ignores it. When the ignore
// fails (a read-only .gitignore), the rollback put dep/aio back but left the
// NEW pin.local — which pins the app all the same — and still said "link and
// pin still agree". It removes the pin.local (and the `.aio/`) it made now.
Deno.test({
  name: "am pin <path>: a pin.local it wrote goes too when the pin fails",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    const base = await tempDir("am-pin-local-");
    const app = join(base, "app");
    try {
      const target = join(base, "dev-aio");
      await Deno.mkdir(target);
      await Deno.writeTextFile(join(target, "mod.ts"), "export {};\n");
      const old = join(base, "old-aio");
      await Deno.mkdir(old);
      await Deno.writeTextFile(join(old, "mod.ts"), "export {};\n");
      await Deno.mkdir(join(app, "dep"), { recursive: true });
      await Deno.symlink(old, join(app, "dep", "aio"));
      await Deno.writeTextFile(
        join(app, "deno.json"),
        '{\n  "name": "pinapp",\n  "imports": { "aio": "./dep/aio/mod.ts" }\n}\n',
      );
      await Deno.writeTextFile(join(app, ".gitignore"), "node_modules/\n");
      await Deno.chmod(join(app, ".gitignore"), 0o444);

      const o = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", CONFIG, AM, "pin", target, "--json"],
        cwd: app,
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          DENO_DIR: await denoDir(),
          HOME: join(base, "home"),
          AIO_APPS_DIR: join(base, "apps"),
          AIO_VERSIONS_DIR: join(base, "store"),
          XDG_RUNTIME_DIR: base,
          AIO_AM_NO_DELEGATE: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(o.stdout);
      assertEquals(o.code, 1, out + new TextDecoder().decode(o.stderr));
      assertStringIncludes(out, "link and pin still agree");
      assertEquals(await Deno.readLink(join(app, "dep", "aio")), old);
      const left = await Deno.lstat(join(app, ".aio")).then(
        () => true,
        () => false,
      );
      assertEquals(
        left,
        false,
        "the .aio/pin.local it wrote still pins the app",
      );
    } finally {
      await Deno.chmod(join(app, ".gitignore"), 0o644).catch(() => {});
      await dropTempDir(base);
    }
  },
});
