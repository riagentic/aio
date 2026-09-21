// The CAMERA permission is OPT-IN, and the APK and the WebView say the same
// thing about it.
//
// Every aio APK used to declare `android.permission.CAMERA` plus a
// `uses-feature camera.any`, with a comment about QR scanning. So every aio
// app — a todo list, a dashboard, a notes app — told its user on the install
// screen and on its Play listing that it could use the camera, and Play flags
// exactly that. The permission is now declared only when the app asks for it
// in deno.json:
//
//   { "android": { "camera": true } }
//
// Removing it without an opt-in would have broken the apps that DO scan a
// code in the worst available way: `getUserMedia` denied by the OS, the page
// catching a bare `NotAllowedError`, and nothing anywhere naming the missing
// permission. So the SAME flag reaches MainActivity.kt (`CAMERA_DECLARED`),
// which logs the exact key to add — the "two deciders for one fact" trap, shut
// by construction and pinned below.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  _cameraPermission,
  _fillTemplate,
} from "../src/build/build-android.ts";
import { _androidCamera } from "../src/build/build-config.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import { resolveSdk } from "../src/build/build-helpers.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MANIFEST = ANDROID_TEMPLATE["app/src/main/AndroidManifest.xml"]!;
const ACTIVITY = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;

/** The manifest a build with this `android.camera` actually writes. */
function manifestFor(camera: boolean | undefined): string {
  return _fillTemplate(MANIFEST, {
    "{{APPLICATION_ID}}": "com.example.probe",
    "{{VERSION_CODE}}": "1",
    "{{VERSION_NAME}}": "0.1.1",
    "{{APP_NAME}}": "Probe",
    "{{ICON_ATTR}}": 'android:icon="@mipmap/ic_launcher"',
    "{{CLEARTEXT_ATTR}}": "",
    "{{CAMERA_PERMISSION}}": _cameraPermission(camera),
  });
}

/** The same three well-formedness faults `tests/generated-xml-is-well-formed`
 *  checks, applied to the FILLED document rather than the template — the
 *  camera block is injected by build-android.ts and never appears in the
 *  template the other gate reads. */
function xmlFaults(src: string): string[] {
  const faults: string[] = [];
  for (const m of src.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (m[1]!.includes("--")) faults.push(`"--" inside a comment: ${m[1]!}`);
  }
  const opens = (src.match(/<!--/g) ?? []).length;
  const closes = (src.match(/-->/g) ?? []).length;
  if (opens !== closes) faults.push(`${opens} "<!--" vs ${closes} "-->"`);
  const bare = src.replace(/<!--[\s\S]*?-->/g, "").matchAll(
    /&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g,
  );
  for (const _ of bare) faults.push("a bare & that is not an entity");
  return faults;
}

Deno.test("android manifest: no camera permission unless the app asks for one", () => {
  for (const camera of [undefined, false] as const) {
    const xml = manifestFor(camera);
    assert(
      !xml.includes("android.permission.CAMERA"),
      `android.camera=${camera} still declares CAMERA — every aio app would ` +
        `ask its user for the camera again`,
    );
    assert(
      !xml.includes("android.hardware.camera"),
      `android.camera=${camera} still declares the camera uses-feature`,
    );
    // The app is still an app: INTERNET stays, and the document parses.
    assertStringIncludes(xml, "android.permission.INTERNET");
    assertEquals(xmlFaults(xml), [], "the filled manifest is not well-formed");
  }
});

Deno.test("android manifest: `android: { camera: true }` declares it, optional hardware", () => {
  const xml = manifestFor(true);
  assertStringIncludes(
    xml,
    '<uses-permission android:name="android.permission.CAMERA" />',
  );
  // BOTH features `required="false"` — requesting CAMERA implies a REQUIRED
  // `android.hardware.camera` unless it is declared, and `camera.any` alone
  // does not suppress it (measured with aapt2, see below). An app that scans a
  // code still installs on a device with no camera and explains itself there.
  for (
    const name of ["android.hardware.camera", "android.hardware.camera.any"]
  ) {
    assertStringIncludes(
      xml,
      `<uses-feature android:name="${name}" android:required="false" />`,
    );
  }
  assertEquals(xmlFaults(xml), [], "the filled manifest is not well-formed");
});

Deno.test("android camera: the manifest and the WebView are ONE decider", () => {
  // Both surfaces are filled from the same `cfg.androidCamera`. The failure
  // this shuts: a manifest that declares CAMERA while the WebView refuses
  // every request as undeclared (or the reverse — the WebView asking for a
  // runtime permission the manifest never declared, which Android denies
  // without ever showing a dialog).
  for (const camera of [true, false] as const) {
    const declares = manifestFor(camera).includes("android.permission.CAMERA");
    const kotlin = _fillTemplate(ACTIVITY, {
      "{{TALKS_TO_SERVER}}": "false",
      "{{IS_CLIENT}}": "false",
      "{{CAMERA_DECLARED}}": String(camera),
    });
    assertStringIncludes(kotlin, `CAMERA_DECLARED = ${camera}`);
    assertEquals(
      declares,
      camera,
      `android.camera=${camera}: the manifest disagrees with CAMERA_DECLARED`,
    );
    assert(
      !/\{\{[A-Z_]+\}\}/.test(kotlin),
      "a placeholder reached Kotlin verbatim — it would not compile",
    );
  }
});

Deno.test("android camera: an undeclared request is LOUD, and names the key", () => {
  // A silent deny is the whole reason this is opt-in rather than deleted.
  assertStringIncludes(ACTIVITY, "if (!CAMERA_DECLARED)");
  assertStringIncludes(ACTIVITY, "android.util.Log.e");
  // The exact key, spelled as it goes into deno.json — a message that says
  // "permission missing" without naming it is a search, not an answer.
  assertStringIncludes(
    ACTIVITY,
    String.raw`\"android\": { \"camera\": true }`,
  );
  // …and the request is refused rather than half-granted.
  const at = ACTIVITY.indexOf("if (!CAMERA_DECLARED)");
  assertStringIncludes(ACTIVITY.slice(at, at + 900), "request.deny()");
});

Deno.test("android camera: a non-boolean in deno.json is refused, never coerced", () => {
  assertEquals(_androidCamera(undefined), false, "absent = off");
  assertEquals(_androidCamera(true), true);
  assertEquals(_androidCamera(false), false);
  // `"false"` is truthy and `"yes"` is not a boolean: coercing either ships an
  // APK that disagrees with its own deno.json, in silence.
  for (const bad of ["true", "false", "yes", 1, 0, null, {}, []]) {
    assertEquals(
      _androidCamera(bad),
      null,
      `android.camera: ${JSON.stringify(bad)} must be refused by name`,
    );
  }
});

/** What ANDROID itself reads out of a linked APK — aapt2, not a regex over the
 *  manifest we just wrote. Null when this host has no SDK. */
async function linkedApk(
  camera: boolean,
  dir: string,
): Promise<{ permissions: string[]; features: string[] } | null> {
  const sdk = resolveSdk();
  if (!sdk) return null;
  const tools = [...Deno.readDirSync(join(sdk, "build-tools"))].map((e) =>
    e.name
  ).sort().pop();
  const jars = [...Deno.readDirSync(join(sdk, "platforms"))].map((e) => e.name)
    .sort().pop();
  if (!tools || !jars) return null;
  const aapt2 = join(sdk, "build-tools", tools, "aapt2");
  const xml = manifestFor(camera)
    // The AppCompat theme and the launcher mipmap live in resources this
    // standalone link does not have; permissions are what is under test.
    .replace(
      "@style/Theme.AppCompat.NoActionBar",
      "@android:style/Theme.Material",
    )
    .replace('android:icon="@mipmap/ic_launcher"', "")
    .replace("<manifest ", '<manifest package="app.aio.camprobe" ');
  const mf = join(dir, `m-${camera}.xml`);
  const apk = join(dir, `o-${camera}.apk`);
  await Deno.writeTextFile(mf, xml);
  const link = await new Deno.Command(aapt2, {
    args: [
      "link",
      "-o",
      apk,
      "--manifest",
      mf,
      "-I",
      join(sdk, "platforms", jars, "android.jar"),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(
    link.success,
    `aapt2 refused the manifest (camera=${camera}): ${
      new TextDecoder().decode(link.stderr).trim()
    }`,
  );
  const lines = async (what: string) => {
    const d = await new Deno.Command(aapt2, {
      args: ["dump", what, apk],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(d.stdout).split("\n").map((l) => l.trim());
  };
  return {
    permissions: (await lines("permissions")).filter((l) =>
      l.startsWith("uses-permission:")
    ),
    features: (await lines("badging")).filter((l) =>
      l.includes("feature") && l.includes("camera")
    ),
  };
}

Deno.test("android camera: aapt2 reads the permission out of the linked APK (where an SDK exists)", async () => {
  // The instrument, not the intention: a string check over a manifest we just
  // wrote proves only that we wrote it. This is what Android reads back.
  if (!resolveSdk()) return; // no SDK on this host — the pure checks gate
  const dir = await tempDir("aio-android-camera-");
  try {
    const off = await linkedApk(false, dir);
    const on = await linkedApk(true, dir);
    assert(off && on, "SDK present but no build-tools/platforms");
    assert(
      off.permissions.some((p) => p.includes("android.permission.INTERNET")),
      `a default APK lost INTERNET: ${off.permissions.join(" | ")}`,
    );
    assertEquals(
      off.permissions.filter((p) => p.includes("CAMERA")),
      [],
      "a default APK still asks the user for the camera",
    );
    assertEquals(off.features, [], "a default APK still declares a camera");
    // MEASURED, not assumed: requesting CAMERA makes Android IMPLY a REQUIRED
    // `android.hardware.camera`, and declaring only `camera.any` does not
    // suppress it — the template's one-line form promised in a comment that
    // "install stays possible on camera-less devices" while aapt2 said
    // `uses-implied-feature … reason='requested android.permission.CAMERA
    // permission'`. Both features are declared not-required now.
    assertEquals(
      on.features.filter((f) => f.startsWith("uses-implied-feature")),
      [],
      `android.camera=true implies a REQUIRED camera feature — the APK would ` +
        `not install on a device without one: ${on.features.join(" | ")}`,
    );
    for (
      const name of ["android.hardware.camera", "android.hardware.camera.any"]
    ) {
      assert(
        on.features.some((f) =>
          f.startsWith("uses-feature-not-required") && f.includes(`'${name}'`)
        ),
        `${name} is not declared optional: ${on.features.join(" | ")}`,
      );
    }
    assert(
      on.permissions.some((p) => p.includes("android.permission.CAMERA")),
      `android.camera=true did not reach the APK: ${
        on.permissions.join(" | ")
      }`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("android camera: _cameraPermission is the only writer of the declaration", () => {
  // The template must carry the placeholder and NOT the permission — a
  // hand-edit putting it back is the regression this file exists for.
  assertStringIncludes(MANIFEST, "{{CAMERA_PERMISSION}}");
  assert(
    !MANIFEST.includes("android.permission.CAMERA"),
    "the template declares CAMERA unconditionally again",
  );
  assertEquals(_cameraPermission(undefined), "");
  assertEquals(_cameraPermission(false), "");
  assert(_cameraPermission(true).includes("android.permission.CAMERA"));
});
