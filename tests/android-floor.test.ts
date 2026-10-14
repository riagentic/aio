// The ONE Android level aio supports: Android 10 (API 29) — the owner's
// decision of 2026-10-12 (it was Android 7, API 24, unargued since the first
// template). It is a number three places state; a floor that moves in one of
// them is an app that installs where the docs say it does not, or the reverse.
import { assert, assertEquals } from "@std/assert";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const REPO = new URL("..", import.meta.url);

Deno.test("android: the floor is Android 10 (minSdk 29) in the template, its generated copy and the docs", async () => {
  const floor = (gradle: string) =>
    Number(/^\s*minSdk\s*=\s*(\d+)/m.exec(gradle)?.[1]);
  const onDisk = await Deno.readTextFile(
    new URL("android-template/app/build.gradle.kts", REPO),
  );
  assertEquals(floor(onDisk), 29, "android-template/app/build.gradle.kts");
  assertEquals(
    floor(ANDROID_TEMPLATE["app/build.gradle.kts"]!),
    29,
    "src/build/android-template.ts — regenerate it: " +
      "deno run -A scripts/gen-android-template.ts",
  );
  const docs = await Deno.readTextFile(
    new URL("docs/build/targets.md", REPO),
  );
  assert(
    docs.includes("**Android 10** or newer (`minSdk` 29)"),
    "docs/build/targets.md names the floor",
  );
  assert(!/minSdk`? 24/.test(docs), "docs/build/targets.md still says 24");
});
