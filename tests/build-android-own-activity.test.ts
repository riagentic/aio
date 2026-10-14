// An app's own MainActivity.kt must not SILENTLY drop the durable store or the
// SDK-35 insets frame (remote-desktop report §5).
//
// An `android/` overlay replaces the template's activity whole. Before this,
// a standalone APK built that way fell back to `localStorage` — measured
// losing a change on a kill 122 ms after it — and the build said nothing.

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  _androidStrict,
  ownActivityLosses,
  ownActivityRefusal,
} from "../src/build/build-android.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import { fromFileUrl, join } from "@std/path";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

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

// `build.android.strict` (opt-in): the same losses stop the build. Off when
// absent, so a build that warned and produced an APK still does.
Deno.test("build.android.strict: off by default the losses only warn; on, any loss refuses the build; a non-boolean is refused by name", () => {
  const losses = ownActivityLosses(BARE_OVERLAY, { standalone: true });
  assertEquals(losses.length, 3);
  assertEquals(_androidStrict({}), false);
  assertEquals(_androidStrict(undefined), false);
  assertEquals(_androidStrict({ build: { android: {} } }), false);
  assertEquals(
    _androidStrict({ build: { android: { strict: false } } }),
    false,
  );
  assertEquals(_androidStrict({ build: { android: { strict: true } } }), true);
  for (const bad of ["true", 1, null, {}]) {
    assertEquals(_androidStrict({ build: { android: { strict: bad } } }), null);
  }
  assertEquals(ownActivityRefusal(losses, false), null);
  assertEquals(ownActivityRefusal([], true), null);
  const refusal = ownActivityRefusal(losses, true);
  assertStringIncludes(refusal ?? "", "build.android.strict");
  assertStringIncludes(refusal ?? "", "no APK was built");
  assertStringIncludes(refusal ?? "", "3 things");
  // The template's own activity loses nothing: strict changes nothing for it.
  assertEquals(
    ownActivityRefusal(
      ownActivityLosses(TEMPLATE_ACTIVITY, { standalone: true }),
      true,
    ),
    null,
  );
});

// …and its TYPE is checked by every build, not only the android one: a key
// validated only by the target that reads it is a typo that waits for
// release day.
Deno.test({
  name:
    "build.android.strict: a non-boolean is refused by the build config of ANY target, by name; a boolean and an absent key are not",
  sanitizeOps: false, // aio-ok(sanitizers): a child per case, awaited
  sanitizeResources: false, // aio-ok(sanitizers): same
  async fn() {
    const dir = await tempDir("aio-android-strict-");
    try {
      await Deno.mkdir(join(dir, "src"));
      await Deno.writeTextFile(join(dir, "src/app.ts"), "");
      const runner = join(dir, "runner.ts");
      await Deno.writeTextFile(
        runner,
        `import { loadBuildConfig } from "${
          spec(REPO)
        }src/build/build-config.ts";
await loadBuildConfig();
console.log("CONFIG OK");
`,
      );
      const load = async (build: unknown) => {
        await Deno.writeTextFile(
          join(dir, "deno.json"),
          JSON.stringify({ title: "strict-type", build }),
        );
        const out = await new Deno.Command(Deno.execPath(), {
          env: { DENO_COVERAGE_DIR: childCoverageDir(), NO_COLOR: "1" },
          args: ["run", "-A", `--config=${REPO}deno.json`, runner],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).output();
        const dec = new TextDecoder();
        return [out.code, dec.decode(out.stdout) + dec.decode(out.stderr)] as [
          number,
          string,
        ];
      };
      for (const bad of ["true", 1, null]) {
        const [code, said] = await load({ android: { strict: bad } });
        assertEquals(code, 1, said);
        assertStringIncludes(
          said,
          `build.android.strict must be true or false, not ${
            JSON.stringify(bad)
          }`,
        );
      }
      for (
        const build of [{ android: { strict: true } }, { android: {} }, {}]
      ) {
        const [code, said] = await load(build);
        assertEquals(code, 0, said);
        assertStringIncludes(said, "CONFIG OK");
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});
