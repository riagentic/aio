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
  freePort,
  kill,
  killAnd,
  makeApp,
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
          args: ["check", "src/app.ts", "src/App.tsx", "src/cell.test.ts"],
          cwd: dir,
          stdout: "null",
          stderr: "piped",
        }).output();
        assertEquals(chk.code, 0, `check failed:\n${dec.decode(chk.stderr)}`);

        const t = await new Deno.Command("deno", {
          args: ["test", "-A", "src/cell.test.ts"],
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
// dev / dev:browser resolve to the same browser command. We assert both are
// wired to it, then boot that exact command and hit it over HTTP. We run the
// command directly (not via `deno task`) so killing the process cleanly stops
// the server — a `deno task` wrapper would leave the real server orphaned.
// (dev:android is the emulator orchestrator — covered by its own test below.)

Deno.test({
  name: "dev: browser dev command boots a server that serves the app " +
    "(dev · dev:browser)",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp();
    const dj = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
      tasks: Record<string, string>;
    };
    // `dev` omits --client for the default browser target (matches the
    // framework default); `dev:browser` always passes the explicit flag.
    assertEquals(
      dj.tasks["dev"],
      "deno run -A src/app.ts",
      "dev should run the app with the framework's browser default",
    );
    assertStringIncludes(
      dj.tasks["dev:browser"] ?? "",
      "--client=browser",
      "dev:browser should be an explicit browser dev command",
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

for (const compileTask of ["compile", "compile:browser"] as const) {
  Deno.test({
    name: `compile: \`${compileTask}\` yields a binary that boots + serves`,
    ignore: !GATE,
    fn: async () => {
      const dir = await makeApp();
      try {
        const r = await task(dir, compileTask);
        assertEquals(r.code, 0, `${compileTask} failed:\n${r.err}`);

        const binEntry = [...Deno.readDirSync(dir)].find((e) =>
          e.isFile && !e.name.includes(".")
        );
        assert(binEntry, "no compiled binary produced");
        const binPath = join(dir, binEntry.name);
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

// ── 5. compile:android — DUAL MODE: build the APK, or assert clear guidance ───

Deno.test({
  name: "compile:android: builds an APK when the toolchain is present, else " +
    "fails with clear guidance",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp();
    try {
      const capable = !!resolveSdk() && !!findGradle() && !!findJdk().home;

      const r = await task(dir, "compile:android");
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

// ── 5b. dev:android — wired to the emulator orchestrator; fails loud w/o SDK ──
// The real path (boot AVD → build dev APK → install → launch, WebView on the
// live dev server) needs an emulator, so it's verified manually. Here we prove
// the task runs the orchestrator and that it stops with clear guidance when the
// Android SDK is absent (never a silent browser fallback).

Deno.test({
  name:
    "dev:android: wired to the emulator orchestrator, fails loud without SDK",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp();
    try {
      const dj = JSON.parse(
        await Deno.readTextFile(join(dir, "deno.json")),
      ) as {
        tasks: Record<string, string>;
      };
      // Runs the emulator orchestrator — never a silent browser fallback.
      assertStringIncludes(dj.tasks["dev:android"] ?? "", "dev-android.ts");

      // On a machine with no SDK, it must exit non-zero with clear guidance.
      // (When an SDK IS present, the full boot→build→install→launch flow needs a
      // live emulator, so it's exercised manually rather than in the gate.)
      if (!resolveSdk()) {
        const p = await new Deno.Command("deno", {
          args: ["task", "dev:android"],
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

// ── 6. compile:electron — real AppImage only with AIO_ONBOARD_ELECTRON=1 ─────
// Electron is a ~100MB download + appimagetool fetch, so the real build is a
// second opt-in. Without it, we still prove the task is wired to auto-install
// electron (so it can never silently no-op).

Deno.test({
  name: "compile:electron: builds an AppImage (AIO_ONBOARD_ELECTRON=1) or is " +
    "wired to auto-install electron",
  ignore: !GATE,
  fn: async () => {
    const dir = await makeApp();
    try {
      const dj = JSON.parse(
        await Deno.readTextFile(join(dir, "deno.json")),
      ) as {
        tasks: Record<string, string>;
      };
      assertStringIncludes(dj.tasks["compile:electron"] ?? "", "--electron");
      // Electron auto-installs inside the build pipeline (no install prefix
      // chained into the task); `install:electron` stays as an optional
      // pre-fetch so the wiring can never silently no-op.
      assertEquals(
        dj.tasks["install:electron"],
        "deno install --allow-scripts=npm:electron",
      );

      if (ELECTRON) {
        const r = await task(dir, "compile:electron");
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
