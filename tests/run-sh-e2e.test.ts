// run.sh — "single command source execution": one line takes any aio app repo
// (cwd or --git URL) to a RUNNING production build. Gated with the onboarding
// suite (AIO_ONBOARD_E2E=1 → `deno task test:onboard`): it compiles real
// binaries, which is exactly the kind of env-dependent minutes-long work the
// core suite excludes.
//
// Fully offline: `am` is installed into a sandbox from THIS checkout,
// AIO_HOME points at THIS checkout (a git dir), and the --git scenario clones
// from a local path — run.sh's installer branch is never taken.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  freePort,
  kill,
  makeApp,
  REPO_ROOT,
  waitForHttp,
} from "./e2e-app-harness.ts";

const GATE = Deno.env.get("AIO_ONBOARD_E2E") === "1";
const dec = new TextDecoder();

/** One sandbox for the whole file: am installed from this checkout. */
async function sandbox(): Promise<
  { env: Record<string, string>; root: string }
> {
  const root = await Deno.makeTempDir({ prefix: "run-sh-e2e-" });
  const p = await new Deno.Command("deno", {
    args: [
      "install",
      "-gAf",
      "--config",
      join(REPO_ROOT, "deno.json"),
      "-n",
      "am",
      join(REPO_ROOT, "src", "am.ts"),
    ],
    env: { ...Deno.env.toObject(), DENO_INSTALL_ROOT: join(root, "deno") },
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(
    p.code,
    0,
    `sandbox am install failed:\n${dec.decode(p.stderr)}`,
  );
  const env = {
    ...Deno.env.toObject(),
    AIO_HOME: REPO_ROOT, // a git checkout of aio — run.sh's prereq is satisfied
    AIO_APPS_DIR: join(root, "apps"),
    DENO_INSTALL_ROOT: join(root, "deno"),
    PATH: `${join(root, "deno", "bin")}:${Deno.env.get("PATH") ?? ""}`,
  };
  return { env, root };
}

Deno.test({
  name: "run.sh in an app repo: production build + the artifact serves the app",
  ignore: !GATE,
  fn: async () => {
    const { env, root } = await sandbox();
    const dir = await makeApp("counter", "run-sh-");
    const port = freePort();
    const proc = new Deno.Command("sh", {
      args: [join(REPO_ROOT, "run.sh"), "--", `--port=${port}`],
      cwd: dir,
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) log += dec.decode(c);
    };
    drain(proc.stdout).catch(() => {});
    drain(proc.stderr).catch(() => {});
    try {
      // Compile + boot: generous deadline, the compile dominates.
      const body = await waitForHttp(
        `http://127.0.0.1:${port}/__aio/health`,
        240_000,
      ).catch((e) => {
        throw new Error(`${e}\n--- run.sh output ---\n${log.slice(-4000)}`);
      });
      assert(body.includes('"status"'), `health answered oddly: ${body}`);
      // It really is the PRODUCTION artifact, not a dev server: the page shell
      // must be the prod one (bundled app.js, no dev import map).
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      assert(page.includes("app.js"), "prod shell serves the bundle");
      assert(!page.includes("importmap"), "no dev import map in prod");
    } finally {
      await kill(proc);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "run.sh --git <local repo> --no-run: clone + fix + build, artifact ready",
  ignore: !GATE,
  fn: async () => {
    const { env, root } = await sandbox();
    const appDir = await makeApp("counter", "run-sh-git-");
    const work = await Deno.makeTempDir({ prefix: "run-sh-clone-" });
    try {
      // Turn the scaffold into a git repo — the thing a GitHub URL resolves to.
      for (
        const args of [
          ["init", "-q"],
          ["add", "-A"],
          ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "app"],
        ]
      ) {
        const g = await new Deno.Command("git", {
          args,
          cwd: appDir,
          stdout: "null",
          stderr: "piped",
        }).output();
        assertEquals(g.code, 0, dec.decode(g.stderr));
      }

      const p = await new Deno.Command("sh", {
        args: [join(REPO_ROOT, "run.sh"), "--git", appDir, "--no-run"],
        cwd: work,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = dec.decode(p.stdout) + dec.decode(p.stderr);
      assertEquals(p.code, 0, `run.sh --git failed:\n${out.slice(-4000)}`);

      const cloneName = appDir.split("/").pop()!;
      const clone = join(work, cloneName);
      assert(
        (await Deno.stat(join(clone, ".git"))).isDirectory,
        "the repo was cloned",
      );
      // The built artifact is named in the output and exists + is executable.
      const m = out.match(/built (\S+)/);
      assert(m, `no 'built <artifact>' line in output:\n${out.slice(-2000)}`);
      const artifact = join(clone, m[1]!.replace(/^\.\//, ""));
      const st = await Deno.stat(artifact);
      assert(st.isFile, `artifact missing: ${artifact}`);
      assert((st.mode! & 0o111) !== 0, "artifact is executable");
    } finally {
      await Deno.remove(appDir, { recursive: true }).catch(() => {});
      await Deno.remove(work, { recursive: true }).catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "run.sh --dev: runs the dev server instead of building",
  ignore: !GATE,
  fn: async () => {
    const { env, root } = await sandbox();
    const dir = await makeApp("counter", "run-sh-dev-");
    const port = freePort();
    const proc = new Deno.Command("sh", {
      args: [join(REPO_ROOT, "run.sh"), "--dev", "--", `--port=${port}`],
      cwd: dir,
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const drain = async (s: ReadableStream<Uint8Array>) => {
      for await (const c of s) log += dec.decode(c);
    };
    drain(proc.stdout).catch(() => {});
    drain(proc.stderr).catch(() => {});
    try {
      await waitForHttp(`http://127.0.0.1:${port}/__aio/health`, 120_000)
        .catch((e) => {
          throw new Error(`${e}\n--- run.sh output ---\n${log.slice(-4000)}`);
        });
      // The DEV shell, not a prod artifact: live import map present.
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      assert(page.includes("importmap"), "dev shell has the import map");
    } finally {
      await kill(proc);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
