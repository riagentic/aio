// The `cli` target is a compiled target like the others — it used to be built
// by a second, hand-written `deno compile` argv, and the copy had drifted:
//
//   • no build stamp → `<cli> --version` printed "unknown (compiled binary
//     carries no build stamp — rebuild it with aio's builder, `deno task
//     build`…)": advice to run the exact command that had just produced it,
//     while the `browser` target of the same commit printed `0.1.2`.
//   • no `--v8-flags` → an app's `build.v8Flags` (the ONLY channel into a
//     compiled binary's heap ceiling; a compiled binary ignores
//     `DENO_V8_FLAGS`) silently did not apply to its CLI.
//   • no smoke run → a project path with a space shipped a `cli` binary that
//     dies with ERR_MODULE_NOT_FOUND on every flag, under a ✓ — the exact
//     bug closed for every OTHER compiled target one commit earlier.
//
// The argv is now assembled by `compileArgs`, the one decider, and the wiring
// is pinned here without running a compile.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cliCompileArgs } from "../src/build/build-cli.ts";
import { smokeRunArtifact } from "../src/build/build-compile.ts";
import { BUILD_STAMP_FILE } from "../src/build/build-version.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function includes(args: string[]): string[] {
  return args.flatMap((a, i) => args[i - 1] === "--include" ? [a] : []);
}

Deno.test("cli target: the compile argv embeds the build stamp, like every other target", () => {
  const args = cliCompileArgs({
    doRemote: false,
    out: "/out/tool",
    entry: "src/app.ts",
    assets: ["--include", "deno.json"],
    excludes: [],
    v8Flags: [],
  });
  assert(
    includes(args).includes(BUILD_STAMP_FILE),
    `the stamp is not embedded — --version will say "unknown":\n${
      args.join(" ")
    }`,
  );
  // The app's own identity still travels (assetIncludes' deno.json).
  assert(includes(args).includes("deno.json"), args.join(" "));
  // …and the SQLite worker: a `cli` app persists like any other.
  assert(
    includes(args).some((p) => p.endsWith("db-worker.ts")),
    `the DB worker is not embedded:\n${args.join(" ")}`,
  );
  // Shape: `-o <out> <entry>` last, so a stray include cannot displace them.
  assertEquals(args.slice(-3), ["-o", "/out/tool", "src/app.ts"]);
  assertEquals(args[0], "compile");
});

Deno.test("cli target: a remote CLI client embeds no worker, but keeps the stamp", () => {
  const args = cliCompileArgs({
    doRemote: true,
    out: "tool-client",
    entry: "src/client.ts",
    assets: [],
    excludes: [],
    v8Flags: [],
  });
  assert(
    !includes(args).some((p) => p.endsWith("db-worker.ts")),
    `a remote client opens no database:\n${args.join(" ")}`,
  );
  assert(includes(args).includes(BUILD_STAMP_FILE), args.join(" "));
});

Deno.test("cli target: v8 flags, the cross-compile triple and the excludes reach deno", () => {
  const args = cliCompileArgs({
    doRemote: false,
    out: "tool-windows.exe",
    entry: "src/app.ts",
    assets: [],
    excludes: ["/p/node_modules/.deno/esbuild@0.25.0"],
    v8Flags: ["--v8-flags=--max-old-space-size=8192"],
    target: "x86_64-pc-windows-msvc",
  });
  assertStringIncludes(args.join(" "), "--v8-flags=--max-old-space-size=8192");
  const t = args.indexOf("--target");
  assert(t > 0 && args[t + 1] === "x86_64-pc-windows-msvc", args.join(" "));
  const x = args.indexOf("--exclude");
  assert(
    x > 0 && args[x + 1] === "/p/node_modules/.deno/esbuild@0.25.0",
    args.join(" "),
  );
  // A CLI never carries a browser bundle.
  assert(!includes(args).includes("dist/"), args.join(" "));
});

// ── the probe ────────────────────────────────────────────────────────────────
//
// `smokeRunArtifact` decides "compiled, but does not run" for every compiled
// target. Its default question is `--version`, which `aio.run()` answers
// before anything boots. A `cli` target's entry is the app's OWN program and
// may parse argv first; `aio/cli`'s `args()` answers `--help` unconditionally
// but forwards `--version` when the spec declares none — and a spec with
// `commands:` then exits 2 with "missing command" for a perfectly good
// binary. So the CLI builder asks `--help`, and this pins that the probe is
// what is asked and that the verdict follows the exit code.
Deno.test({
  name:
    "cli target: the smoke run asks the flag it was given and judges by exit code",
  ignore: Deno.build.os === "windows", // the stand-in artifact is a shell script
  fn: async () => {
    const dir = await tempDir("aio-cli-smoke-");
    try {
      // A stand-in binary: exits 0 ONLY for `--help`, and says what it got.
      const bin = join(dir, "tool");
      await Deno.writeTextFile(
        bin,
        `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "Usage: tool"; exit 0; fi\n` +
          `echo "unknown flag: $1" >&2; exit 2\n`,
      );
      await Deno.chmod(bin, 0o755);

      assertEquals(
        await smokeRunArtifact(bin, undefined, ["--help"]),
        null,
        "a binary that answers --help is a runnable program",
      );
      const refused = await smokeRunArtifact(bin, undefined, ["--version"]);
      assert(refused !== null, "an exit 2 must be reported as a broken build");
      assertStringIncludes(refused, "BROKEN BUILD");
      assertStringIncludes(refused, "--version");
      assertStringIncludes(refused, "unknown flag: --version");
      // A cross-compiled artifact is not runnable HERE, and that is not a
      // defect — the same carve-out as every other target.
      assertEquals(
        await smokeRunArtifact(bin, "not-this-host-triple", ["--version"]),
        null,
      );
      // A file that is not a program at all is a broken build too.
      await Deno.writeTextFile(join(dir, "text"), "not a program\n");
      const dud = await smokeRunArtifact(join(dir, "text"), undefined, [
        "--help",
      ]);
      assert(dud !== null && dud.includes("BROKEN BUILD"), String(dud));
    } finally {
      await dropTempDir(dir);
    }
  },
});

// Structural: the builder must actually CALL the probe with `--help`. The
// rule is one call site, and a refactor that drops it fails nothing else —
// the compile still exits 0 and the artifact E2E only runs at release time.
Deno.test("cli target: the builder smoke-runs a local `cli` artifact with --help", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/build/build-cli.ts", import.meta.url),
  );
  assert(
    /smokeRunArtifact\(\s*cliTarget,\s*cfg\.targetTriple,\s*\[\s*"--help",?\s*\]/
      .test(src),
    "build-cli.ts no longer smoke-runs the compiled CLI with --help",
  );
  assert(
    /cliCompileArgs\(\{/.test(src) && !/"compile",\s*"-q"/.test(src),
    "build-cli.ts must assemble its argv through cliCompileArgs, not by hand",
  );
});
