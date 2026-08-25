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
    // run.sh runs install.sh EVERY time now. Without this it would curl the
    // PUBLISHED install.sh — a network call in an offline suite, and one that
    // once force-checked-out the last tag onto THIS working tree (AIO_HOME is
    // the repo). This checkout's installer leaves a working checkout alone.
    AIO_INSTALL: join(REPO_ROOT, "install.sh"),
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

      // The launcher prepared a private unpack dir before exec'ing. Asserted
      // on the compile target because the WIRING is what regresses — an
      // AppImage would then unpack into it instead of shared /tmp.
      const printed = await new Deno.Command("deno", {
        args: [
          "run",
          "-A",
          join(REPO_ROOT, "src", "build.ts"),
          "--print-app-tmpdir",
        ],
        cwd: dir,
        env,
        stdout: "piped",
        stderr: "null",
      }).output();
      const payload = dec.decode(printed.stdout).trim();
      assert(
        payload.startsWith(join(root, "apps")),
        `the unpack dir must sit under the app's own home, got ${payload}`,
      );
      const st = await Deno.stat(payload);
      assert(st.isDirectory, `run.sh did not create ${payload}`);
      assertEquals(
        st.mode! & 0o777,
        0o700,
        "the unpack dir must be owner-only",
      );
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

Deno.test({
  name: "run.sh builds with the aio the app PINS, not the one installed",
  ignore: !GATE,
  fn: async () => {
    // The forever-guarantee, end to end: a cloned app names its framework, and
    // the one-liner builds it with THAT framework on a machine that has never
    // seen it. Proven differentially — the installed aio's builder is
    // sabotaged, so a regression that reaches for $AIO_HOME instead of the
    // pinned worktree fails loudly here instead of silently building an app
    // against a version it never asked for.
    const base = await Deno.makeTempDir({ prefix: "run-sh-pin-" });
    const install = join(base, "install");
    const versions = join(base, "versions");
    const clone = await new Deno.Command("git", {
      // --no-hardlinks: /tmp is usually another filesystem.
      args: ["clone", "-q", "--no-hardlinks", REPO_ROOT, install],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(clone.code, 0, dec.decode(clone.stderr));
    const SENTINEL = "installed-aio-builder-must-not-be-used";
    const noopInstall = join(base, "install.sh");
    await Deno.writeTextFile(noopInstall, "#!/bin/sh\nexit 0\n");
    await Deno.writeTextFile(
      join(install, "src", "build.ts"),
      `throw new Error("${SENTINEL}");\n`,
    );

    const { env: baseEnv, root } = await sandbox();
    const dir = await makeApp("counter", "run-sh-pin-app-");
    try {
      // A fresh clone of an app: no framework link, and no `compile` task, so
      // run.sh must resolve the builder itself — the path that used to leak.
      await Deno.remove(join(dir, "dep", "aio"));
      const cfgPath = join(dir, "deno.json");
      const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
      delete cfg.tasks.compile; // am fix restores it — asserted below
      cfg.aioVersion = "main"; // resolves to an immutable main-<sha> worktree
      await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

      const env = { ...baseEnv, AIO_HOME: install, AIO_VERSIONS_DIR: versions };
      const p = await new Deno.Command("sh", {
        args: [join(REPO_ROOT, "run.sh"), "--no-run"],
        cwd: dir,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = dec.decode(p.stdout) + dec.decode(p.stderr);
      assert(
        !out.includes(SENTINEL),
        `run.sh built with the INSTALLED aio instead of the app's pin:\n${
          out.slice(-3000)
        }`,
      );
      assertEquals(p.code, 0, `run.sh failed:\n${out.slice(-4000)}`);

      // The pin was provisioned and linked — and it is the pinned worktree the
      // build ran against, not the install.
      const link = await Deno.readLink(join(dir, "dep", "aio"));
      assert(
        link.startsWith(versions),
        `dep/aio points at ${link}, not into the versions store`,
      );
      assert(
        /main-[0-9a-f]{7,}$/.test(link),
        `a moving pin must resolve to an immutable ref: ${link}`,
      );
      assert(
        (await Deno.stat(join(link, "mod.ts"))).isFile,
        "the pinned version is a real checkout",
      );
      const m = out.match(/built (\S+)/);
      assert(m, `no 'built <artifact>' line:\n${out.slice(-2000)}`);
      const st = await Deno.stat(join(dir, m[1]!.replace(/^\.\//, "")));
      assert(st.isFile && (st.mode! & 0o111) !== 0, "artifact is executable");
      // The missing `compile` task was repaired on the way through, so the
      // build ran the app's OWN task — which points at dep/aio, the pin.
      const after = JSON.parse(await Deno.readTextFile(cfgPath));
      assert(after.tasks.compile, "am fix restored the standard compile task");
      assert(
        after.tasks.compile.includes("dep/aio"),
        `the restored task must build through the pin: ${after.tasks.compile}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.remove(base, { recursive: true }).catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "run.sh without a compile task builds through dep/aio, not $AIO_HOME",
  ignore: !GATE,
  fn: async () => {
    // run.sh's last-resort branch: a hand-rolled app with no `compile` task.
    // `am fix` normally restores that task (previous test), so this drives the
    // branch directly with a no-op `am` on PATH — the fallback must still reach
    // for the app's own framework link before the machine's installed aio.
    // Differential again: the installed builder throws if it is ever used.
    const base = await Deno.makeTempDir({ prefix: "run-sh-fallback-" });
    const install = join(base, "install");
    const denoHome = join(base, "deno");
    const bin = join(denoHome, "bin");
    const SENTINEL = "installed-aio-builder-must-not-be-used";
    const noopInstall = join(base, "install.sh");
    await Deno.writeTextFile(noopInstall, "#!/bin/sh\nexit 0\n");
    await Deno.mkdir(join(install, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(install, "src", "build.ts"),
      `throw new Error("${SENTINEL}");\n`,
    );
    await Deno.writeTextFile(join(install, "mod.ts"), "export {};\n");
    // run.sh treats a non-git AIO_HOME as "not installed" and would fetch
    // install.sh from the network — this suite is strictly offline.
    await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: install,
      stdout: "null",
      stderr: "null",
    }).output();
    // run.sh prepends "$DENO_INSTALL/bin" to PATH, so the stub has to live
    // THERE — otherwise the machine's real `am` wins and repairs the very task
    // whose absence this test is about.
    await Deno.mkdir(bin, { recursive: true });
    await Deno.writeTextFile(join(bin, "am"), "#!/bin/sh\nexit 0\n");
    await Deno.chmod(join(bin, "am"), 0o755);

    const dir = await makeApp("counter", "run-sh-fallback-app-");
    try {
      const cfgPath = join(dir, "deno.json");
      const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
      delete cfg.tasks.compile;
      await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

      const p = await new Deno.Command("sh", {
        args: [join(REPO_ROOT, "run.sh"), "--no-run"],
        cwd: dir,
        env: {
          ...Deno.env.toObject(),
          AIO_HOME: install,
          AIO_INSTALL: noopInstall, // a sabotaged AIO_HOME has no am to install
          DENO_INSTALL: denoHome,
          DENO_INSTALL_ROOT: denoHome,
          PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = dec.decode(p.stdout) + dec.decode(p.stderr);
      assert(
        !out.includes(SENTINEL),
        `the fallback built with $AIO_HOME instead of the app's dep/aio:\n${
          out.slice(-3000)
        }`,
      );
      assertEquals(p.code, 0, `run.sh failed:\n${out.slice(-4000)}`);
      assert(/built \S+/.test(out), `no artifact:\n${out.slice(-2000)}`);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.remove(base, { recursive: true }).catch(() => {});
    }
  },
});
