// The build writes the binary as `<project>/<name>` before moving it to dist/.
// `am create media --template=assets` scaffolded a `media/` directory into an
// app called `media`, so its first `deno task build` died inside `deno compile`
// ("a directory exists with the same name") under a hint about server-only
// imports. Now: `am create` refuses a name that is one of the scaffold's own
// directories, and the compile step refuses a directory in the binary's place,
// naming it, before compiling.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
/** The framework's own registry imports, so its build modules load here. */
const frameworkImports = async () =>
  Object.fromEntries(
    Object.entries(
      JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")))
        .imports as Record<string, string>,
    ).filter(([, v]) => /^(jsr|npm):/.test(v)),
  );

Deno.test("am create: a name that is one of the app's own directories is refused", async () => {
  const dir = await tempDir("aio-create-dirname-");
  try {
    for (
      const [name, template] of [["media", "assets"], [
        "src",
        "counter",
      ]] as const
    ) {
      const out = await new Deno.Command(Deno.execPath(), {
        env: {
          DENO_COVERAGE_DIR: childCoverageDir(),
          AIO_APPS_DIR: join(dir, "apps"),
        },
        args: [
          "run",
          "-A",
          join(ROOT, "src", "am.ts"),
          "create",
          name,
          `--template=${template}`,
          "--json",
        ],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(!out.success, `${name}: created`);
      assertStringIncludes(
        dec(out.stdout) + dec(out.stderr),
        "names one of the app's own directories",
      );
      const made = await Deno.stat(join(dir, name)).then(
        () => true,
        () => false,
      );
      assertEquals(made, false, `${name}: something was written`);
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build: a directory where the binary goes is refused before compiling, naming it", async () => {
  const dir = await tempDir("aio-bin-is-dir-");
  try {
    await Deno.mkdir(join(dir, "src"));
    // The binary's own file name: `foldy.exe` on Windows.
    const bin = Deno.build.os === "windows" ? "foldy.exe" : "foldy";
    await Deno.mkdir(join(dir, bin));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "foldy", imports: await frameworkImports() }),
    );
    await Deno.writeTextFile(join(dir, "src", "app.ts"), `console.log(1);\n`);
    const runner = join(dir, "runner.ts");
    await Deno.writeTextFile(
      runner,
      `import { runDenoCompile } from "${spec(ROOT)}src/build/build-compile.ts";
import { loadBuildConfig } from "${spec(ROOT)}src/build/build-config.ts";
await runDenoCompile(await loadBuildConfig());
console.log("COMPILE RAN");
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: childCoverageDir() },
      args: ["run", "-A", runner, "--compile", "--cli", "--name=foldy"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const all = dec(out.stdout) + dec(out.stderr);
    assertEquals(out.code, 1, all);
    // The message wraps at the terminal width — a long temp path (macOS)
    // breaks the phrase over two lines.
    assertStringIncludes(all.replace(/\s+/g, " "), "which is a directory");
    assert(!all.includes("COMPILE RAN"), all);
    assert((await Deno.stat(join(dir, bin))).isDirectory);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am create: a name whose binary lands on a scaffold dir on ANY platform is refused, on every host", async () => {
  const { shadowedAppDir } = await import("../src/am/am-cmd-create.ts");
  const media = { name: "media", template: "assets", jsr: false } as const;
  const at = (target: "browser" | "cli" | "server" | "electron" | "android") =>
    shadowedAppDir({ ...media, target });
  // The bare `media` (Linux/macOS) lands on media/ — whatever the host is.
  assertEquals(at("browser"), "media");
  assertEquals(at("cli"), "media");
  assertEquals(at("server"), "media");
  // electron compiles into its staging dir, android builds an APK
  assertEquals(at("electron"), null);
  assertEquals(at("android"), null);
  assertEquals(
    shadowedAppDir({ ...media, name: "mediax", target: "cli" }),
    null,
  );
});
