// An app's own MainActivity.kt must not SILENTLY drop the durable store or the
// SDK-35 insets frame (remote-desktop report §5).
//
// An `android/` overlay replaces the template's activity whole. Before this,
// a standalone APK built that way fell back to `localStorage` — measured
// losing a change on a kill 122 ms after it — and the build said nothing.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ownActivityLosses } from "../src/build/build-android.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const TEMPLATE_ACTIVITY =
  ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;

// A realistic overlay: its own native bridge (so `addJavascriptInterface` IS
// present), the store only named in a comment, and no insets handling.
const BARE_OVERLAY = `package aio.app
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // TODO: AioNativeStore
        webView = WebView(this).apply {
            addJavascriptInterface(AppBridge(this@MainActivity), "AppBridge")
        }
        setContentView(webView)
    }
    override fun onBackPressed() = webView.evaluateJavascript("__aioBack()") {}
}`;

Deno.test("own MainActivity.kt: a standalone overlay without the store, fetch bridge or insets frame warns for each, naming the fix", () => {
  const w = ownActivityLosses(BARE_OVERLAY, { standalone: true });
  assertEquals(w.length, 3);
  assertStringIncludes(w[0]!, "AioNativeStore");
  assertStringIncludes(w[0]!, "localStorage");
  assertStringIncludes(
    w[0]!,
    'addJavascriptInterface(AioNativeStore(File(filesDir, "aio-store")), "AioNativeStore")',
  );
  // nativeFetch() — a standalone app's way past origin-refusing APIs.
  assertStringIncludes(w[1]!, "AioNativeFetch");
  assertStringIncludes(w[1]!, "nativeFetch() in this standalone APK REJECTS");
  assertStringIncludes(w[1]!, "addWebMessageListener");
  assertStringIncludes(w[2]!, "insets");
  assertStringIncludes(
    w[2]!,
    "android-template/app/src/main/java/aio/app/MainActivity.kt",
  );
});

Deno.test("own MainActivity.kt: a client/dev APK is never told to add the store (it must not have one)", () => {
  const w = ownActivityLosses(BARE_OVERLAY, { standalone: false });
  assertEquals(w.length, 1);
  assertStringIncludes(w[0]!, "insets");
});

Deno.test("own MainActivity.kt: an overlay carrying the template's store and frame is silent", () => {
  assertEquals(ownActivityLosses(TEMPLATE_ACTIVITY, { standalone: true }), []);
});

Deno.test("own MainActivity.kt: the store installed from another overlaid file counts", () => {
  const helper = `package aio.app
fun installStore(w: WebView, dir: File) =
    w.addJavascriptInterface(Store(dir), "AioNativeStore")
fun handKey(w: WebView, key: String) =
    WebViewCompat.addDocumentStartJavaScript(w, "window[\"__aioNativeStoreKey\"]=" + key, setOf("https://appassets.androidplatform.net"))
fun installFetch(w: WebView) =
    WebViewCompat.addWebMessageListener(w, "AioNativeFetch", setOf("https://appassets.androidplatform.net"), Fetch)`;
  const framed = BARE_OVERLAY.replace(
    "setContentView(webView)",
    "ViewCompat.setOnApplyWindowInsetsListener(root) { v, i -> i }",
  );
  assertEquals(
    ownActivityLosses(`${framed}\n${helper}`, { standalone: true }),
    [],
  );
});

// An activity copied from 1.0.12 installs the UNKEYED store: every frame of
// the WebView — a third-party <iframe> — can read and overwrite the state.
Deno.test("own MainActivity.kt: a standalone overlay with the UNKEYED store (copied from 1.0.12) warns that frames can reach it", () => {
  const unkeyed = TEMPLATE_ACTIVITY.split("\n").filter((l) =>
    !l.includes("addDocumentStartJavaScript(")
  ).join("\n");
  const w = ownActivityLosses(unkeyed, { standalone: true });
  assertEquals(w.length, 1, JSON.stringify(w));
  assertStringIncludes(w[0]!, "WITHOUT its per-launch key");
  assertStringIncludes(w[0]!, "<iframe>");
  assertStringIncludes(w[0]!, "addDocumentStartJavaScript");
  // A client/dev APK has no store at all — nothing to key.
  assertEquals(ownActivityLosses(unkeyed, { standalone: false }), []);
});

// v1.0.11 hunt: an activity that inflates a layout whose root sets
// `android:fitsSystemWindows="true"` HAS insets handling — only its XML says
// so. Reading .kt/.java alone warned it "draws UNDER the status bar", falsely.
Deno.test('own MainActivity.kt: fitsSystemWindows="true" in the overlay res/ XML counts as insets handling', async () => {
  const { ownActivityWarnings } = await import(
    "../src/build/build-android.ts"
  );
  const { dropTempDir, tempDir } = await import(
    "../src/testing/temp-dir.ts"
  );
  const dir = await tempDir("aio-own-activity-");
  try {
    const kt = "app/src/main/java/aio/app/MainActivity.kt";
    const layout = "app/src/main/res/layout/main.xml";
    await Deno.mkdir(`${dir}/app/src/main/java/aio/app`, { recursive: true });
    await Deno.mkdir(`${dir}/app/src/main/res/layout`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/${kt}`,
      `class MainActivity : AppCompatActivity() {
  override fun onCreate(b: Bundle?) { super.onCreate(b); setContentView(R.layout.main) }
  // Back: window.__aioBack
}`,
    );
    const xml = (fits: string) =>
      Deno.writeTextFile(
        `${dir}/${layout}`,
        `<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:fitsSystemWindows="${fits}"><WebView android:id="@+id/web"/></FrameLayout>`,
      );
    await xml("true");
    assertEquals(
      await ownActivityWarnings(dir, [kt, layout], { standalone: false }),
      [],
    );
    // "false" is not insets handling — still said.
    await xml("false");
    const w = await ownActivityWarnings(dir, [kt, layout], {
      standalone: false,
    });
    assertEquals(w.length, 1);
    assertStringIncludes(w[0]!, "insets");
    // A theme item turning it on counts too.
    assertEquals(
      ownActivityLosses("class A // __aioBack", {
        standalone: false,
        resXml: '<item name="android:fitsSystemWindows">true</item>',
      }),
      [],
    );
  } finally {
    await dropTempDir(dir);
  }
});

// A field report forked MainActivity.kt to reach the page on Back. A fork that
// does not call `window.__aioBack` makes every `onBackButton` handler dead
// code — said at build time, not discovered on the phone.
Deno.test("own MainActivity.kt: an overlay that never asks the page about Back warns", () => {
  const noBack = BARE_OVERLAY.replace(
    /\n *override fun onBackPressed.*\n/,
    "\n",
  );
  const w = ownActivityLosses(noBack, { standalone: false });
  assertEquals(w.length, 2);
  assertStringIncludes(w[1]!, "onBackButton");
  assertStringIncludes(w[1]!, "__aioBack");
});
