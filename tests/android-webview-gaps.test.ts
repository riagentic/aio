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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("android webview gaps: a pinned server's download is fetched by the app; a blob:/data: one is handed over by the page", () => {
  const fn = block("setDownloadListener {", 12);
  const pinned = fn.indexOf("pinnedDownload(");
  const net = fn.indexOf('uri.scheme == "http" || uri.scheme == "https"');
  assert(pinned >= 0 && pinned < net, "a pinned host before DownloadManager");
  assertStringIncludes(fn, "__aioSave(");
  // The pinned fetch: the system's trust first, then exactly the pin.
  const pd = block("private fun pinnedDownload(", 0);
  // Redirects are followed HERE, hop by hop: the pin (and its hostname
  // bypass) and the cookies are the pinned host:port's alone — a 302 to
  // another host gets the system's trust and that host's own cookies.
  assertStringIncludes(pd, "instanceFollowRedirects = false");
  assertStringIncludes(pd, "if (hostPort(u) == pinned)");
  assertStringIncludes(pd, "getCookie(u.toString())");
  const sys = pd.indexOf("sys.checkServerTrusted(chain, authType)");
  const pin = pd.indexOf("pinMatches(pin, chain[0].encoded)");
  assert(sys >= 0 && pin > sys, "system trust, then the pin");
  assertStringIncludes(pd, "byPin || hosts.verify(h, s)");
  assertStringIncludes(pd, "saveToDownloads(");
  // Saved pending, and removed again on a failure: no torn file.
  const save = block("private fun saveToDownloads(", 0);
  assertStringIncludes(save, "IS_PENDING, 1");
  assertStringIncludes(save, "resolver.delete(uri, null, null)");
});

Deno.test("android webview gaps: the save hook hands a revoked blob over under its download name", async () => {
  const hook = KOTLIN.match(/SAVE_HOOK = """([\s\S]*?)"""/)![1]!;
  assert(!hook.includes("$"), "a Kotlin raw string would read a $");
  const posted: Record<string, string>[] = [];
  const win: Record<string, unknown> = {};
  class Anchor {
    href = "";
    attrs: Record<string, string> = {};
    hasAttribute(n: string) {
      return n in this.attrs;
    }
    getAttribute(n: string) {
      return this.attrs[n] ?? null;
    }
    click() {}
  }
  const url = {
    createObjectURL: (o: Blob) => URL.createObjectURL(o),
    revokeObjectURL: (u: string) => URL.revokeObjectURL(u),
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  // Each read's end, awaited before the test ends: Deno's FileReader queues
  // its events on timers of its own, still pending when the last result was
  // posted (Windows: 3 timers left, every run).
  const reads: Promise<void>[] = [];
  class Reader extends FileReader {
    constructor() {
      super();
      reads.push(
        new Promise((r) => this.addEventListener("loadend", () => r())),
      );
    }
  }
  new Function(
    "window",
    "URL",
    "HTMLAnchorElement",
    "addEventListener",
    "AioSave",
    "setTimeout",
    "FileReader",
    hook,
  )(
    win,
    url,
    Anchor,
    () => {},
    { postMessage: (m: string) => posted.push(JSON.parse(m)) },
    (f: () => void, ms: number) => timers.push(setTimeout(f, ms)),
    Reader,
  );
  const save = win.__aioSave as (u: string, m: string, g: string) => boolean;
  // The common export: a detached link, clicked, its URL revoked at once.
  const a = new Anchor();
  a.href = url.createObjectURL(new Blob(["aio blob"], { type: "text/plain" }));
  a.attrs.download = "report.txt";
  a.click();
  url.revokeObjectURL(a.href);
  assert(save(a.href, "text/plain", "downloadfile.txt"));
  // A data: URL nobody clicked: the listener's guess names it.
  assert(save("data:text/plain;base64,aGk=", "text/plain", "guess.txt"));
  // No click the hook saw (a detached link's dispatchEvent, window.open,
  // location.href = url), then revoked: still handed over, by the guess.
  const opened = url.createObjectURL(new Blob(["opened"]));
  url.revokeObjectURL(opened);
  assert(save(opened, "", "opened.bin"));
  while (posted.length < 3) await new Promise((r) => setTimeout(r, 5));
  timers.forEach(clearTimeout);
  assertEquals(reads.length, 3, "one read per save");
  await Promise.all(reads);
  // …and the turn the reader is ending in: its loadend runs inside a timer.
  await new Promise((r) => setTimeout(r, 0));
  const byName = Object.fromEntries(posted.map((p) => [p.name, p]));
  assertEquals(atob(byName["report.txt"]!.data!), "aio blob");
  assertEquals(byName["report.txt"]!.mime, "text/plain");
  assertEquals(atob(byName["guess.txt"]!.data!), "hi");
  assertEquals(atob(byName["opened.bin"]!.data!), "opened");
});

Deno.test("android webview gaps: the save hook refuses a blob over SAVE_MAX before reading it, and keeps a revoked blob only briefly", async () => {
  const hook = KOTLIN.match(/SAVE_HOOK = """([\s\S]*?)"""/)![1]!;
  const max = Number(
    /private const val SAVE_MAX = (\d+) \* 1024 \* 1024/.exec(
      KOTLIN,
    )![1],
  ) * 1024 * 1024;
  // The JS bound IS SAVE_MAX (a raw string cannot say `${SAVE_MAX}`).
  assertStringIncludes(hook, `size>${max}`);
  // Kotlin catches the OutOfMemoryError (an Error, not an Exception) too.
  assertStringIncludes(block("private class AioSave(", 0), "e: Throwable");
  const posted: Record<string, string>[] = [];
  const win: Record<string, unknown> = {};
  class Anchor {
    href = "";
    attrs: Record<string, string> = {};
    hasAttribute(n: string) {
      return n in this.attrs;
    }
    getAttribute(n: string) {
      return this.attrs[n] ?? null;
    }
    click() {}
  }
  const url = {
    createObjectURL: (o: Blob) => URL.createObjectURL(o),
    revokeObjectURL: (u: string) => URL.revokeObjectURL(u),
  };
  const delays: number[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  new Function(
    "window",
    "URL",
    "HTMLAnchorElement",
    "addEventListener",
    "AioSave",
    "setTimeout",
    hook,
  )(
    win,
    url,
    Anchor,
    () => {},
    { postMessage: (m: string) => posted.push(JSON.parse(m)) },
    (f: () => void, ms: number) => {
      delays.push(ms);
      timers.push(setTimeout(f, ms));
    },
  );
  const save = win.__aioSave as (u: string, m: string, g: string) => boolean;
  try {
    // Over the bound: an error posted, never a data: read of it.
    class Big extends Blob {
      override get size() {
        return max + 1;
      }
    }
    const big = new Anchor();
    big.href = url.createObjectURL(new Big(["x"]));
    big.attrs.download = "huge.bin";
    big.click();
    assert(save(big.href, "", "g.bin"));
    // Every revoked Blob is kept, briefly — the clicked one and one no
    // download named — and a URL the hook never made, not at all.
    const quiet = url.createObjectURL(new Blob(["img"]));
    url.revokeObjectURL(quiet);
    url.revokeObjectURL(big.href);
    url.revokeObjectURL("blob:not-made-here");
    assertEquals(delays.length, 2);
    assert(delays.every((d) => d <= 2000), `kept ${delays} ms`);
    while (posted.length < 1) await new Promise((r) => setTimeout(r, 5));
    assertEquals(posted[0]!.name, "huge.bin");
    assertStringIncludes(posted[0]!.error ?? "", "over 32 MB");
    assertEquals(posted[0]!.data, undefined);
  } finally {
    timers.forEach(clearTimeout);
  }
});
