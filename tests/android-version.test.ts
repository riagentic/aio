/**
 * An APK carries the app's version — or no update to it is ever accepted.
 *
 * `android-template/app/build.gradle.kts` hardcoded `versionCode = 1` /
 * `versionName = "1.0"`, and nothing propagated deno.json's `version`. So every
 * APK aio has ever built is version 1.0 forever: Play refuses the upload, an
 * MDM refuses the push, and `adb install -r` refuses with
 * INSTALL_FAILED_VERSION_DOWNGRADE. `versionCode` is an INTEGER and it is the
 * only value any of them compares.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { androidVersion } from "../src/build/build-android.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

Deno.test("androidVersion: the name is the semver, the code is an ordered integer", () => {
  assertEquals(androidVersion("1.0.0"), { code: 100_000_999, name: "1.0.0" });
  assertEquals(androidVersion("0.1.0"), { code: 1_000_999, name: "0.1.0" });
  assertEquals(androidVersion("v2.3.4").code, 203_004_999);
  assertEquals(androidVersion("v2.3.4").name, "v2.3.4");
  // Build metadata is not part of ordering and must not break parsing.
  assertEquals(androidVersion("1.2.3+build.7").code, 102_003_999);
});

Deno.test("androidVersion: SEMVER ORDER is preserved, prereleases included", () => {
  const order = [
    "0.1.0",
    "0.1.1",
    "0.2.0",
    "1.0.0-alpha1",
    "1.0.0-alpha65",
    "1.0.0-beta2", // alpha < beta < rc < the release itself
    "1.0.0-rc1",
    "1.0.0-nightly1", // an unrecognised tier sorts last among prereleases
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ];
  const codes = order.map((v) => androidVersion(v).code);
  for (let i = 1; i < codes.length; i++) {
    assert(
      codes[i]! > codes[i - 1]!,
      `${order[i]} (${codes[i]}) must outrank ${order[i - 1]} (${
        codes[i - 1]
      }) — Android refuses an install whose versionCode is not greater`,
    );
  }
  // …and every one of them fits the int32 Android actually stores.
  for (const c of codes) assert(c > 0 && c < 2_147_483_647, String(c));
});

Deno.test("androidVersion: a release always outranks its own prereleases", () => {
  assert(
    androidVersion("1.0.0").code > androidVersion("1.0.0-rc249").code,
    "1.0.0 must be installable over 1.0.0-rc249",
  );
});

Deno.test("androidVersion: what cannot be encoded is REFUSED, never truncated", () => {
  // A silently wrapped code is an APK that installs over a NEWER one.
  assertThrows(() => androidVersion(undefined), Error, 'no "version"');
  assertThrows(() => androidVersion(""), Error, 'no "version"');
  assertThrows(() => androidVersion("nightly"), Error, "not a semver");
  assertThrows(() => androidVersion("1.2"), Error, "not a semver");
  assertThrows(() => androidVersion("21.0.0"), Error, "versionCode");
  assertThrows(() => androidVersion("1.100.0"), Error, "versionCode");
  assertThrows(() => androidVersion("1.0.1000"), Error, "versionCode");
  assertThrows(() => androidVersion("1.0.0-alpha250"), Error, "249");
  assertThrows(() => androidVersion("1.0.0-nightly249"), Error, "248");
  // Every refusal names the fix, not just the problem.
  for (const bad of ["nightly", "21.0.0"]) {
    try {
      androidVersion(bad);
    } catch (e) {
      const m = (e as Error).message;
      assert(/1\.2\.3|patch|Bump|must/.test(m), m);
    }
  }
});

Deno.test("android template: the gradle file asks for a version instead of hardcoding one", () => {
  const gradle = ANDROID_TEMPLATE["app/build.gradle.kts"]!;
  assert(
    gradle.includes("versionCode = {{VERSION_CODE}}"),
    "versionCode must be substituted, not fixed at 1",
  );
  assert(
    gradle.includes('versionName = "{{VERSION_NAME}}"'),
    "versionName must be substituted, not fixed at 1.0",
  );
  assert(!/versionCode = 1\b/.test(gradle), "the hardcoded 1 is gone");
});

Deno.test("android template: the generated constant matches the source directory", async () => {
  // The .ts file is generated from android-template/; a hand-edit to one of
  // them is a divergence that only shows up in a built APK.
  const dir = join(import.meta.dirname ?? ".", "..", "android-template");
  for (const [rel, content] of Object.entries(ANDROID_TEMPLATE)) {
    assertEquals(
      await Deno.readTextFile(join(dir, ...rel.split("/"))),
      content,
      `${rel} — regenerate: deno run -A scripts/gen-android-template.ts`,
    );
  }
});

Deno.test("build-android substitutes both version placeholders", async () => {
  const src = await Deno.readTextFile(
    join(import.meta.dirname ?? ".", "..", "src/build/build-android.ts"),
  );
  // A placeholder the template declares and the build never fills reaches
  // Gradle literally and fails with a Kotlin syntax error mid-build.
  for (const ph of ["{{VERSION_CODE}}", "{{VERSION_NAME}}"]) {
    assert(src.includes(ph), `build-android.ts never substitutes ${ph}`);
  }
  // Every placeholder in the template must have a substitution site.
  const declared = new Set(
    Object.values(ANDROID_TEMPLATE).flatMap((c) =>
      [...c.matchAll(/\{\{[A-Z_]+\}\}/g)].map((m) => m[0])
    ),
  );
  for (const ph of declared) {
    assert(
      src.includes(ph),
      `${ph} is in the Android template and nothing in build-android.ts ` +
        `replaces it — it would reach Gradle verbatim`,
    );
  }
});
