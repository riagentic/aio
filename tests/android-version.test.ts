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

/** A resolved build version, the way the builder hands it to androidVersion. */
const bv = (version: string, base: string, build: number) => ({
  version,
  base,
  build,
});

Deno.test("androidVersion: the name is THE build version, the code is an ordered integer", () => {
  assertEquals(androidVersion(bv("1.0.0", "1.0", 0)), {
    code: 100_000_000,
    name: "1.0.0",
  });
  assertEquals(androidVersion(bv("0.1.7", "0.1", 7)), {
    code: 1_000_007,
    name: "0.1.7",
  });
  assertEquals(androidVersion(bv("2.3.4", "2.3", 4)).code, 203_000_004);
  // The NAME is the full string, dirty suffix included — the APK says what it
  // is; the CODE is the clean build's (Android accepts a same-code reinstall).
  const dirty = androidVersion(bv("1.2.345-dirty.9f3ac2b1", "1.2", 345));
  assertEquals(dirty.name, "1.2.345-dirty.9f3ac2b1");
  assertEquals(dirty.code, androidVersion(bv("1.2.345", "1.2", 345)).code);
});

Deno.test("androidVersion: build order IS install order", () => {
  const order: [string, string, number][] = [
    ["0.1.0", "0.1", 0],
    ["0.1.1", "0.1", 1],
    ["0.1.999999", "0.1", 999_999],
    ["0.2.0", "0.2", 0],
    ["1.0.0", "1.0", 0],
    ["1.0.345", "1.0", 345],
    ["1.1.0", "1.1", 0],
    ["2.0.0", "2.0", 0],
  ];
  const codes = order.map(([v, b, n]) => androidVersion(bv(v, b, n)).code);
  for (let i = 1; i < codes.length; i++) {
    assert(
      codes[i]! > codes[i - 1]!,
      `${order[i]![0]} (${codes[i]}) must outrank ${order[i - 1]![0]} (${
        codes[i - 1]
      }) — Android refuses an install whose versionCode is not greater`,
    );
  }
  // …and every one of them fits the int32 Android actually stores.
  for (const c of codes) assert(c > 0 && c < 2_147_483_647, String(c));
});

Deno.test("androidVersion: what cannot be encoded is REFUSED, never truncated", () => {
  // A silently wrapped code is an APK that installs over a NEWER one.
  assertThrows(
    () => androidVersion(bv("21.0.0", "21.0", 0)),
    Error,
    "versionCode",
  );
  assertThrows(
    () => androidVersion(bv("1.100.0", "1.100", 0)),
    Error,
    "versionCode",
  );
  assertThrows(
    () => androidVersion(bv("1.0.1000000", "1.0", 1_000_000)),
    Error,
    "versionCode",
  );
  // Every refusal names the budget, not just the problem.
  try {
    androidVersion(bv("21.0.0", "21.0", 0));
  } catch (e) {
    assert(/must/.test((e as Error).message), (e as Error).message);
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
