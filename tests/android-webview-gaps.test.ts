// Three things a browser does by itself and a WebView leaves to its app —
// found by using aio APKs on a real phone (Android 14, WebView 141):
//
//   • the page's renderer process is lost (Android takes it back when memory
//     is short): with `onRenderProcessGone` unanswered the WebView aborted the
//     whole app — the launcher on screen where the app was;
//   • `<input type="file">`: a tap did nothing at all;
//   • a download link: a tap did nothing, and logcat said nothing.
//
// Source-level: `deno task test:android` is what runs each on a device (its
// "renderer process is lost", "<input type=file>" and client download steps),
// and a real APK build is what proves this Kotlin compiles.
import { assert, assertStringIncludes } from "@std/assert";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const KOTLIN = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;

/** From `start` to the first line that closes a block at `indent` spaces. */
function block(start: string, indent: number): string {
  const at = KOTLIN.indexOf(start);
  assert(at >= 0, `MainActivity.kt has no "${start}"`);
  const end = KOTLIN.indexOf(`\n${" ".repeat(indent)}}\n`, at);
  assert(end > at, `"${start}" does not close`);
  return KOTLIN.slice(at, end);
}

Deno.test("android webview gaps: a lost renderer rebuilds the activity — once; a second loss at once stops the app", () => {
  const fn = block("override fun onRenderProcessGone(", 16);
  // The dead WebView is dropped before the activity is built again.
  const destroy = fn.indexOf("view?.destroy()");
  const recreate = fn.indexOf("recreate()");
  assert(destroy >= 0 && recreate > destroy, "destroy, then recreate");
  assert(
    fn.indexOf("return true", recreate) > recreate,
    "the loss is not answered as handled — the WebView aborts the app",
  );
  // The loop guard answers false (the app stops) BEFORE anything is rebuilt,
  // and its clock outlives the activity that recreate() replaces.
  const loop = fn.indexOf("if (loop) return false");
  assert(loop >= 0 && loop < destroy, "no loop guard before the rebuild");
  assertStringIncludes(fn, "now - lastRendererLoss < RENDERER_LOSS_LOOP_MS");
  assert(
    KOTLIN.indexOf("private var lastRendererLoss") <
      KOTLIN.indexOf("class MainActivity"),
    "lastRendererLoss is a member of the activity: recreate() resets it",
  );
  // Never silent: both ways it goes are said.
  assertStringIncludes(fn, 'android.util.Log.e("aio"');
  assertStringIncludes(fn, "detail?.didCrash()");
});

Deno.test("android webview gaps: the file picker's callback is answered on every path", () => {
  const fn = block("override fun onShowFileChooser(", 16);
  // A picker still open when another is asked for: answered, not dropped.
  assert(
    fn.indexOf("pendingFiles?.onReceiveValue(null)") <
      fn.indexOf("pendingFiles = callback"),
    "a second picker drops the first one's callback unanswered",
  );
  // No picker on the device: answered, and said.
  const none = fn.slice(fn.indexOf("catch (e: ActivityNotFoundException)"));
  assertStringIncludes(none, "callback?.onReceiveValue(null)");
  assertStringIncludes(none, 'android.util.Log.e("aio"');
  assertStringIncludes(fn, "return true");
  // The result — a pick, several, or the user backing out (null).
  const result = block(
    "private val filePicker = registerForActivityResult(",
    4,
  );
  assertStringIncludes(result, "result.resultCode != RESULT_OK");
  assertStringIncludes(result, "data.clipData");
  assertStringIncludes(result, "pendingFiles?.onReceiveValue(picked)");
  assertStringIncludes(result, "pendingFiles = null");
});

Deno.test("android webview gaps: a download is started or refused out loud, never dropped", () => {
  const fn = block("setDownloadListener {", 12);
  const net = fn.indexOf('uri.scheme == "http" || uri.scheme == "https"');
  const refused = fn.indexOf("download NOT saved");
  assert(net >= 0 && refused > net, "network links first, the rest refused");
  assertStringIncludes(fn, "android.app.DownloadManager.Request(uri)");
  // A signed-in server: the page's cookies go with the request.
  assertStringIncludes(fn, "CookieManager.getInstance().getCookie(url)");
  assertStringIncludes(fn, "download NOT started");
});
