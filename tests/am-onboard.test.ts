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

// ── generated deno.json: the target build tasks (onboard#4/#5) ──────────────

Deno.test("denoJson: dev defaults to browser + per-target dev/compile tasks", () => {
  const dj = JSON.parse(denoJson("demo", true)) as {
    tasks: Record<string, string>;
    compilerOptions: Record<string, unknown>;
  };
  // dev works out of the box (browser — no toolchain, no electron download).
  // The --client flag is OMITTED for the default target: it matches the
  // framework default, and per-target tasks stay accurate regardless.
  assertEquals(dj.tasks.dev, "deno run -A src/app.ts");
  assertStringIncludes(dj.tasks["dev:browser"]!, "--client=browser");
  // Electron auto-installs on first run — no install prefix chained into the
  // task; `install:electron` exists as an optional pre-fetch convenience.
  assertStringIncludes(dj.tasks["dev:electron"]!, "--client=electron");
  assertEquals(
    dj.tasks["install:electron"],
    "deno install --allow-scripts=npm:electron",
  );
  assertStringIncludes(dj.tasks["dev:android"]!, "dev-android.ts");
  // compile: default binary + per-target
  assertStringIncludes(dj.tasks.compile!, "--compile");
  assertStringIncludes(dj.tasks["compile:browser"]!, "--compile");
  assertStringIncludes(dj.tasks["compile:electron"]!, "--electron");
  assertStringIncludes(dj.tasks["compile:android"]!, "--android");
  assertEquals(dj.tasks.test, "deno test -A");
  assertEquals(dj.compilerOptions.jsxImportSource, "aio");
});

Deno.test("denoJson: --target picks the dev/compile DEFAULT per target", () => {
  const tasks = (t: "electron" | "android" | "cli" | "server") =>
    (JSON.parse(denoJson("demo", true, t)) as {
      tasks: Record<string, string>;
    }).tasks;
  // electron: explicit client flag; compile builds the desktop app.
  assertStringIncludes(tasks("electron").dev!, "--client=electron");
  assertStringIncludes(tasks("electron").compile!, "--electron");
  // android has NO client flag — its dev default IS the emulator
  // orchestrator (identical to the explicit dev:android task).
  assertStringIncludes(tasks("android").dev!, "dev-android.ts");
  assertStringIncludes(tasks("android").compile!, "--android");
  // headless targets map cli → cli, server → server-only.
  assertStringIncludes(tasks("cli").dev!, "--client=cli");
  assertStringIncludes(tasks("server").dev!, "--client=server-only");
  assertStringIncludes(tasks("server").compile!, "--client=server-only");
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
        "src/cell.test.ts",
        ".gitignore",
        "README.md",
      ]
    ) {
      assert(f in files, `${tpl} missing ${f}`);
    }
    assertStringIncludes(files["src/app.ts"]!, "aio.run()");
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
      // A binary (not a .ts/.json) must exist.
      const bin = [...Deno.readDirSync(dir)].some((e) =>
        e.isFile && !e.name.includes(".")
      );
      assert(bin, "no compiled binary produced");
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
        args: ["check", "src/app.ts", "src/App.tsx", "src/cell.test.ts"],
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
        args: ["test", "-A", "src/cell.test.ts"],
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
