// A release APK is minified (R8, `isMinifyEnabled = true`), and the page calls
// the native store's `read`/`write`/`exists`/`where` through
// `addJavascriptInterface` — by name, from JavaScript, where R8 cannot see a
// caller. The generated project named no rules at all, so keeping them rested
// on AGP's implicit default file. The rule is now the project's own. The run —
// a signed release APK whose state survives a force-stop — was made on an
// emulator when this landed (the store's methods kept, by name, in
// mapping.txt); this file pins the project that produces it.
import { assert, assertStringIncludes } from "@std/assert";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const GRADLE = ANDROID_TEMPLATE["app/build.gradle.kts"] ?? "";

Deno.test("android release: R8 keeps every @JavascriptInterface method, by the project's own rules", () => {
  const release = GRADLE.match(/release\s*\{([\s\S]*?)\n {8}\}/)?.[1] ?? "";
  assertStringIncludes(release, "isMinifyEnabled = true");
  const files = release.match(/proguardFiles\(([\s\S]*?)\)\s*$/m)?.[1] ?? "";
  assertStringIncludes(files, 'getDefaultProguardFile("proguard-android.txt")');
  const own = [...files.matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]!);
  assert(own.length > 0, `release names no rules file of its own:\n${release}`);
  const rules = own.map((f) => ANDROID_TEMPLATE[`app/${f}`] ?? "").join("\n");
  for (const f of own) {
    assert(ANDROID_TEMPLATE[`app/${f}`], `app/${f} is not in the template`);
  }
  assert(
    /-keepclassmembers class \* \{\s*@android\.webkit\.JavascriptInterface <methods>;\s*\}/
      .test(rules),
    `no keep rule for @JavascriptInterface methods in ${own.join(", ")}`,
  );
  assertStringIncludes(rules, "-keepattributes RuntimeVisibleAnnotations");
  // The rule is what the store needs: its bridge methods are annotated.
  const kt = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;
  for (const m of ["read", "write", "exists", "where"]) {
    assert(
      new RegExp(`@JavascriptInterface\\s+fun ${m}\\(`).test(kt),
      `AioNativeStore.${m} is not @JavascriptInterface`,
    );
  }
});
