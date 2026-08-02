// Cross-platform build targets: one machine, one command, every OS.
//
// The risky part of a cross build is that it SUCCEEDS while producing the
// wrong thing — a host binary wearing a foreign platform's name is only
// discovered by the user who downloads it. So the platform table, the naming
// rule, the refusals, and the `deno compile` argv are all pure and asserted
// here; `tests/build-e2e.test.ts` then proves a real cross-compiled artifact
// is genuinely the other platform's format.
import { assert, assertEquals } from "@std/assert";
import {
  artifactName,
  CROSS_COMPILABLE,
  crossCompileBlocker,
  hostPlatform,
  isHostPlatform,
  PLATFORMS,
  resolvePlatforms,
} from "../src/build/platforms.ts";
import { compileArgs } from "../src/build/build-compile.ts";

Deno.test("platforms: every entry is a real deno compile triple shape", () => {
  for (const [name, spec] of Object.entries(PLATFORMS)) {
    assert(
      /^(x86_64|aarch64)-(unknown-linux-gnu|pc-windows-msvc|apple-darwin)$/
        .test(spec.triple),
      `${name}: ${spec.triple} is not a target triple deno accepts`,
    );
    assertEquals(
      spec.exeExt,
      spec.os === "windows" ? ".exe" : "",
      `${name}: only Windows artifacts carry an extension`,
    );
    assert(spec.triple.startsWith(spec.arch), `${name}: arch/triple disagree`);
  }
});

Deno.test("platforms: host detection covers each OS/arch aio ships to", () => {
  assertEquals(hostPlatform({ os: "linux", arch: "x86_64" }), "linux");
  assertEquals(hostPlatform({ os: "linux", arch: "aarch64" }), "linux-arm64");
  assertEquals(hostPlatform({ os: "windows", arch: "x86_64" }), "windows");
  assertEquals(hostPlatform({ os: "darwin", arch: "x86_64" }), "macos");
  assertEquals(hostPlatform({ os: "darwin", arch: "aarch64" }), "macos-arm64");
  // …and the real host is always one of the table's keys.
  assert(hostPlatform() in PLATFORMS);
  assert(isHostPlatform(hostPlatform()));
});

Deno.test("platforms: resolve accepts host, dedupes, and NAMES the unknown", () => {
  const ok = resolvePlatforms(["host", "windows", "windows", " macos "]);
  assert(ok.ok);
  assertEquals(
    ok.platforms[0],
    hostPlatform(),
    "host resolves to this machine",
  );
  assertEquals(
    ok.platforms.filter((p) => p === "windows").length,
    1,
    "duplicates collapse",
  );
  assert(ok.platforms.includes("macos"), "surrounding space is tolerated");

  const bad = resolvePlatforms(["linux", "win32", "osx"]);
  assert(!bad.ok);
  assert(
    bad.error.includes("win32") && bad.error.includes("osx"),
    `every unknown name must be listed, not silently dropped: ${bad.error}`,
  );
  assert(bad.error.includes("macos-arm64"), "and the valid ones shown");
});

Deno.test("platforms: the host keeps the bare name, cross builds are labelled", () => {
  const host = hostPlatform();
  assertEquals(
    artifactName("myapp", host),
    `myapp${PLATFORMS[host]!.exeExt}`,
    "an existing host-only build must not suddenly rename its output",
  );
  // A foreign platform is always distinguishable, and Windows gets .exe.
  const foreign = host === "windows" ? "linux" : "windows";
  const name = artifactName("myapp", foreign);
  assert(name.includes(foreign), `${name} must carry its platform`);
  assertEquals(name.endsWith(".exe"), foreign === "windows");

  // No two platforms can ever produce the same file name.
  const names = Object.keys(PLATFORMS).map((p) => artifactName("myapp", p));
  assertEquals(new Set(names).size, names.length, "artifact names are unique");
});

Deno.test("platforms: only deno-compile targets may cross-compile", () => {
  for (const t of CROSS_COMPILABLE) {
    assertEquals(crossCompileBlocker(t), null, `${t} compiles with deno`);
  }
  // Electron and Android package with per-OS tooling — refused WITH a reason,
  // never quietly emitted as a host artifact under a foreign name.
  for (
    const t of ["electron", "electron-client", "android", "android-client"]
  ) {
    const why = crossCompileBlocker(t);
    assert(why, `${t} must be refused for a foreign platform`);
    assert(why!.length > 30, `${t}: the refusal must explain itself: ${why}`);
  }
  assert(crossCompileBlocker("nonsense"), "an unknown target is refused too");
});

Deno.test("compileArgs: --target is passed only for a cross build", () => {
  const base = {
    hasDist: false,
    workerInclude: [],
    assets: [],
    excludes: [],
    out: "app",
    entry: "src/app.ts",
  };
  // Host build: no --target at all, so deno needs no extra runtime download
  // and behaves exactly as it did before this feature existed.
  assertEquals(compileArgs(base).includes("--target"), false);

  const cross = compileArgs({ ...base, target: "x86_64-pc-windows-msvc" });
  const i = cross.indexOf("--target");
  assert(i > 0, "cross build passes --target");
  assertEquals(cross[i + 1], "x86_64-pc-windows-msvc");
  // It must precede the entry, and not disturb the rest of the argv.
  assert(i < cross.indexOf("src/app.ts"));
  assertEquals(cross[cross.length - 1], "src/app.ts");
  assertEquals(cross[0], "compile");
});

Deno.test("compileArgs: every platform's triple survives into the argv", () => {
  for (const [name, spec] of Object.entries(PLATFORMS)) {
    const args = compileArgs({
      hasDist: true,
      workerInclude: ["--include", "w.js"],
      assets: ["--include", "m.wasm"],
      excludes: ["node_modules/x"],
      out: artifactName("app", name),
      entry: "src/app.ts",
      target: spec.triple,
    });
    assertEquals(args[args.indexOf("--target") + 1], spec.triple);
    // The embedded runtime dependencies are not lost by the new flag.
    assert(args.includes("dist/"), `${name}: dist/ still embedded`);
    assert(args.includes("w.js"), `${name}: sqlite worker still embedded`);
    assert(args.includes("m.wasm"), `${name}: data assets still embedded`);
    assertEquals(args[args.indexOf("-o") + 1], artifactName("app", name));
  }
});

// A cross artifact that the collector does not RECOGNISE is worse than a build
// failure: `deno compile` succeeds, the binary is real, and it is left behind
// in the project root while the build reports ✓. That is exactly what happened
// to `myapp-macos-arm64` — extension-less names only matched the bare binary.
Deno.test("build-all: cross-compiled artifact names are recognised", async () => {
  const { isArtifactName } = await import("../src/build-all.ts");

  for (const platform of Object.keys(PLATFORMS)) {
    for (const base of ["myapp", "myapp-client"]) {
      const name = artifactName(base, platform);
      assert(
        isArtifactName(name, "myapp"),
        `${name} must be collected into dist/, not stranded in the project root`,
      );
    }
  }

  // Still true for everything that was already recognised…
  assert(isArtifactName("myapp", "myapp"));
  assert(isArtifactName("myapp-client", "myapp"));
  assert(isArtifactName("myapp.service", "myapp"));
  assert(isArtifactName("myapp-client.apk", "myapp"));
  assert(isArtifactName("aio-client-x86_64.AppImage", "myapp"));
  // …and nothing unrelated is swept up.
  assertEquals(isArtifactName("deno.json", "myapp"), false);
  assertEquals(isArtifactName("src", "myapp"), false);
  assertEquals(isArtifactName("README.md", "myapp"), false);
  assertEquals(isArtifactName("otherapp", "myapp"), false);
});
