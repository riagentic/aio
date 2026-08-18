// Electron packages for Windows and macOS, built anywhere.
//
// The build used to refuse them outright: "Electron targets bundle a per-OS
// runtime — build them on that OS". That conflated two different things. The
// runtime is a DOWNLOAD (Electron publishes every platform's build as a zip),
// and the package for Windows/macOS is a directory + a launcher + a zip — no
// OS-specific tooling anywhere. What genuinely needs the target OS is SIGNING,
// and the zip we ship is unsigned either way.
//
// One case IS real, and it is narrower than the old rule: a Linux package is an
// AppImage, and `appimagetool` is a native binary for the arch it assembles. So
// linux needs a linux host OF THAT ARCH — found by building it, when
// linux-arm64 on x86_64 arrived as "build exited 1" instead of a reason.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { crossCompileBlocker, PLATFORMS } from "../src/build/platforms.ts";
import {
  electronAssetSlug,
  electronZipUrl,
} from "../src/build/electron-runtime.ts";

Deno.test("electron-cross: every aio platform maps to an Electron release asset", () => {
  // Electron names platforms its own way; a wrong slug is a 404 at build time
  // for a platform nobody tests locally, so the whole table is pinned.
  assertEquals(electronAssetSlug("windows"), "win32-x64");
  assertEquals(electronAssetSlug("macos"), "darwin-x64");
  assertEquals(electronAssetSlug("macos-arm64"), "darwin-arm64");
  assertEquals(electronAssetSlug("linux"), "linux-x64");
  assertEquals(electronAssetSlug("linux-arm64"), "linux-arm64");
  assertEquals(electronAssetSlug("nonsense"), null);
  // …and no platform may be added without one.
  for (const name of Object.keys(PLATFORMS)) {
    assert(
      electronAssetSlug(name) !== null,
      `platform "${name}" has no Electron asset slug — a cross-build for it ` +
        `would 404`,
    );
  }
});

Deno.test("electron-cross: the download URL is Electron's own", () => {
  assertEquals(
    electronZipUrl("28.3.3", "windows"),
    "https://github.com/electron/electron/releases/download/v28.3.3/electron-v28.3.3-win32-x64.zip",
  );
  // A version already carrying its `v` must not become `vv28`.
  assertEquals(
    electronZipUrl("v28.3.3", "macos-arm64"),
    "https://github.com/electron/electron/releases/download/v28.3.3/electron-v28.3.3-darwin-arm64.zip",
  );
  assertEquals(electronZipUrl("28.3.3", "nonsense"), null);
});

Deno.test("electron-cross: Windows and macOS build from ANY host", () => {
  for (const host of ["linux", "macos-arm64", "windows"]) {
    for (const target of ["windows", "macos", "macos-arm64"]) {
      assertEquals(
        crossCompileBlocker("electron", target, host),
        null,
        `electron → ${target} from ${host} must be allowed`,
      );
    }
  }
});

Deno.test("electron-cross: a Linux AppImage needs a Linux host of that ARCH", () => {
  // The host build is always fine.
  assertEquals(crossCompileBlocker("electron", "linux", "linux"), null);
  assertEquals(
    crossCompileBlocker("electron", "linux-arm64", "linux-arm64"),
    null,
  );

  // Cross-arch on Linux: appimagetool cannot execute.
  const crossArch = crossCompileBlocker("electron", "linux-arm64", "linux");
  assert(crossArch, "linux-arm64 from x86_64 linux must be refused");
  assertStringIncludes(crossArch, "appimagetool");
  assertStringIncludes(crossArch, "aarch64");

  // From a non-Linux host at all.
  const fromMac = crossCompileBlocker("electron", "linux", "macos-arm64");
  assert(fromMac, "a Linux AppImage from macOS must be refused");
  assertStringIncludes(fromMac, "AppImage");
  // …and the refusal says what DOES work from there, so the reader's next
  // step is in the message rather than in a doc they have to find.
  assertStringIncludes(fromMac, "Windows and macOS packages cross-build");
});

Deno.test("electron-cross: android is still built once, and binaries still cross", () => {
  const apk = crossCompileBlocker("android", "windows", "linux");
  assert(apk, "android must not fan out per platform");
  assertStringIncludes(apk, "once");
  for (const t of ["browser", "cli", "server", "cli-client"]) {
    assertEquals(crossCompileBlocker(t, "windows", "linux"), null);
  }
});

Deno.test("electron-cross: the build config describes the TARGET, not the host", async () => {
  // The bug this pins produced a LINUX AppImage for `--platform=windows` and
  // called it the windows artifact in the summary: `os`/`arch` were read from
  // `Deno.build`, which is the machine, while everything else had already moved
  // to the requested platform. A wrong artifact under the right name is the
  // worst shape a build can have — it ships.
  const src = await Deno.readTextFile(
    new URL("../src/build/build-config.ts", import.meta.url),
  );
  const body = src.replace(/^\s*(\/\/|\*).*$/gm, ""); // comments may discuss it
  assert(
    /const os = spec\.os/.test(body),
    "build-config must take `os` from the platform spec",
  );
  assert(
    !/const os = Deno\.build\.os/.test(body),
    "`os` must not come from the host — that is what shipped an AppImage as " +
      "the windows artifact",
  );
});
