// The packaged shell, read where no device is: what the API 35 runs in
// tests/android-emulator-e2e.test.ts prove on one.
//   - A system font size or display size change recreated the activity and
//     RELOADED the page (`fontScale`/`density` were not in configChanges).
//     Handled, the WebView kept the text zoom it took at creation, so the
//     shell carries the new font scale over (unless the app set its own).
//   - getUserMedia({ video, audio }) was granted video only, which the
//     WebView turns into a denial — after a camera prompt, with nothing in
//     logcat. A request with anything besides the camera is denied whole,
//     and said.
import { assert, assertStringIncludes } from "@std/assert";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const manifest = ANDROID_TEMPLATE["app/src/main/AndroidManifest.xml"]!;
const activity = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;

Deno.test("android template: a font size or display size change does not recreate the activity, and the text follows the font size", () => {
  const changes = manifest.match(/android:configChanges="([^"]*)"/)?.[1]
    ?.split("|") ?? [];
  for (const c of ["fontScale", "density", "uiMode", "orientation"]) {
    assert(changes.includes(c), `configChanges lacks ${c}: ${changes}`);
  }
  assertStringIncludes(activity, "override fun onConfigurationChanged(");
  assertStringIncludes(
    activity,
    "webView.settings.textZoom = Math.round(newConfig.fontScale * 100)",
  );
  assertStringIncludes(
    activity,
    "zoomedFontScale = resources.configuration.fontScale",
  );
});

Deno.test("android template: a media request with more than the camera is denied whole, and logcat names why", () => {
  const at = activity.indexOf("override fun onPermissionRequest(");
  const body = activity.slice(at, activity.indexOf("loadUrl(", at));
  const deny = body.indexOf("others.isNotEmpty()");
  assert(deny > 0, body);
  // Before any camera prompt or grant.
  assert(deny < body.indexOf("requestPermissions("), body);
  assert(deny < body.indexOf("request.grant("), body);
  assertStringIncludes(body, "refuses a request it cannot grant whole");
});
