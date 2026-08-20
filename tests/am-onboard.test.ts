import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { resolve } from "@std/path";
import {
  denoJson,
  frameworkSpecs,
  parseCreateArgs,
  scaffold,
} from "../src/am/am-cmd-create.ts";
import { uninstallArgv, updateArgv } from "../src/am/am-cmd-meta.ts";
import { VERSION } from "../src/server/aio.ts";

const REPO_ROOT = resolve(import.meta.dirname!, "..");

// ── arg parsing ─────────────────────────────────────────────────────────────

Deno.test("parseCreateArgs: name + default template", () => {
  const o = parseCreateArgs(["my-app"]);
  assertEquals(o.name, "my-app");
  assertEquals(o.template, "counter");
  assertEquals(o.force, false);
  assertEquals(o.mirror, undefined);
});

Deno.test("parseCreateArgs: --template + --force + --mirror", () => {
  const o = parseCreateArgs([
    "todo-app",
    "--template=todo",
    "--force",
    "--mirror",
  ]);
  assertEquals(o.name, "todo-app");
  assertEquals(o.template, "todo");
  assertEquals(o.force, true);
  assertEquals(o.mirror, "");
});

Deno.test("parseCreateArgs: --jsr opts into JSR (source is the default)", () => {
  assertEquals(parseCreateArgs(["app"]).jsr, undefined); // default = source
  assertEquals(parseCreateArgs(["app", "--jsr"]).jsr, true);
});

// ── framework specifiers ────────────────────────────────────────────────────

Deno.test("frameworkSpecs: JSR mode (--jsr) pins to this am's version (lockstep)", () => {
  const fw = frameworkSpecs(false);
  assertEquals(fw.imports["aio"], `jsr:@riagentic/aio@${VERSION}`);
  assertEquals(
    fw.imports["aio/jsx-runtime"],
    `jsr:@riagentic/aio@${VERSION}/jsx-runtime`,
  );
  assertStringIncludes(fw.build, `@${VERSION}/build`);
  // JSR map stays minimal — no vendored deps leak into the app.
  assert(!("esbuild" in fw.imports));
});

Deno.test("frameworkSpecs: source mode uses the dep/aio symlink + carries source deps", () => {
  const fw = frameworkSpecs(true);
  assertEquals(fw.imports["aio"], "./dep/aio/mod.ts");
  assertEquals(fw.imports["esbuild"], "npm:esbuild@^0.24");
  assertStringIncludes(fw.build, "./dep/aio/src/build.ts");
});

// ── generated deno.json: the alpha52 task diet (one vocabulary) ─────────────

Deno.test("denoJson: the scaffold emits the dieted task set EXACTLY", () => {
  const dj = JSON.parse(denoJson("demo", true)) as {
    tasks: Record<string, string>;
    compilerOptions: Record<string, unknown>;
    client: string;
  };
  // The whole set, pinned exactly — a new task is a deliberate diff here, and
  // the 30-task dev:*/compile:* matrix must never creep back (dev flags pass
  // through; the fleet build is the one way to build).
  assertEquals(Object.keys(dj.tasks).sort(), [
    "am",
    "build",
    "check",
    "compile",
    "dev",
    "doctor",
    "fmt",
    "lint",
    "test",
  ]);
  // dev works out of the box (browser — no toolchain, no electron download).
  // The --client flag is OMITTED for the default target: it matches the
  // framework default; other shells pass through (`deno task dev --client=X`).
  assertEquals(dj.tasks.dev, "deno run -A src/app.ts");
  // build = the fleet; compile = the fleet narrowed to the default target.
  assertStringIncludes(dj.tasks.build!, "build-all");
  assertStringIncludes(dj.tasks.compile!, "--targets=browser");
  assertEquals(dj.tasks.test, "deno test -A");
  assertEquals(dj.tasks.check, "deno check src/");
  assertEquals(dj.tasks.fmt, "deno fmt");
  assertEquals(dj.compilerOptions.jsxImportSource, "aio");
  // The default shell is recorded under the alpha52 key name.
  assertEquals(dj.client, "browser");
});

Deno.test("denoJson: install:electron is scaffolded ONLY for electron", () => {
  const tasks = (t?: "browser" | "electron" | "cli") =>
    (JSON.parse(denoJson("demo", true, t)) as {
      tasks: Record<string, string>;
    }).tasks;
  assertEquals(tasks().hasOwnProperty("install:electron"), false);
  assertEquals(tasks("cli").hasOwnProperty("install:electron"), false);
  // NOT `deno install --allow-scripts=npm:electron`: that command exits 0
  // having skipped the lifecycle script whenever deno decides the package is
  // not newly added, leaving no `dist/` — and the build then advises running
  // the very task that just did nothing (a field report went round that loop).
  // The task IS the launcher's own installer, which falls back to the
  // package's `install.js`, so the two cannot disagree.
  assertStringIncludes(
    tasks("electron")["install:electron"]!,
    "electron-install.ts",
  );
});

Deno.test("denoJson: --target picks the dev/compile DEFAULT per target", () => {
  const tasks = (t: "electron" | "android" | "cli" | "server") =>
    (JSON.parse(denoJson("demo", true, t)) as {
      tasks: Record<string, string>;
    }).tasks;
  // electron: explicit client flag; compile narrows the fleet to electron.
  assertStringIncludes(tasks("electron").dev!, "--client=electron");
  assertStringIncludes(tasks("electron").compile!, "--targets=electron");
  // android has NO client flag — its dev default IS the emulator orchestrator.
  assertStringIncludes(tasks("android").dev!, "dev-android.ts");
  assertStringIncludes(tasks("android").compile!, "--targets=android");
  // headless targets map cli → cli, server → server-only — at DEV time, where
  // `--client=X` is the flag `aio.run()` reads.
  assertStringIncludes(tasks("cli").dev!, "--client=cli");
  assertStringIncludes(tasks("server").dev!, "--client=server-only");
  // …and NOT at build time: `--client=X` is a runtime flag the build does not
  // parse. `compile` delegates to the fleet pipeline (its per-target flag
  // table), so the two spellings cannot drift — there is only one.
  assertStringIncludes(tasks("cli").compile!, "--targets=cli");
  assertStringIncludes(tasks("server").compile!, "--targets=server");
  for (const t of ["electron", "android", "cli", "server"] as const) {
    assert(
      !tasks(t).compile!.includes("--client="),
      `${t}: a runtime --client= flag has no meaning in a compile task`,
    );
  }
});

Deno.test("parseCreateArgs: --target=service is the deprecated alias of server", () => {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    const o = parseCreateArgs(["app", "--target=service"]);
    assertEquals(o.target, "server");
    assert(
      errs.some((e) => e.includes("--target=server")),
      "the alias must name the new spelling",
    );
  } finally {
    console.error = orig;
  }
});

// ── scaffold file set ───────────────────────────────────────────────────────

Deno.test("scaffold: counter + todo emit the expected src/-based files", () => {
  for (const tpl of ["counter", "todo"] as const) {
    const files = scaffold("app", tpl, true);
    for (
      const f of [
        "deno.json",
        "src/app.ts",
        "src/cell.ts",
        "src/App.tsx",
        "src/client.ts", // thin CLI client — the cli-client target's entry
        // `tests/`, at the project root — ONE answer to "where do tests go".
        // Three were in circulation (here, project-structure.md's `src/test/`,
        // and the quickstart's `deno test -A tests/`); a field report picked
        // one and noted that having three was the problem.
        "tests/cell.test.ts",
        ".gitignore",
        "README.md",
      ]
    ) {
      assert(f in files, `${tpl} missing ${f}`);
    }
    // The scaffold OPTS IN to the default look — `ui.theme` defaults to
    // "tokens" (nothing that paints), so a new app that said nothing would
    // render as raw user-agent HTML while its template markup assumes cards
    // and a page shell.
    assertStringIncludes(
      files["src/app.ts"]!,
      'aio.run({ ui: { theme: "auto" } })',
    );
  }
  assertStringIncludes(
    scaffold("app", "counter", true)["src/cell.ts"]!,
    'cell("counter"',
  );
  assertStringIncludes(
    scaffold("app", "todo", true)["src/cell.ts"]!,
    'cell("todo"',
  );
});

// ── update / uninstall recipes ──────────────────────────────────────────────

Deno.test("updateArgv: idempotent global reinstall of newest alpha (not bare)", () => {
  assertEquals(updateArgv(), [
    "install",
    "-gAf",
    "--reload",
    "-n",
    "am",
    "jsr:@riagentic/aio@^1.0.0-alpha/am",
  ]);
});

Deno.test("uninstallArgv: removes only the global am", () => {
  assertEquals(uninstallArgv(), ["uninstall", "-g", "am"]);
});

// ── integration: a generated app type-checks against the real framework ─────
// The strongest proof short of booting — mirror mode maps `aio` at the repo so
// `deno check` resolves every import + JSX + type, i.e. `deno task dev` is sound.

// Heavy build smoke — proves `am create` → `deno task compile` yields a binary
// (locks the flat-vs-src/ layout regression). Opt-in: it runs esbuild + deno
// compile (~40s), so CI sets AIO_BUILD_SMOKE=1; the default suite skips it.
Deno.test({
  name: "build smoke: generated counter compiles to a binary",
  ignore: Deno.env.get("AIO_BUILD_SMOKE") !== "1",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "am-compile-" });
    try {
      for (
        const [rel, content] of Object.entries(scaffold("app", "counter", true))
      ) {
        const path = resolve(dir, rel);
        await Deno.mkdir(resolve(path, ".."), { recursive: true });
        await Deno.writeTextFile(path, content);
      }
      await Deno.mkdir(resolve(dir, "dep"), { recursive: true });
      await Deno.symlink(REPO_ROOT, resolve(dir, "dep/aio")); // dep/aio → the repo
      const { code, stderr } = await new Deno.Command("deno", {
        args: ["task", "compile"],
        cwd: dir,
        stderr: "piped",
        stdout: "null",
      }).output();
      assertEquals(
        code,
        0,
        `compile failed:\n${new TextDecoder().decode(stderr)}`,
      );
      // `compile` is the fleet pipeline narrowed to the default target, so the
      // binary (a file with no extension) + manifest.json land in dist/.
      const dist = [...Deno.readDirSync(resolve(dir, "dist"))];
      const bin = dist.some((e) => e.isFile && !e.name.includes("."));
      assert(bin, "no compiled binary produced in dist/");
      assert(
        dist.some((e) => e.name === "manifest.json"),
        "fleet build wrote no manifest.json",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// Matrix build smoke — the single-target build flags yield real binaries from
// a scaffold: cli (local), server (headless), cli-client (src/client.ts).
// Same opt-in as the counter smoke: three deno compiles, minutes not seconds.
Deno.test({
  name: "build smoke: cli, server, and cli-client binaries via build.ts",
  ignore: Deno.env.get("AIO_BUILD_SMOKE") !== "1",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "am-matrix-" });
    try {
      for (
        const [rel, content] of Object.entries(scaffold("app", "counter", true))
      ) {
        const path = resolve(dir, rel);
        await Deno.mkdir(resolve(path, ".."), { recursive: true });
        await Deno.writeTextFile(path, content);
      }
      await Deno.mkdir(resolve(dir, "dep"), { recursive: true });
      await Deno.symlink(REPO_ROOT, resolve(dir, "dep/aio"));
      const build = async (args: string[]): Promise<void> => {
        const { code, stderr } = await new Deno.Command("deno", {
          args: ["run", "-A", "dep/aio/src/build.ts", ...args],
          cwd: dir,
          stderr: "piped",
          stdout: "null",
        }).output();
        assertEquals(
          code,
          0,
          `build ${args.join(" ")} failed:\n${
            new TextDecoder().decode(stderr)
          }`,
        );
      };
      await build(["--compile", "--cli"]); // cli target → ./app
      await build(["--compile", "--service", "--headless"]); // server target
      await build(["--compile", "--cli", "--remote"]); // cli-client → ./app-client
      const names = [...Deno.readDirSync(dir)].map((e) => e.name);
      assert(names.includes("app"), `no cli/service binary in ${names}`);
      assert(
        names.includes("app-client"),
        `no remote client binary in ${names}`,
      );

      // `--out=` — the answer to "I orchestrate my own builds" (rimote R-4).
      // Two apps in one repo cannot both stage through dist/: it is embedded
      // into the binary wholesale and wiped by every build, so the first
      // artifact is gone by the time the second finishes.
      await build(["--compile", "--cli", "--out=release/one"]);
      const staged = [...Deno.readDirSync(resolve(dir, "release/one"))].map(
        (e) => e.name,
      );
      assert(
        staged.includes("app"),
        `--out= did not place the binary: ${staged}`,
      );

      // …and an --out inside dist/ is REFUSED, because that is the trap.
      const bad = await new Deno.Command("deno", {
        args: [
          "run",
          "-A",
          "dep/aio/src/build.ts",
          "--compile",
          "--cli",
          "--out=dist/release",
        ],
        cwd: dir,
        stderr: "piped",
        stdout: "null",
      }).output();
      assertEquals(bad.code, 1, "--out inside dist/ must be refused");
      assertStringIncludes(
        new TextDecoder().decode(bad.stderr),
        "points inside dist/",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

for (const tpl of ["counter", "todo"] as const) {
  Deno.test(`integration: generated ${tpl} app type-checks + starter test passes`, async () => {
    const dir = await Deno.makeTempDir({ prefix: `am-${tpl}-` });
    try {
      const files = scaffold(tpl, tpl, true);
      for (const [rel, content] of Object.entries(files)) {
        const path = resolve(dir, rel);
        await Deno.mkdir(resolve(path, ".."), { recursive: true });
        await Deno.writeTextFile(path, content);
      }
      await Deno.mkdir(resolve(dir, "dep"), { recursive: true });
      await Deno.symlink(REPO_ROOT, resolve(dir, "dep/aio")); // dep/aio → the repo
      const dec = new TextDecoder();
      // Type-checks against the real framework (proves `deno task dev` is sound).
      const chk = await new Deno.Command("deno", {
        args: [
          "check",
          "src/app.ts",
          "src/App.tsx",
          "src/client.ts",
          "tests/cell.test.ts",
        ],
        cwd: dir,
        stderr: "piped",
        stdout: "null",
      }).output();
      assertEquals(
        chk.code,
        0,
        `deno check failed for ${tpl}:\n${dec.decode(chk.stderr)}`,
      );
      // The starter test is GREEN out of the box (`deno task test`).
      const test = await new Deno.Command("deno", {
        args: ["test", "-A", "tests/cell.test.ts"],
        cwd: dir,
        stderr: "piped",
        stdout: "null",
      }).output();
      assertEquals(
        test.code,
        0,
        `starter test failed for ${tpl}:\n${dec.decode(test.stderr)}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
