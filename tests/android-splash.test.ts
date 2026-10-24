// deno.json `build.splash` on the APK: a native overlay above the WebView
// (AioSplash in MainActivity.kt), baked from the one resolver
// (src/build/splash.ts). Source-level, as the other template tests: the
// emulator lane (`deno task test:android`) is what proves it runs.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import {
  _fillTemplate,
  _leftoverTokens,
  _splashFiles,
  _splashKotlin,
  ownActivityLosses,
} from "../src/build/build-android.ts";
import { resolveSplash } from "../src/build/splash.ts";
import { appIconPng } from "../src/build/app-icon.ts";
import type { SplashSpec } from "../src/electron/splash.ts";

const KOTLIN = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;
const PNG = await appIconPng("S", 64, "splash-app");

function spec(splash: Record<string, unknown>): SplashSpec {
  const r = resolveSplash({ build: { splash } }, {
    root: "/app",
    appId: "splash-app",
    read: (p) => p.endsWith("splash.png") || p.endsWith("@2x.png") ? PNG : null,
  });
  assert("splash" in r && r.splash, JSON.stringify(r));
  return r.splash;
}

/** The body of `fun <name>(` up to its close at 4 spaces. */
function body(name: string): string {
  const at = KOTLIN.indexOf(`fun ${name}(`);
  assert(at >= 0, `MainActivity.kt has no fun ${name}(`);
  return KOTLIN.slice(at, KOTLIN.indexOf("\n    }\n", at));
}

Deno.test("android splash: absent, the activity bakes SPLASH = null and the build adds nothing", () => {
  assertEquals(_splashKotlin(null, "App", "system"), "null");
  const filled = _fillTemplate(KOTLIN, {
    "{{SPLASH}}": _splashKotlin(null, "App", "system"),
  });
  assertStringIncludes(filled, "private val SPLASH: AioSplashSpec? = null\n");
  assert(!_leftoverTokens(filled).includes("{{SPLASH}}"));
  // Every splash path is behind SPLASH != null.
  const marked = KOTLIN.split("\n").filter((l) => / \/\/ splash$/.test(l));
  // (3: `onPageFinished` is no longer splash-only — it hands the page a
  // deep link too — so only the splash line inside it is marked.)
  assertEquals(marked.length, 3, marked.join("\n"));
  for (const line of marked) {
    assert(
      /SPLASH != null|splashByPage|^\s*} \/\/ splash$|onPageFinished/.test(
        line,
      ),
      `an unguarded splash line: ${line}`,
    );
  }
  assertStringIncludes(
    KOTLIN,
    "if (SPLASH != null && savedInstanceState == null) splash = AioSplash.show(this, SPLASH)",
  );
});

Deno.test("android splash: configured, minMs, the text ({title} filled, escaped), font and colours are baked", () => {
  const s = spec({
    image: "assets/splash.png",
    text: 'Starting {title} "$x"…',
    minMs: 1500,
    font: { family: "serif", size: 18, weight: "normal" },
    color: "#123456",
  });
  const k = _splashKotlin(s, "Cost", "system");
  assertStringIncludes(k, "minMs = 1500L");
  assertStringIncludes(k, 'text = "Starting Cost \\"\\$x\\"…"');
  assertStringIncludes(k, 'family = "serif", size = 18f, bold = false');
  assertStringIncludes(k, "scale = 1, night = null");
  assertStringIncludes(
    k,
    `light = intArrayOf(0xFF${
      s.light.background.slice(1)
    }.toInt(), 0xFF123456.toInt())`,
  );
  assertStringIncludes(
    k,
    `dark = intArrayOf(0xFF${
      s.dark.background.slice(1)
    }.toInt(), 0xFF123456.toInt())`,
  );
  assertStringIncludes(_splashKotlin(s, "A", "dark"), "night = true");
  assertStringIncludes(_splashKotlin(s, "A", "light"), "night = false");
  // Defaults: minMs 1000, bold, the system font, image only.
  const d = _splashKotlin(spec({ image: "assets/splash.png" }), "A", "system");
  // 1.0.23: the title by default; text false is image only.
  assertStringIncludes(d, 'minMs = 1000L, text = "A", family = null');
  assertStringIncludes(
    _splashKotlin(
      spec({ image: "assets/splash.png", text: false }),
      "A",
      "system",
    ),
    "text = null",
  );
  assertStringIncludes(d, "bold = true");
  // An @2x image is drawn at half its pixels.
  assertStringIncludes(
    _splashKotlin(spec({ image: "assets/s@2x.png" }), "A", "system"),
    "scale = 2",
  );
});

Deno.test("android splash: progress and bar are accepted and have nothing to draw on an APK", () => {
  const s = spec({
    image: "assets/splash.png",
    progress: true,
    bar: { style: "thin", color: "#ff0000" },
  });
  const k = _splashKotlin(s, "A", "system");
  assert(!k.includes("ff0000") && !k.includes("thin"), k);
});

Deno.test("android splash: the image goes into assets and the theme's window background is the splash's, per mode", () => {
  const s = spec({ image: "assets/splash.png" });
  const sys = _splashFiles(s, "system");
  assertEquals(sys["app/src/main/assets/aio-splash.png"], PNG);
  const theme = sys["app/src/main/res/values/aio_splash_theme.xml"] as string;
  assertStringIncludes(
    theme,
    '<style name="AioSplash" parent="Theme.AppCompat.DayNight.NoActionBar">',
  );
  assertStringIncludes(theme, "@color/aio_splash_background");
  assertStringIncludes(
    sys["app/src/main/res/values/aio_splash_color.xml"] as string,
    s.light.background,
  );
  assertStringIncludes(
    sys["app/src/main/res/values-night/aio_splash_color.xml"] as string,
    s.dark.background,
  );
  const dark = _splashFiles(s, "dark");
  assert(!("app/src/main/res/values-night/aio_splash_color.xml" in dark));
  assertStringIncludes(
    dark["app/src/main/res/values/aio_splash_color.xml"] as string,
    s.dark.background,
  );
  assertStringIncludes(
    dark["app/src/main/res/values/aio_splash_theme.xml"] as string,
    'parent="Theme.AppCompat.NoActionBar"',
  );
});

Deno.test("android splash: it closes on the page's load signal, never before minMs from its first frame, and at the cap", () => {
  const due = body("closeWhenDue");
  assertStringIncludes(due, "if (gone || !ready || shownAt < 0) return");
  assertStringIncludes(
    due,
    "view.postDelayed({ hide() }, maxOf(0L, shownAt + minMs - now()))",
  );
  // shownAt is the first frame (pre-draw), not onCreate.
  assertStringIncludes(KOTLIN, "shownAt = now()");
  assertStringIncludes(KOTLIN, "}, SPLASH?.capMs ?: SPLASH_CAP_MS)");
  assertStringIncludes(KOTLIN, "private const val SPLASH_CAP_MS = 30_000L");
  // The signal: aio's #root has content — the desktop's "ui mounted" rule —
  // main frame only; onPageFinished only on a WebView that cannot carry it.
  assertStringIncludes(KOTLIN, "document.getElementById('root')");
  assertStringIncludes(KOTLIN, "if (isMainFrame) ready()");
  assertStringIncludes(KOTLIN, "if (splashByPage) splash?.ready()");
  // Plain JS in a raw string: no `$` for Kotlin to read.
  const hook = KOTLIN.slice(
    KOTLIN.indexOf("SPLASH_HOOK = "),
    KOTLIN.indexOf('})();"""'),
  );
  assert(!hook.includes("$"), hook);
});

Deno.test("android splash: an own MainActivity.kt without AioSplash is a loss only when build.splash is set", () => {
  const own = `package aio.app
class MainActivity : AppCompatActivity() {
  fun f() { ViewCompat.setOnApplyWindowInsetsListener(root) { v, i -> i }; "__aioBack" }
}`;
  assertEquals(ownActivityLosses(own, { standalone: false }), []);
  const w = ownActivityLosses(own, { standalone: false, splash: true });
  assertEquals(w.length, 1);
  assertStringIncludes(w[0]!, "never shows AioSplash");
  assertEquals(
    ownActivityLosses(KOTLIN, { standalone: true, splash: true }),
    [],
  );
});
