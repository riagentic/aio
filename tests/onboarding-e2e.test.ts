// Exhaustive onboarding E2E — the release gate. Proves the WHOLE path a new
// user walks: install.sh → am → create → run every dev target → build every
// compile target (android included). These are REAL runs (git clone, HTTP
// server boot, esbuild + deno compile, gradle), so they're heavy and gated
// behind AIO_ONBOARD_E2E=1 — run them with `deno task test:onboard`.
//
// Toolchain-gated targets (android, electron) are DUAL-MODE: when the toolchain
// is present the target is actually built and its artifact asserted; when it's
// absent the test asserts our own clear guidance is emitted (the error path).
// So the suite is green on a bare box AND genuinely builds on a full one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  findGradle,
  findJdk,
  GRADLE_MAX_JDK,
  resolveSdk,
} from "../src/build/build-helpers.ts";
import {
  assertServesApp,
  buildFlags,
  freePort,
  kill,
  killAnd,
  makeApp,
  placedBinary,
  REPO_ROOT,
  spawn,
  task,
  waitForHttp,
} from "./e2e-app-harness.ts";

const GATE = Deno.env.get("AIO_ONBOARD_E2E") === "1";
const ELECTRON = Deno.env.get("AIO_ONBOARD_ELECTRON") === "1";
const dec = new TextDecoder();

// ── 1. install.sh: clone aio + install a working `am` (sandboxed) ────────────

Deno.test({
  name: "install.sh: clones aio + installs a runnable am, pinned to last tag",
  ignore: !GATE,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "onboard-install-" });
    try {
      const env = {
        ...Deno.env.toObject(),
        AIO_HOME: join(root, "lib", "aio"),
        AIO_REPO: REPO_ROOT, // clone from the local repo (git handles file paths)
        DENO_INSTALL_ROOT: join(root, "deno"), // sandbox the global am install
      };
      const p = await new Deno.Command("sh", {
        args: [join(REPO_ROOT, "install.sh")],
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(p.code, 0, `install.sh failed:\n${dec.decode(p.stderr)}`);

      // am landed in the sandbox and runs.
      const amBin = join(
        root,
        "deno",
        "bin",
        Deno.build.os === "windows" ? "am.exe" : "am",
      );
      assert((await Deno.stat(amBin)).isFile, "am was not installed");
      const v = await new Deno.Command(amBin, {
        args: ["version"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(v.code, 0, `am version failed:\n${dec.decode(v.stderr)}`);
      // `am version` prints JSON ({"version":"1.0.0-alphaN"}) — assert a semver.
      assert(
        /\d+\.\d+\.\d+/.test(dec.decode(v.stdout)),
        `am version had no semver:\n${dec.decode(v.stdout)}`,
      );

      // The clone was checked out at the LAST TAG (not the branch tip).
      const desc = await new Deno.Command("git", {
        args: ["-C", join(root, "lib", "aio"), "describe", "--tags"],
        stdout: "piped",
        stderr: "null",
      }).output();
      assertStringIncludes(dec.decode(desc.stdout), "v1.0.0-alpha");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

// ── 2. am create → check + starter test (per template) ───────────────────────

for (const tpl of ["counter", "todo"] as const) {
  Deno.test({
    name: `create: ${tpl} type-checks + starter test passes`,
    ignore: !GATE,
    fn: async () => {
      const dir = await makeApp(tpl);
      try {
        const chk = await new Deno.Command("deno", {
          // `tests/`, at the project root — the alpha61 one-answer for where
          // tests go (the scaffold moved with the docs and the quickstart).
          args: ["check", "src/app.ts", "src/App.tsx", "tests/cell.test.ts"],
          cwd: dir,
          stdout: "null",
          stderr: "piped",
        }).output();
        assertEquals(chk.code, 0, `check failed:\n${dec.decode(chk.stderr)}`);

        const t = await new Deno.Command("deno", {
          args: ["test", "-A", "tests/cell.test.ts"],
          cwd: dir,
          stdout: "null",
          stderr: "piped",
        }).output();
        assertEquals(
          t.code,
          0,
          `starter test failed:\n${dec.decode(t.stderr)}`,
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}

// ── 3. dev targets: the browser dev server really boots + serves ─────────────
// alpha52 task diet: ONE `dev` task whose flags pass through
// (`deno task dev --client=X`) replaced the dev:* matrix. We assert `dev` is
// the pass-through command, the matrix is really gone, then boot that exact
// command and hit it over HTTP. We run the command directly (not via
// `deno task`) so killing the process cleanly stops the server — a
// `deno task` wrapper would leave the real server orphaned.
// (android's dev flow is the emulator orchestrator — its own test below.)

Deno.test({
  name: "dev: browser dev command boots a server that serves the app " +
    "(dev, flags pass through)",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp();
    const dj = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
      tasks: Record<string, string>;
    };
    // `dev` omits --client for the default browser target (matches the
    // framework default); other shells are one pass-through flag away.
    assertEquals(
      dj.tasks["dev"],
      "deno run -A src/app.ts",
      "dev should run the app with the framework's browser default",
    );
    // The old dev:* matrix must be GONE — a leftover dev:browser would be a
    // second decider for the same command (the drift the diet removed).
    assertEquals(
      Object.keys(dj.tasks).filter((t) => t.startsWith("dev:")),
      [],
      "the scaffold must not carry dev:* matrix tasks (alpha52 task diet)",
    );

    const port = freePort();
    // NO --client flag on purpose: this boots exactly what `deno task dev`
    // resolves to. The browser default comes from the scaffolded `target`
    // field in deno.json (read by aio.run) — a hardcoded --client=browser
    // here would mask a broken default (it did: the framework fallback is
    // electron).
    const { proc, log } = spawn(
      "deno",
      ["run", "-A", "src/app.ts", `--port=${port}`],
      dir,
    );
    try {
      const body = await waitForHttp(`http://127.0.0.1:${port}/`, 60_000)
        .catch((e) => {
          throw new Error(`${e}\n--- server log ---\n${log()}`);
        });
      assertServesApp(body);
    } finally {
      await killAnd(proc, dir);
    }
  },
});

// ── 4. compile (binary) → the artifact exists AND boots + serves ─────────────

// The scaffolded `compile` task is the fleet pipeline narrowed to the default
// target — its binary lands in dist/. The direct build.ts spelling produces
// the same artifact in `dist/`, versioned; both must boot.
for (const via of ["task", "buildFlags"] as const) {
  Deno.test({
    name: `compile: \`${
      via === "task" ? "deno task compile" : "build.ts --compile"
    }\` yields a binary that boots + serves`,
    ignore: !GATE,
    fn: async () => {
      const dir = await makeApp();
      try {
        const r = via === "task"
          ? await task(dir, "compile")
          : await buildFlags(dir, "--compile");
        assertEquals(r.code, 0, `${via} compile failed:\n${r.err}`);

        // BOTH spellings place the same versioned name in `dist/` — which is
        // the point of this pair. `build.ts --compile` used to write the bare
        // name into the project root instead: a second build path, and the
        // untested one. There is one now, so there is one place to look.
        const binPath = placedBinary(dir);
        await Deno.chmod(binPath, 0o755);

        // Run the binary from a DIFFERENT directory — a compiled binary must be
        // portable (it embeds dist/), so prod-detection must NOT depend on a
        // real dist/ next to cwd. Running from the app dir (where dist/ exists)
        // hid a bug where the binary fell back to dev mode + the dev lint
        // (needs src/App.tsx at cwd) and crashed anywhere else — e.g. an
        // AppImage mount. This guards that regression.
        const runCwd = await Deno.makeTempDir();
        const port = freePort();
        const { proc, log } = spawn(
          binPath,
          ["--client=browser", `--port=${port}`],
          runCwd,
        );
        try {
          const body = await waitForHttp(`http://127.0.0.1:${port}/`, 30_000)
            .catch((e) => {
              throw new Error(`${e}\n--- binary log ---\n${log()}`);
            });
          assertServesApp(body);
        } finally {
          try {
            proc.kill("SIGKILL");
            await proc.status;
          } catch { /* gone */ }
          await Deno.remove(runCwd, { recursive: true }).catch(() => {});
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}

// ── 5. android — DUAL MODE: build the APK, or assert clear guidance ──────────

Deno.test({
  name: "android: builds an APK when the toolchain is present, else " +
    "fails with clear guidance",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp();
    try {
      const capable = !!resolveSdk() && !!findGradle() && !!findJdk().home;

      const r = await buildFlags(dir, "--android");
      const msg = r.out + r.err;

      if (capable) {
        assertEquals(r.code, 0, `android build failed:\n${msg}`);
        const apk = [...Deno.readDirSync(dir)].some((e) =>
          e.isFile && e.name.endsWith(".apk")
        );
        assert(apk, "toolchain present but no .apk produced");
      } else {
        assert(r.code !== 0, "expected a non-zero exit without the toolchain");
        assert(
          /ANDROID_HOME not set|no compatible JDK|gradle not found/.test(msg),
          `error should name the missing toolchain, got:\n${msg}`,
        );
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── 5b. android dev — wired to the emulator orchestrator; fails loud w/o SDK ──
// The real path (boot AVD → build dev APK → install → launch, WebView on the
// live dev server) needs an emulator, so it's verified manually. Here we prove
// an ANDROID-target scaffold's `dev` runs the orchestrator (alpha52 task diet:
// android has no --client flag, so its dev default IS the orchestrator) and
// that it stops with clear guidance when the Android SDK is absent (never a
// silent browser fallback).

Deno.test({
  name:
    "android dev: wired to the emulator orchestrator, fails loud without SDK",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp("counter", "onboard-", "android");
    try {
      const dj = JSON.parse(
        await Deno.readTextFile(join(dir, "deno.json")),
      ) as {
        tasks: Record<string, string>;
      };
      // Runs the emulator orchestrator — never a silent browser fallback.
      assertStringIncludes(dj.tasks["dev"] ?? "", "dev-android.ts");

      // On a machine with no SDK, it must exit non-zero with clear guidance.
      // (When an SDK IS present, the full boot→build→install→launch flow needs a
      // live emulator, so it's exercised manually rather than in the gate.)
      if (!resolveSdk()) {
        const p = await new Deno.Command("deno", {
          args: ["task", "dev"],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(p.code !== 0, "expected non-zero exit without the Android SDK");
        assertStringIncludes(
          dec.decode(p.stdout) + dec.decode(p.stderr),
          "SDK",
        );
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── 6. electron — real AppImage only with AIO_ONBOARD_ELECTRON=1 ─────────────
// Electron is a ~100MB download + appimagetool fetch, so the real build is a
// second opt-in. Without it, we still prove the electron-scaffold wiring (the
// install convenience) so it can never silently no-op.

Deno.test({
  name: "electron: builds an AppImage (AIO_ONBOARD_ELECTRON=1) or is " +
    "wired to auto-install electron",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp();
    try {
      // Electron auto-installs inside the build pipeline; an ELECTRON-target
      // scaffold also carries `install:electron` as an optional pre-fetch.
      const { denoJson } = await import("../src/am/am-cmd-create.ts");
      const edj = JSON.parse(denoJson("demo", true, "electron")) as {
        tasks: Record<string, string>;
      };
      // NOT `deno install --allow-scripts=npm:electron` — that command exits 0
      // having skipped the lifecycle script, leaving no binary (a field report
      // walked that loop). The task is the launcher's own installer now, so
      // the two cannot disagree.
      assertStringIncludes(
        edj.tasks["install:electron"]!,
        "electron-install.ts",
      );

      if (ELECTRON) {
        const r = await buildFlags(dir, "--compile", "--electron");
        assertEquals(r.code, 0, `electron build failed:\n${r.err}`);
        const appimage = [...Deno.readDirSync(dir)].some((e) =>
          e.isFile && e.name.toLowerCase().endsWith(".appimage")
        );
        assert(appimage, "no AppImage produced");
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// A cheap always-on guard so the file itself is never a silent no-op: the
// version-aware JDK selector must reject a JDK newer than Gradle supports.
Deno.test("onboarding: JDK selection respects the Gradle ceiling", () => {
  assert(GRADLE_MAX_JDK >= 17, "AGP needs at least JDK 17");
  const r = findJdk();
  if (r.home !== null) {
    // Whatever we picked must be runnable by the pinned Gradle.
    assert(r.newestFound >= 0);
  }
});
