// `--version` is a QUERY about an artifact. It must cost nothing.
//
// It used to be answered three phases into boot — after `resolveAppDirs`, so a
// binary asked with `$HOME` unset died with a stack trace out of the directory
// resolver; and with `$HOME` set it printed two boot lines, ROTATED the app's
// log files (`app.log` → `app.log.1`, one generation lost off the end every
// time someone asked what version this is) and ended with a stray empty
// `detail=` field. `--help` was hoisted out of `_run` for exactly this reason
// and `--version` was left behind.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** This machine's deno module cache, so a cleared environment does not send
 *  the child to the network. */
function denoDir(): string {
  return Deno.env.get("DENO_DIR") ??
    join(Deno.env.get("HOME") ?? ".", ".cache", "deno");
}

async function appDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-version-query-" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      title: "versionprobe",
      version: "3.7",
      imports: {
        "aio": `${ROOT}/mod.ts`,
        "aio/": `${ROOT}/src/`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@1.1.2",
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { aio } from "aio";\nawait aio.run({ client: "server-only" });\n`,
  );
  return dir;
}

function run(dir: string, env: Record<string, string>, clearEnv: boolean) {
  return new Deno.Command(Deno.execPath(), {
    // `-q`: deno's own download/warning chatter is not the app's output, and
    // this test counts lines.
    args: ["run", "-Aq", join(dir, "app.ts"), "--version"],
    cwd: dir,
    env,
    clearEnv,
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test({
  name: "--version: answers with no HOME at all, and never with a stack trace",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await appDir();
    try {
      // `env -i`: the state a systemd unit, a container entrypoint or a
      // `docker run` with no environment leaves a binary in.
      const out = await run(dir, {
        PATH: "/usr/bin:/bin",
        // The module cache is deno's, not the app's — without it the run
        // re-downloads and the test measures the network.
        DENO_DIR: denoDir(),
      }, true);
      const text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, `--version must succeed:\n${text}`);
      assert(
        !/\bat file:\/\/|Uncaught|NotFound:/.test(text),
        `a stack trace is not a version:\n${text}`,
      );
      assertStringIncludes(text, "versionprobe");
      assertStringIncludes(text, "aio ");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "--version: one clean line, no boot lines, no log files touched",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await appDir();
    const home = join(dir, "home");
    await Deno.mkdir(home);
    try {
      const out = await run(dir, {
        PATH: Deno.env.get("PATH") ?? "",
        DENO_DIR: denoDir(),
        HOME: home,
        AIO_APPS_DIR: home,
      }, true);
      const text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, text);
      const lines = text.trim().split("\n").filter((l) => l.trim() !== "");
      assertEquals(lines.length, 1, `exactly one line, got:\n${text}`);
      // The logger stamps every line it prints; this one is not logged.
      assert(
        !/^\d{4}-\d{2}-\d{2} /.test(lines[0]!),
        `a version is the answer, not a log entry: ${lines[0]}`,
      );
      assert(!text.includes("detail="), `stray empty field:\n${text}`);
      // …and asking cost the app nothing on disk.
      const left: string[] = [];
      for await (const e of Deno.readDir(home)) left.push(e.name);
      assertEquals(
        left,
        [],
        `asking for a version must not create the app's data home: ${
          left.join(", ")
        }`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
