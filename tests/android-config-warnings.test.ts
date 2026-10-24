// deno.json `android` / `build.android` keys no build reads are SAID, on every
// build. A misspelt key (`"Camera": true`) was ignored silently — the APK then
// shipped without the camera it was asked for — and an `android.applicationId`
// Android rejects waited for the one target that reads it. Warnings only: a
// desktop build that passed still passes.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { _androidConfigWarnings } from "../src/build/build-android.ts";
import { dropTempDir } from "../src/testing/temp-dir.ts";
import { makeApp, task } from "./e2e-app-harness.ts";

Deno.test("android config: a known, valid config says nothing", () => {
  assertEquals(
    _androidConfigWarnings({
      android: {
        applicationId: "com.example.app",
        camera: true,
        colorScheme: "dark",
      },
      build: {
        android: { strict: true, keystore: "k.jks", keyAlias: "a", aab: true },
      },
    }),
    [],
  );
  assertEquals(_androidConfigWarnings({}), []);
  // A password key has its own warning (`_androidRelease`), not this one.
  assertEquals(
    _androidConfigWarnings({ build: { android: { keyPassword: "x" } } }),
    [],
  );
});

Deno.test("android config: misspelt keys, a non-object and a bad applicationId are named", () => {
  const w = _androidConfigWarnings({
    android: { Camera: true, applicationId: "myapp" },
    build: { android: { keystor: "k.jks" } },
  });
  assertEquals(w.length, 3, w.join("\n"));
  assertStringIncludes(w[0]!, "android.Camera is not a key aio reads");
  assertStringIncludes(w[1]!, "build.android.keystor is not a key aio reads");
  assertStringIncludes(w[2]!, 'android.applicationId "myapp" is not a valid');
  assertStringIncludes(
    _androidConfigWarnings({ android: true }).join(),
    "deno.json android must be an object",
  );
});

Deno.test("build: a misspelt android key is warned on a NON-android build, which still builds", async () => {
  const dir = await makeApp("counter", "android-cfg-");
  try {
    const path = join(dir, "deno.json");
    const cfg = JSON.parse(await Deno.readTextFile(path));
    cfg.android = { Camera: true };
    await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2));
    const r = await task(dir, "build", "--targets=web");
    const all = r.out + r.err;
    assertEquals(r.code, 0, all);
    assert(all.includes("android.Camera is not a key aio reads"), all);
  } finally {
    await dropTempDir(dir);
  }
});
