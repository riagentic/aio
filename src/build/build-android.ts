/**
 * @module
 * Build Android — generates Android project from template, builds APK via Gradle.
 */
import { dirname, join } from "@std/path";
import {
  chmodIfSupported,
  findGradle,
  findJdk,
  GRADLE_MAX_JDK,
  type JdkResult,
  misplacedIconHint,
  resolveAppIcon,
  resolveSdk,
} from "./build-helpers.ts";
import { ANDROID_TEMPLATE } from "./android-template.ts";
import { androidLocalHTML, htmlOpen } from "../server/server-html-gen.ts";
import type { BuildConfig } from "./build-config.ts";
import type { BuildVersion } from "./build-version.ts";
import { appIconPng } from "./app-icon.ts";
import { APP_STYLE, BUNDLE_JS } from "../server/app-files.ts";

/** The app version an APK declares, from THE resolved build version.
 *
 *  Android has two of these and they are not interchangeable. `versionName` is
 *  the string a human reads — the full build version, `-dirty.<hash8>`
 *  included; `versionCode` is an INTEGER, and it is the only value Play, an
 *  MDM and `adb install -r` compare: an install whose code is not greater is
 *  refused (`INSTALL_FAILED_VERSION_DOWNGRADE`).
 *
 *  The code is `major·100 000 000 + minor·1 000 000 + build`, so the order of
 *  build numbers IS the order of installs: `1.2.345 < 1.2.346 < 1.3.1`.
 *  A dirty build carries the SAME code as the clean build of its count —
 *  Android accepts a same-code reinstall, and a dirty build is not a release.
 *
 *  Out-of-range refuses rather than wrapping: a silently truncated code is an
 *  APK that installs over a NEWER one. Pure. */
export function androidVersion(
  version: Pick<BuildVersion, "version" | "base" | "build">,
): { code: number; name: string } {
  const [major, minor] = version.base.split(".").map(Number) as [
    number,
    number,
  ];
  const build = version.build;
  if (major > 20 || minor > 99 || build > 999_999) {
    throw new Error(
      `[android] \u2717 version ${version.version} does not fit an Android ` +
        `versionCode (max 2147483647): major must be \u2264 20, minor ` +
        `\u2264 99, build \u2264 999999. Android's integer is the whole ` +
        `budget — say so now rather than ship an APK that installs over a ` +
        `newer one.`,
    );
  }
  const code = major * 100_000_000 + minor * 1_000_000 + build;
  return { code, name: version.version };
}

/** Build the Android APK. Exits process on completion or error. */
export async function buildAndroid(cfg: BuildConfig): Promise<void> {
  const { dist, binaryName, appTitle, doRemote, doRelease } = cfg;

  const androidHome = resolveSdk(); // ANDROID_HOME, its Sdk subdir, or defaults
  if (!androidHome) {
    console.error(
      "[android] \u2717 ANDROID_HOME not set — install Android SDK and set ANDROID_HOME",
    );
    Deno.exit(1);
  }

  // Resolve a JDK Gradle will actually accept: canonical path, compile-verified
  // (a JRE fails), major <= GRADLE_MAX_JDK (Gradle can't run on a newer one).
  // Fail loud, naming the reason, when the machine has none.
  const jdk = findJdk();
  if (!jdk.home) {
    console.error(
      "[android] ✗ no usable JDK found — Android builds need a real JDK " +
        `(compiles Java), version 17-${GRADLE_MAX_JDK}`,
    );
    if (jdk.newestFound > GRADLE_MAX_JDK) {
      console.error(
        `  found JDK ${jdk.newestFound}, but the pinned Gradle (8.14.3) can't ` +
          `run on JDK ${GRADLE_MAX_JDK + 1}+ yet - install a supported one:`,
      );
    } else {
      console.error("  a JRE is not enough (no compiler). install a full JDK:");
    }
    console.error("    - Debian/Ubuntu: sudo apt install openjdk-21-jdk");
    console.error("    - macOS:         brew install openjdk@21");
    console.error(
      `    - or set JAVA_HOME to a JDK 17-${GRADLE_MAX_JDK} that compiles`,
    );
    Deno.exit(1);
  }
  console.log(`[android] ✓ JDK ${jdk.home} (Java ${jdk.major})`);

  const androidDir = join(dist, "android");
  try {
    await Deno.remove(androidDir, { recursive: true });
  } catch { /* no previous build — skip */ }

  // Write template files (embedded TypeScript constants — works local and JSR)
  for (const [relPath, content] of Object.entries(ANDROID_TEMPLATE)) {
    const dest = join(androidDir, relPath);
    await Deno.mkdir(dirname(dest), { recursive: true });
    await Deno.writeTextFile(dest, content);
  }

  // …then let the app overlay its own Android sources on top. See `_overlay`.
  // Before placeholder substitution, so an overlaid manifest or build file
  // still gets {{APPLICATION_ID}} and {{APP_NAME}} filled in like the
  // template's own.
  const overlaid = await _overlay(cfg.root, androidDir);
  if (overlaid.length) {
    console.log(
      `[android] \u2713 overlay: ${overlaid.length} file(s) from android/`,
    );
    for (const f of overlaid) console.log(`[android]   \u00b7 ${f}`);
  }

  // Derive application ID from THE APK label (see apkLabel /
  // androidApplicationId below) — dev:android derives the same id from the
  // APK's filename, so both must share the rule or drift.
  const label = apkLabel(cfg);
  const applicationId = androidApplicationId(label, cfg.androidApplicationId);
  if (!applicationId) {
    console.error(
      cfg.androidApplicationId !== undefined
        ? `[android] \u2717 android.applicationId ${
          JSON.stringify(cfg.androidApplicationId)
        } is not a valid Android package name — it needs at least two ` +
          `dot-separated segments, each starting with a letter ` +
          `(e.g. "com.example.wallet")`
        : `[android] \u2717 APK name "${label}" produces invalid applicationId — must start with a letter`,
    );
    Deno.exit(1);
  }
  const appNameKotlin = (appTitle ?? binaryName)
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\$/g, "\\$")
    .replace(/"/g, '\\"');
  const appNameXml = (appTitle ?? binaryName)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // Check for user icon — from THE app-dir decider (cfg.appDir)
  const { icon: iconPath, misplaced: misplacedIcon } = await resolveAppIcon(
    cfg.root,
    cfg.appDir,
  );
  const hasIcon = iconPath !== null;
  if (misplacedIcon) {
    console.warn(
      `[android] \u26a0 ${misplacedIconHint(misplacedIcon, cfg.appDir)}`,
    );
  }

  // Replace placeholders in template files
  // The APK's declared version — from deno.json, the app's ONE identity file.
  const appVersion = androidVersion(cfg.version);
  console.log(
    `[android] version ${appVersion.name} (versionCode ${appVersion.code})`,
  );

  const xmlFiles = new Set(["app/src/main/AndroidManifest.xml"]);
  const templateFiles = [
    "app/build.gradle.kts",
    "build.gradle.kts",
    "settings.gradle.kts",
    "app/src/main/AndroidManifest.xml",
  ];
  for (const f of templateFiles) {
    const path = join(androidDir, f);
    let content = await Deno.readTextFile(path);
    content = content.replaceAll("{{APPLICATION_ID}}", applicationId);
    content = content.replaceAll("{{VERSION_CODE}}", String(appVersion.code));
    content = content.replaceAll("{{VERSION_NAME}}", appVersion.name);
    content = content.replaceAll(
      "{{APP_NAME}}",
      xmlFiles.has(f) ? appNameXml : appNameKotlin,
    );
    content = content.replaceAll(
      "{{ICON_ATTR}}",
      'android:icon="@mipmap/ic_launcher"',
    );
    content = content.replaceAll(
      "{{CLEARTEXT_ATTR}}",
      _cleartextAttr({ devUrl: cfg.androidDevUrl, remote: doRemote }),
    );
    await Deno.writeTextFile(path, content);
  }

  // Pin Gradle to the resolved JDK so its toolchain resolver can't wander off to
  // a JRE it mis-detected — the root of the "[JAVA_COMPILER]" toolchain error.
  await _pinJdk(androidDir, jdk);

  console.log(`[android] app: ${appNameKotlin} (${applicationId})`);

  if (cfg.androidDevUrl) {
    // dev:android — point the WebView at the LIVE dev server, no bundled assets.
    await _applyDevUrl(androidDir, cfg.androidDevUrl);
    console.log(`[android] ✓ dev build → ${cfg.androidDevUrl}`);
  } else {
    // Copy assets into android project
    const assetsDir = join(androidDir, "app/src/main/assets");
    await Deno.mkdir(assetsDir, { recursive: true });

    if (doRemote) {
      await _writeConnectPage(assetsDir, appNameXml, cfg.bakedServer);
    } else {
      await _writeLocalAssets(cfg, assetsDir);
    }
  }

  // Icon → mipmap resources. An app with no `icon.png` gets its MONOGRAM
  // rather than Android's generic robot: on a phone the launcher icon is the
  // only way to tell two aio apps apart, and "no icon" is not an option the
  // platform offers — it just picks one for you.
  const mipmapDir = join(androidDir, "app/src/main/res/mipmap-hdpi");
  await Deno.mkdir(mipmapDir, { recursive: true });
  if (hasIcon) {
    await Deno.copyFile(iconPath, join(mipmapDir, "ic_launcher.png"));
    console.log(`[android] \u2713 icon from ${iconPath}`);
  } else {
    const label = appTitle ?? binaryName;
    await Deno.writeFile(
      join(mipmapDir, "ic_launcher.png"),
      await appIconPng(label, 192),
    );
    console.log(`[android] \u2713 default icon for "${label}"`);
  }

  await _runGradle(
    cfg,
    androidDir,
    androidHome,
    jdk.home,
    appNameKotlin,
    doRelease,
  );
  Deno.exit(0);
}

/** Does this APK need to talk to a plaintext `http://` / `ws://` server?
 *
 *  Android blocks cleartext by default from targetSdk 28 (this template is 34),
 *  so an APK without this attribute reaches a plain-http server not at all —
 *  `net::ERR_CLEARTEXT_NOT_PERMITTED`, on a target whose whole purpose is
 *  "enter your server's URL". It used to be added by the dev rewrite ALONE, so
 *  `dev:android` worked and the `--android --remote` client APK it is meant to
 *  become could not reach the same server: the second decider, in the shape
 *  where only one of the two knows the rule.
 *
 *  Both cases here are a client of a server the developer chose and can see — a
 *  dev server over `adb reverse`, or a LAN server run with `--expose`, which
 *  serves plain http unless `tls` is set. A STANDALONE APK gets nothing: it
 *  loads packaged assets over the asset loader's https origin and has no server
 *  to reach, so cleartext would be permission for nothing.
 *
 *  (Separate from the WebView's own mixed-content rule — a packaged https page
 *  may still not open a `ws://` socket. See docs/build/targets.md.) */
export function _cleartextAttr(
  opts: { devUrl?: string | null; remote?: boolean },
): string {
  return opts.devUrl || opts.remote
    ? 'android:usesCleartextTraffic="true"'
    : "";
}

/**
 * Copy an app's own `android/` directory over the generated Gradle project.
 *
 * The APK aio generates is a WebView around a JS bundle, which is the whole app
 * for anything that only needs a screen. It is not the whole app for anything
 * that needs the DEVICE: screen capture is `MediaProjection`, input injection is
 * an `AccessibilityService`, and neither has a JavaScript equivalent — there is
 * no `getDisplayMedia` in an Android WebView and no way to dispatch a touch from
 * one. Those apps are not asking for a different shell; they are asking to add a
 * service and a permission to this one.
 *
 * So: files under `<app>/android/` land on the generated project at the same
 * relative path, creating directories and replacing template files outright. A
 * `AndroidManifest.xml` there replaces the generated manifest (keep the
 * placeholders — they are substituted after this runs); Kotlin under
 * `app/src/main/java/` is simply compiled with the rest.
 *
 * Every overlaid path is printed. A silent overlay is a build that quietly
 * stopped being the app the template describes, and the first symptom would be
 * a behaviour nobody could find the source of.
 */
async function _overlay(root: string, androidDir: string): Promise<string[]> {
  const src = join(root, "android");
  try {
    if (!(await Deno.stat(src)).isDirectory) return [];
  } catch {
    return []; // no overlay — the overwhelmingly common case
  }
  const copied: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for await (const e of Deno.readDir(join(src, rel))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        await walk(childRel);
        continue;
      }
      if (!e.isFile) continue; // symlinks into a build tree are not portable
      const dest = join(androidDir, childRel);
      await Deno.mkdir(dirname(dest), { recursive: true });
      await Deno.copyFile(join(src, childRel), dest);
      copied.push(childRel);
    }
  };
  await walk("");
  copied.sort();
  return copied;
}

export async function _writeConnectPage(
  assetsDir: string,
  appNameXml: string,
  /** deno.json `build.server` — the address this APK was built to talk to.
   *  Prefilled and auto-connected on first launch, because an installed client
   *  asking its user to type a server the build already recorded is the gap
   *  `build.server` was supposed to close. */
  bakedServer?: string | null,
  /** Whose build is writing it — the log line names the target. */
  tag = "android",
): Promise<void> {
  const connectHtml = `<!DOCTYPE html>
${htmlOpen()}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appNameXml}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh}
    .card{text-align:center;padding:2rem;width:90%;max-width:400px}
    h1{font-size:2rem;font-weight:300;letter-spacing:.1em;color:#4a9eff;margin-bottom:1.5rem}
    input{width:100%;padding:.8rem 1rem;font-size:1rem;background:#16213e;border:1px solid #333;border-radius:8px;color:#e0e0e0;outline:none;margin-bottom:.8rem}
    input:focus{border-color:#4a9eff}
    input::placeholder{color:#666}
    button{width:100%;padding:.8rem;font-size:1rem;background:#4a9eff;border:none;border-radius:8px;color:white;cursor:pointer}
    button:active{background:#3a8eef}
    #err{margin-top:.8rem;font-size:.85rem;color:#f44;min-height:1.2em}
  </style>
</head>
<body>
  <div class="card">
    <h1>aio</h1>
    <form id="f">
      <input id="addr" type="text" placeholder="server address or share link" autofocus spellcheck="false" />
      <button type="submit">Connect</button>
    </form>
    <div id="err"></div>
    <div style="margin-top:.8rem;font-size:.8rem;color:#888">
      A keyed server needs its full share link (the <code>?token=…</code> URL
      the server prints at boot / <code>am pair</code>) — a bare address will
      be refused.
    </div>
  </div>
  <script>
    var baked=${JSON.stringify(bakedServer ?? "")};
    var s=localStorage.getItem('aio_server')||baked;
    if(s)document.getElementById('addr').value=s;
    // Straight in on a fresh install: the build knew the address, so the first
    // launch should not be a form. Only when the user has never chosen one —
    // a stored choice, including a deliberate change, always wins.
    if(baked&&!localStorage.getItem('aio_server')){localStorage.setItem('aio_server',baked);location.href=baked;}
    document.getElementById('f').onsubmit=function(e){
      e.preventDefault();
      var v=document.getElementById('addr').value.trim();
      if(!v)return;
      if(v.indexOf('http://')!==0&&v.indexOf('https://')!==0)v='http://'+v;
      try{new URL(v)}catch(x){document.getElementById('err').textContent='Invalid URL';return}
      localStorage.setItem('aio_server',v);
      location.href=v;
    };
  </script>
</body>
</html>`;
  await Deno.writeTextFile(join(assetsDir, "index.html"), connectHtml);
  console.log(`[${tag}] \u2713 connect page`);
}

async function _writeLocalAssets(
  cfg: BuildConfig,
  assetsDir: string,
): Promise<void> {
  const { dist, appTitle, binaryName } = cfg;
  let hasCSS = false;
  try {
    await Deno.stat(join(dist, APP_STYLE));
    hasCSS = true;
  } catch { /* no css — skip */ }
  // ONE shell decider — see androidLocalHTML: a hand-rolled copy here shipped
  // a different default viewport than every other target (WYSIDIWYSIP).
  // Raw title: androidLocalHTML escapes it itself (escHtml in headContent).
  // The packaged APK's shell renders the same default dev does, keyed on the
  // same identity — an app that is one colour on the desktop and another on
  // the phone is not one app. `ui.theme` is set in code, which a build cannot
  // read, so the shell carries BOTH: the inert tokens (active) and the full
  // look (disabled), and `_applyShellUi` in the standalone runtime enables the
  // second one when the app asked for it.
  const androidHtml = androidLocalHTML(appTitle ?? binaryName, hasCSS, {
    themeName: binaryName,
  });
  // Never a silent drop (.katana/core.md): the packaged shell is written before
  // `aio.run()` exists, so the `<head>` keys set in code cannot reach it. Two
  // of them now travel with the bundle instead (`ui.theme` as a disabled sheet
  // the standalone runtime enables, `ui.lang` set at boot); the rest cannot,
  // and a build that quietly stops being the app the config describes is the
  // bug this line exists to prevent.
  console.log(
    "[android] note: the packaged shell is built before aio.run() runs — " +
      "ui.head, ui.viewport and ui.showStatus cannot reach it " +
      "(ui.theme and ui.lang do, applied at boot). " +
      "Use --android --remote if your app depends on them.",
  );
  await Deno.copyFile(join(dist, BUNDLE_JS), join(assetsDir, BUNDLE_JS));
  await Deno.writeTextFile(join(assetsDir, "index.html"), androidHtml);
  if (hasCSS) {
    await Deno.copyFile(
      join(dist, APP_STYLE),
      join(assetsDir, APP_STYLE),
    );
  }
  console.log("[android] \u2713 assets copied");
}

/** dev:android — retarget the WebView at a live dev-server URL (10.0.2.2:PORT
 *  reaches the host loopback from the emulator) and allow cleartext http so the
 *  app hot-loads from the running dev server, exactly like `dev:browser`. */
/** Validate `--android-dev-url` and return the form safe to embed in Kotlin.
 *
 *  The value is interpolated into Kotlin SOURCE that is then compiled, so it
 *  has to be a URL and nothing else: one carrying a quote closed the string and
 *  the rest compiled as code — `--android-dev-url='http://x");
 *  Runtime.getRuntime().exec("…"); //'` ran a command at BUILD time.
 *  Parsing is the check; `href` is the normalised, percent-encoded form, so no
 *  quote or newline can survive it. Refuses loudly rather than emitting broken
 *  or hostile Kotlin. Exported for its own test. */
/** THE APK label: the name the artifact is written under AND the label its
 *  applicationId is derived from — one decider, so the file on disk and the
 *  package installed on the device can never disagree.
 *
 *  A dev APK is NOT the shippable one: it points its WebView at a cleartext
 *  localhost dev server. It used to be written as `<binaryName>.apk`, the exact
 *  filename `compile:android` ships, so the two were indistinguishable on disk
 *  and a dev build silently overwrote (and could be released as) the real APK.
 *  Its own name gives it its own applicationId too, so it also installs
 *  alongside the real app instead of replacing it. Same reasoning for the
 *  remote client, which is a different program from the local app. */
export function apkLabel(
  cfg: { binaryName: string; doRemote: boolean; androidDevUrl?: string },
): string {
  if (cfg.androidDevUrl) return `${cfg.binaryName}-dev`;
  return cfg.doRemote ? `${cfg.binaryName}-client` : cfg.binaryName;
}

/** THE applicationId rule: an explicit `android.applicationId` from deno.json
 *  when present, else `app.aio.<label sans non-alphanumerics>`; null when
 *  neither can make a valid id.
 *
 *  Shared by the build (from {@link apkLabel}) and `dev:android` (from the
 *  APK's filename, which IS that label) — one rule, or the installed dev app
 *  and the built APK disagree on identity.
 *
 *  The explicit form exists because an applicationId is a PUBLIC, permanent
 *  identity on Android: it is the Play Store listing's primary key and can
 *  never be changed for a published app. `app.aio.*` is aio's namespace, not
 *  the app author's, so a derived-only id meant no aio app could ship to Play
 *  under its own name. Validated, not trusted: Android requires at least two
 *  dot-separated segments, each starting with a letter, or the install fails
 *  with a manifest error nobody can read. */
export function androidApplicationId(
  label: string,
  explicit?: string,
): string | null {
  if (explicit !== undefined) {
    return isValidApplicationId(explicit) ? explicit : null;
  }
  const sanitized = label.replace(/[^a-z0-9]/g, "");
  if (!sanitized || !/^[a-z]/.test(sanitized)) return null;
  return `app.aio.${sanitized}`;
}

/** Android's own rule for a package name: ≥2 segments, each starting with a
 *  letter and made of letters/digits/underscore. Java keywords are also
 *  rejected by the toolchain, but the shapes below are what people actually
 *  get wrong (a single segment, a leading digit, a trailing dot). */
export function isValidApplicationId(id: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(id)) {
    return false;
  }
  return id.length <= 255;
}

export function safeDevUrl(devUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(devUrl);
  } catch {
    throw new Error(
      `[aio] --android-dev-url is not a valid URL: ${JSON.stringify(devUrl)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `[aio] --android-dev-url must be http(s), got ${parsed.protocol}`,
    );
  }
  return parsed.href;
}

async function _applyDevUrl(androidDir: string, devUrl: string): Promise<void> {
  const actPath = join(
    androidDir,
    "app/src/main/java/aio/app/MainActivity.kt",
  );
  const safeUrl = safeDevUrl(devUrl);
  let act = await Deno.readTextFile(actPath);
  act = act.replace(
    'loadUrl("https://appassets.androidplatform.net/assets/index.html")',
    `loadUrl("${safeUrl}")`,
  );
  // Keep every navigation inside the WebView (no external redirect handling).
  act = act.replace(
    'return !url.startsWith("https://appassets.androidplatform.net/")',
    "return false",
  );
  await Deno.writeTextFile(actPath, act);
  // Cleartext is NOT patched in here — see `_cleartextAttr`, which decides it
  // for the dev build and the remote client alike, at placeholder time.
}

/** Force Gradle onto the resolved JDK(s) so its toolchain resolver can only pick
 *  a real, compiler-capable JDK — never a JRE dir it mis-detects. Writes into the
 *  generated gradle.properties (explicit installation paths + no auto-download)
 *  and requests a toolchain of the chosen JDK's exact version in app/build.gradle. */
async function _pinJdk(androidDir: string, jdk: JdkResult): Promise<void> {
  const propsPath = join(androidDir, "gradle.properties");
  // .properties values escape backslashes (Windows paths); commas separate.
  const paths = jdk.all.map((p) => p.replace(/\\/g, "\\\\")).join(",");
  const props = await Deno.readTextFile(propsPath);
  await Deno.writeTextFile(
    propsPath,
    `${props}\n# aio: use only real, compiler-capable JDKs (see findJdk)\n` +
      `org.gradle.java.installations.paths=${paths}\n` +
      `org.gradle.java.installations.auto-download=false\n`,
  );

  // Bind the Java compile task to a toolchain of our JDK's version — matched
  // from the installation paths above (auto-download off), so it's deterministic.
  const gradlePath = join(androidDir, "app", "build.gradle.kts");
  const gradle = await Deno.readTextFile(gradlePath);
  await Deno.writeTextFile(
    gradlePath,
    `${gradle}\njava {\n    toolchain {\n` +
      `        languageVersion = JavaLanguageVersion.of(${jdk.major})\n` +
      `    }\n}\n`,
  );
}

async function _runGradle(
  cfg: BuildConfig,
  androidDir: string,
  androidHome: string,
  jdkHome: string,
  appNameKotlin: string,
  doRelease: boolean,
): Promise<void> {
  void appNameKotlin;
  const gradleBin = findGradle();
  if (!gradleBin) {
    console.error(
      "[android] \u2717 gradle not found — install Gradle and ensure it's on PATH or in a standard location",
    );
    console.error(
      "  checked: PATH, /usr/bin, /usr/local/bin, /snap/bin, /opt/gradle/bin, ~/.sdkman/",
    );
    Deno.exit(1);
  }

  const gradleEnv = {
    ...Deno.env.toObject(),
    ANDROID_HOME: androidHome,
    JAVA_HOME: jdkHome, // resolved + compile-verified by findJdk()
  };

  // Generate gradle wrapper — pins version for reproducible builds. 8.14.3
  // (AGP 8.7.x needs 8.9+): 8.12.1 mis-detected Ubuntu's OpenJDK as a JRE
  // ("Is JDK: false" → "[JAVA_COMPILER]" toolchain error); fixed in 8.13+.
  console.log(`[android] generating gradle wrapper (using ${gradleBin})...`);
  const wrapperResult = await new Deno.Command(gradleBin, {
    args: ["wrapper", "--gradle-version", "8.14.3"],
    cwd: androidDir,
    stdout: "piped",
    stderr: "inherit",
    env: gradleEnv,
  }).output();

  if (wrapperResult.code !== 0) {
    console.error("[android] \u2717 gradle wrapper generation failed");
    Deno.exit(1);
  }

  const gradlew = join(androidDir, "gradlew");
  await chmodIfSupported(gradlew, 0o755);
  console.log("[android] \u2713 gradle wrapper (pinned 8.14.3)");

  // Build APK using wrapper
  const gradleTask = doRelease ? "assembleRelease" : "assembleDebug";
  console.log(`[android] ./gradlew ${gradleTask}...`);
  const gradleResult = await new Deno.Command(gradlew, {
    args: [gradleTask],
    cwd: androidDir,
    stdout: "inherit",
    stderr: "inherit",
    env: gradleEnv,
  }).output();

  if (gradleResult.code !== 0) {
    console.error("[android] \u2717 gradle build failed");
    Deno.exit(1);
  }

  // Copy APK to project root.
  const outputsDir = join(
    androidDir,
    "app/build/outputs/apk",
    doRelease ? "release" : "debug",
  );
  let present: string[] = [];
  try {
    present = [...Deno.readDirSync(outputsDir)].map((e) => e.name);
  } catch { /* no outputs dir at all */ }
  const built = apkArtifact(present, doRelease);
  if (!built) {
    console.error(
      `[android] \u2717 gradle reported success but wrote no APK in ` +
        `${outputsDir}${
          present.length ? ` (found: ${present.join(", ")})` : ""
        }`,
    );
    Deno.exit(1);
  }
  const label = apkLabel(cfg);
  await Deno.mkdir(cfg.outDir ?? cfg.root, { recursive: true });
  const apkDst = join(cfg.outDir ?? cfg.root, `${label}${built.suffix}.apk`);
  await Deno.copyFile(join(outputsDir, built.file), apkDst);
  const apkStat = await Deno.stat(apkDst);
  const apkMb = (apkStat.size / 1024 / 1024).toFixed(1);
  console.log(`[android] \u2713 ${label}${built.suffix}.apk (${apkMb} MB)`);
  if (built.suffix) {
    console.log(
      `\n  This APK is UNSIGNED \u2014 Android will refuse to install it as is.\n` +
        `  aio does not hold your release key. Sign it yourself:\n` +
        `    zipalign -p -f 4 ${label}-unsigned.apk ${label}.apk\n` +
        `    apksigner sign --ks <your.keystore> ${label}.apk\n`,
    );
  }
}

/** Which file gradle actually wrote, and the suffix its SIGNING STATE earns in
 *  the artifact's name. `null` when the variant produced no APK at all.
 *
 *  `assembleDebug` always emits `app-debug.apk`, signed with the debug keystore.
 *  `assembleRelease` emits `app-release.apk` ONLY when the release variant
 *  declares a `signingConfig`; the generated Gradle project declares none, so
 *  AGP writes `app-release-unsigned.apk` instead. The build copied
 *  `app-release.apk` unconditionally: `--release` (a documented flag) spent a
 *  full Gradle run, printed BUILD SUCCESSFUL, then died with an uncaught
 *  `NotFound` and left no APK anywhere the user would look.
 *
 *  An unsigned APK is a real artifact \u2014 it just cannot be installed \u2014 so it is
 *  produced under a name that SAYS so, never under the installable one. Pure, so
 *  the whole table is a unit test instead of a claim about a code path that only
 *  runs after a real Gradle build. */
export function apkArtifact(
  outputs: readonly string[],
  doRelease: boolean,
): { file: string; suffix: "" | "-unsigned" } | null {
  const signed = doRelease ? "app-release.apk" : "app-debug.apk";
  if (outputs.includes(signed)) return { file: signed, suffix: "" };
  if (doRelease && outputs.includes("app-release-unsigned.apk")) {
    return { file: "app-release-unsigned.apk", suffix: "-unsigned" };
  }
  return null;
}
