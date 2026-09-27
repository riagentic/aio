// A macOS `.app` updates itself: the signed bundle ships as `<bin>-mac-<arch>
// .app.tar.gz` (target `electron-app`), the install unit is the enclosing
// `X.app`, and a translocated or unwritable copy refuses with the one move that
// fixes it. The swap/seal/relaunch path is driven end to end in
// updates-e2e.test.ts; this file pins the pure decisions it rests on — all of
// them path- or byte-shaped, so they hold on any host. (Measured on macOS 14:
// a real translocated launch runs from `/private/var/folders/…/AppTranslocation
// /<uuid>/d/X.app`, and the codesign seal does not cover the folder NAME, so a
// bundle verified as `X.app.staged-2` stays valid once renamed to `X.app`.)
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  installableTargets,
  installDir,
  macAppDir,
  macAppUpdateBlocker,
  macBundleExecutable,
} from "../src/server/updates-apply.ts";
import {
  artifactFormat,
  inferTarget,
  isReleaseTarget,
  isUpdateTarget,
  UPDATE_TARGETS,
} from "../src/build/ship.ts";
import { stageToDmgLines, updateTarballLine } from "../src/build/dmg.ts";
import { fileFormat } from "../src/am/am-cmd-publish.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const EXE = "/Applications/My App.app/Contents/MacOS/My App";

Deno.test("installDir: a bundle executable walks up to the enclosing .app", () => {
  assertEquals(macAppDir(EXE), "/Applications/My App.app");
  assertEquals(installDir(EXE), "/Applications/My App.app");
  // Deeper or shallower paths are not a bundle executable.
  assertEquals(macAppDir("/Applications/X.app/Contents/Resources/x"), null);
  assertEquals(macAppDir("/Applications/X.app/Contents/MacOS/a/b"), null);
  assertEquals(macAppDir("/usr/local/bin/x"), null);
});

Deno.test("a .app installs electron-app releases, and only those", () => {
  assertEquals(installableTargets("macos-app"), ["electron-app"]);
  assert(installableTargets("source").includes("electron-app"));
  for (const t of ["binary", "appimage", "electron-zip"] as const) {
    assert(!installableTargets(t).includes("electron-app"), t);
  }
  // Additive: a new RELEASE target; the frozen public tuple and
  // `UpdateTarget` are exactly what they were.
  assert(isReleaseTarget("electron-app"));
  assert(!isUpdateTarget("electron-app"));
  assert(!(UPDATE_TARGETS as readonly string[]).includes("electron-app"));
});

Deno.test("translocation guard: a translocated copy refuses and names /Applications", () => {
  const t = "/private/var/folders/ts/T/AppTranslocation/2FF9/d/My App.app";
  const msg = macAppUpdateBlocker(t, () => true);
  assert(msg !== null, "a translocated copy must refuse");
  assertStringIncludes(msg, "App Translocation");
  assertStringIncludes(msg, "Move My App.app to /Applications");
});

Deno.test("translocation guard: an unwritable folder refuses; a writable one passes", () => {
  const app = "/Users/u/Desktop/X.app";
  const seen: string[] = [];
  const msg = macAppUpdateBlocker(app, (d) => (seen.push(d), false));
  assertEquals(seen, ["/Users/u/Desktop"]);
  assert(msg !== null);
  assertStringIncludes(msg, "/Users/u/Desktop) is not writable");
  assertStringIncludes(msg, "Move X.app to /Applications");
  assertEquals(macAppUpdateBlocker(app, () => true), null);
});

// Already in /Applications: "move it to /Applications" is no advice.
Deno.test("translocation guard: an unwritable /Applications says whose folder it is", () => {
  const msg = macAppUpdateBlocker("/Applications/X.app", () => false);
  assert(msg !== null);
  assertStringIncludes(msg, "(/Applications) is not writable by this user");
  assertStringIncludes(msg, "administrator account");
  assert(!msg.includes("Move X.app to /Applications"), msg);
});

Deno.test("translocation guard: the default probe really writes (and cleans up)", async () => {
  const dir = await tempDir("aio-mac-w-");
  try {
    assertEquals(macAppUpdateBlocker(join(dir, "X.app")), null);
    assertEquals([...Deno.readDirSync(dir)], [], "the probe file is removed");
    assert(macAppUpdateBlocker(join(dir, "missing", "X.app")) !== null);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("macBundleExecutable reads CFBundleExecutable, null without a plist", async () => {
  const dir = await tempDir("aio-mac-plist-");
  try {
    const app = join(dir, "X.app");
    assertEquals(macBundleExecutable(app), null);
    await Deno.mkdir(join(app, "Contents"), { recursive: true });
    await Deno.writeTextFile(
      join(app, "Contents", "Info.plist"),
      "<dict><key>CFBundleExecutable</key>\n  <string>my app</string></dict>",
    );
    assertEquals(
      macBundleExecutable(app),
      join(app, "Contents", "MacOS", "my app"),
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("inferTarget: a .app.tar.gz is electron-app, a .dmg is still refused", () => {
  assertEquals(inferTarget("x-1.0.0-mac-arm64.app.tar.gz", {}), "electron-app");
  assertEquals(
    inferTarget("X-1.0.0-MAC-X64.APP.TAR.GZ", { targets: ["electron"] }),
    "electron-app",
  );
  let err = "";
  try {
    inferTarget("x-1.0.0-mac-x64.dmg", { targets: ["electron"] });
  } catch (e) {
    err = String(e);
  }
  assertStringIncludes(err, ".app.tar.gz");
});

Deno.test("artifactFormat: a gzip stream is a program format", () => {
  assertEquals(artifactFormat(new Uint8Array([0x1f, 0x8b, 8, 0])), "gzip");
  assertEquals(artifactFormat(new Uint8Array([0x1f, 0x00])), null);
});

Deno.test("am publish fileFormat: a .dmg is found by its koly trailer, not its name", async () => {
  const dir = await tempDir("aio-dmg-fmt-");
  try {
    const dmg = new Uint8Array(4096);
    dmg.set([0x6b, 0x6f, 0x6c, 0x79], dmg.length - 512); // "koly"
    await Deno.writeFile(join(dir, "a.bin"), dmg);
    assertEquals(fileFormat(join(dir, "a.bin")), "DMG");
    // Named .dmg, no trailer: not a disk image.
    await Deno.writeFile(join(dir, "b.dmg"), new Uint8Array(4096));
    assertEquals(fileFormat(join(dir, "b.dmg")), null);
    // Tiny files are read whole; an unreadable one says so.
    await Deno.writeFile(
      join(dir, "c"),
      new Uint8Array([0x7f, 0x45, 0x4c, 0x46]),
    );
    assertEquals(fileFormat(join(dir, "c")), "ELF");
    assertEquals(fileFormat(join(dir, "missing")), "unreadable");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("dmg: the update tarball is packed right after signing, only when signed", () => {
  const base = {
    stage: "/w/stage",
    app: "/w/stage/My App.app",
    binaryName: "myapp",
    volumeName: "My App",
    outPath: "/w/out.dmg",
    updateOut: "/w/app.tar.gz",
  };
  const signed = stageToDmgLines({ ...base, sign: true });
  const tar = updateTarballLine(base.stage, base.app, base.updateOut);
  assertEquals(
    tar,
    "COPYFILE_DISABLE=1 tar --no-mac-metadata -czf '/w/app.tar.gz' " +
      "-C '/w/stage' 'My App.app'",
  );
  // After the seal (line 0), before the /Applications link joins the stage.
  assertEquals(signed.indexOf(tar), 1);
  assert(signed[2]!.startsWith("ln -s /Applications"));
  // Unsigned: no update artifact — an unsealed bundle has nothing to verify.
  assert(!stageToDmgLines({ ...base, sign: false }).includes(tar));
});
