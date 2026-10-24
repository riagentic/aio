// deno.json `android.schemes` — an APK that opens its own URL scheme
// (`myapp://…`). One list, spent in both halves: the manifest's VIEW filters
// (and `singleTask`, so a link reaches the copy that is open) and the activity
// that hands the link to the page (`window.__aioOpenUrl` + an `aio:open-url`
// event). Validated on every build; the API 35 run is in
// tests/android-emulator-e2e.test.ts's notes (measured with a scratch driver).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { _androidSchemes } from "../src/build/build-config.ts";
import {
  _androidConfigWarnings,
  _deepLinkFilters,
  _fillTemplate,
  _leftoverTokens,
} from "../src/build/build-android.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

Deno.test("android.schemes: lower-case RFC 3986 schemes, none of the system's; anything else refused by name", () => {
  assertEquals(_androidSchemes(undefined), []);
  assertEquals(_androidSchemes(["myapp", "my-app.v2+x", "myapp"]), [
    "myapp",
    "my-app.v2+x",
  ]);
  for (
    const bad of ["myapp", ["MyApp"], ["1app"], ["my app"], [3], ["https"], [
      "intent",
    ], ["javascript"]]
  ) {
    const r = _androidSchemes(bad);
    assert("error" in r, JSON.stringify(bad));
    assertStringIncludes(r.error, "android.schemes");
  }
  // A key aio reads — not the "not a key aio reads" warning.
  assertEquals(_androidConfigWarnings({ android: { schemes: ["myapp"] } }), []);
});

Deno.test("android.schemes: the manifest gets one VIEW filter per scheme and singleTask — and nothing without", () => {
  const manifest = ANDROID_TEMPLATE["app/src/main/AndroidManifest.xml"]!;
  const fill = (schemes: string[]) =>
    _fillTemplate(manifest, {
      "{{DEEP_LINK_FILTERS}}": _deepLinkFilters(schemes),
      "{{DEEP_LINK_ATTR}}": schemes.length
        ? 'android:launchMode="singleTask"'
        : "",
    });
  const two = fill(["myapp", "other"]);
  assertEquals(two.match(/android\.intent\.action\.VIEW/g)?.length, 2);
  assertStringIncludes(two, '<data android:scheme="myapp" />');
  assertStringIncludes(two, '<data android:scheme="other" />');
  assertStringIncludes(two, "android.intent.category.BROWSABLE");
  assertStringIncludes(two, 'android:launchMode="singleTask"');
  const none = fill([]);
  assert(!none.includes("action.VIEW") && !none.includes("launchMode"), none);
  assertEquals(
    _leftoverTokens(none).filter((t) => t.includes("DEEP_LINK")),
    [],
  );
});

Deno.test("android.schemes: the activity hands the link over as data, after the page loaded, cold and warm", () => {
  const kt = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;
  assertStringIncludes(kt, "private const val DEEP_LINKS = {{DEEP_LINKS}}");
  assertStringIncludes(kt, "override fun onNewIntent(intent: Intent)");
  assertStringIncludes(
    kt,
    "if (savedInstanceState == null) pendingLink = linkOf(intent)",
  );
  // JSON-quoted: any app can send the intent.
  assertStringIncludes(kt, "org.json.JSONObject.quote(url)");
  assertStringIncludes(kt, "new CustomEvent('aio:open-url',{detail:{url:$q}})");
  // Delivered from onPageFinished, never onto a client's connect form.
  const finished = kt.slice(kt.indexOf("override fun onPageFinished("));
  assert(
    finished.indexOf("deliverLink()") <
      finished.indexOf("override fun onPageStarted("),
    finished.slice(0, 400),
  );
  assertStringIncludes(
    finished,
    'IS_CLIENT && Uri.parse(url ?: "").host == ASSET_HOST',
  );
});
