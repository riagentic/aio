/**
 * @module
 * Build Android — generates Android project from template, builds APK via Gradle.
 */
import { dirname, join, resolve } from "@std/path";
import { assetMounts } from "./build-compile.ts";
import {
  isProtectedPath,
  isServerOnlySource,
  realPathInside,
} from "../server/server-static.ts";
import { readDenoJson } from "../server/deno-json.ts";
import {
  chmodIfSupported,
  findGradle,
  findJdk,
  GRADLE_MAX_JDK,
  gradlewPath,
  type JdkResult,
  misplacedIconHint,
  resolveAppIcon,
  resolveSdk,
} from "./build-helpers.ts";
import { ANDROID_TEMPLATE } from "./android-template.ts";
import {
  androidRunOptionsWarning,
  bakedRunOptionsScript,
  type ProbedRunOptions,
  probeRunOptions,
  scanRunOptions,
} from "./android-run-options.ts";
import { warn } from "./build-say.ts";
import { copyWorkerBundles } from "./dist-staging.ts";
import { ESBUILD_SPEC } from "./esbuild-shared.ts";
import {
  androidLocalHTML,
  htmlOpen,
  oldEngineNotice,
} from "../server/server-html-gen.ts";
import type { BuildConfig } from "./build-config.ts";
import { type BuildVersion, stripVersionToken } from "./build-version.ts";
import { appIconLabel, appIconPng } from "./app-icon.ts";
import {
  APP_STYLE,
  BUILD_SCRATCH_DIR,
  BUNDLE_JS,
} from "../server/app-files.ts";
import { HEY, NO, OK } from "../diagnostics/fmt.ts";
import { count } from "../diagnostics/fmt.ts";

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
      `${NO} version ${version.version} does not fit an Android ` +
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
  const { binaryName, appTitle, doRemote, doRelease } = cfg;

  const androidHome = resolveSdk(); // ANDROID_HOME, its Sdk subdir, or defaults
  if (!androidHome) {
    console.error(
      `${NO} ANDROID_HOME not set — install Android SDK and set ANDROID_HOME`,
    );
    Deno.exit(1);
  }

  // Resolve a JDK Gradle will actually accept: canonical path, compile-verified
  // (a JRE fails), major <= GRADLE_MAX_JDK (Gradle can't run on a newer one).
  // Fail loud, naming the reason, when the machine has none.
  const jdk = findJdk();
  if (!jdk.home) {
    console.error(
      `${NO} no usable JDK found — Android builds need a real JDK ` +
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
  console.log(`${OK} JDK ${jdk.home} (Java ${jdk.major})`);

  const androidDir = join(cfg.root, BUILD_SCRATCH_DIR, "android");
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
      `${OK} overlay: ${count(overlaid.length, "file")} from android/`,
    );
    for (const f of overlaid) console.log(`  \u00b7 ${f}`);
  }

  // Derive application ID from THE APK label (see apkLabel /
  // androidApplicationId below) — dev:android derives the same id from the
  // APK's filename, so both must share the rule or drift.
  const label = apkLabel(cfg);
  const applicationId = androidApplicationId(label, cfg.androidApplicationId);
  if (!applicationId) {
    console.error(
      cfg.androidApplicationId !== undefined
        ? `${NO} android.applicationId ${
          JSON.stringify(cfg.androidApplicationId)
        } is not a valid Android package name — it needs at least two ` +
          `dot-separated segments, each starting with a letter ` +
          `(e.g. "com.example.wallet")`
        : `${NO} APK name "${label}" produces invalid applicationId — must start with a letter`,
    );
    Deno.exit(1);
  }
  const appNameKotlin = _appNameKotlin(appTitle ?? binaryName);
  const appNameXml = _appNameXml(appTitle ?? binaryName);

  // Check for user icon — from THE app-dir decider (cfg.appDir)
  const { icon: iconPath, misplaced: misplacedIcon } = await resolveAppIcon(
    cfg.root,
    cfg.appDir,
  );
  const hasIcon = iconPath !== null;
  if (misplacedIcon) {
    console.warn(
      `${HEY} ${misplacedIconHint(misplacedIcon, cfg.appDir)}`,
    );
  }

  // Replace placeholders in template files
  // The APK's declared version — from deno.json, the app's ONE identity file.
  const appVersion = androidVersion(cfg.version);
  console.log(
    `version ${appVersion.name} (versionCode ${appVersion.code})`,
  );

  const xmlFiles = new Set(["app/src/main/AndroidManifest.xml"]);
  const templateFiles = [
    "app/build.gradle.kts",
    "build.gradle.kts",
    "settings.gradle.kts",
    "app/src/main/AndroidManifest.xml",
    MAIN_ACTIVITY,
  ];
  const serverOpts = { devUrl: cfg.androidDevUrl, remote: doRemote };
  // `_fillTemplate` — every substitution is a function, never a string; see
  // its own comment for what a `$` in a title used to do here.
  for (const f of templateFiles) {
    const path = join(androidDir, f);
    const content = await Deno.readTextFile(path);
    await Deno.writeTextFile(
      path,
      _fillTemplate(content, {
        "{{APPLICATION_ID}}": applicationId,
        "{{VERSION_CODE}}": String(appVersion.code),
        "{{VERSION_NAME}}": appVersion.name,
        "{{APP_NAME}}": xmlFiles.has(f) ? appNameXml : appNameKotlin,
        "{{ICON_ATTR}}": 'android:icon="@mipmap/ic_launcher"',
        "{{CLEARTEXT_ATTR}}": _cleartextAttr(serverOpts),
        "{{TALKS_TO_SERVER}}": String(talksToServer(serverOpts)),
        "{{IS_CLIENT}}": String(doRemote && !cfg.androidDevUrl),
        // ONE decider for the camera, spent in both places it has to agree:
        // the manifest's declaration and the WebView's refusal message.
        "{{CAMERA_PERMISSION}}": _cameraPermission(cfg.androidCamera),
        "{{CAMERA_DECLARED}}": String(cfg.androidCamera === true),
        "{{APP_THEME}}": _appTheme(cfg.androidColorScheme),
      }),
    );
  }

  // An app's own MainActivity.kt replaces the template's WHOLE — including the
  // durable store and the SDK-35 insets frame. Say what it dropped, loudly:
  // the store's loss is a change lost on the next kill, with nothing said.
  // With deno.json `build.android.strict` each loss is an error and no APK is
  // built — see `_androidStrict`.
  const strict = _androidStrict((await readDenoJson(cfg.root))?.config);
  if (strict === null) {
    console.error(
      `${NO} deno.json build.android.strict must be true or false — it ` +
        `decides whether an android/ overlay that drops part of the ` +
        `template's MainActivity.kt fails the build`,
    );
    Deno.exit(1);
  }
  if (overlaid.includes(MAIN_ACTIVITY)) {
    const losses = await ownActivityWarnings(androidDir, overlaid, {
      standalone: !talksToServer(serverOpts),
    });
    const refusal = ownActivityRefusal(losses, strict);
    for (const w of losses) {
      if (refusal) console.error(`${NO} ${w}`);
      else console.warn(`${HEY} ${w}`);
    }
    if (refusal) {
      console.error(`${NO} ${refusal}`);
      Deno.exit(1);
    }
  }

  // Pin Gradle to the resolved JDK so its toolchain resolver can't wander off to
  // a JRE it mis-detected — the root of the "[JAVA_COMPILER]" toolchain error.
  await _pinJdk(androidDir, jdk);

  console.log(`app: ${appNameKotlin} (${applicationId})`);

  if (cfg.androidDevUrl) {
    // dev:android — point the WebView at the LIVE dev server, no bundled assets.
    await _applyDevUrl(
      androidDir,
      cfg.androidDevUrl,
      overlaid.includes(MAIN_ACTIVITY),
    );
    console.log(`${OK} dev build → ${cfg.androidDevUrl}`);
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
    console.log(`${OK} icon from ${iconPath}`);
  } else {
    const label = appIconLabel(appTitle, binaryName);
    await Deno.writeFile(
      join(mipmapDir, "ic_launcher.png"),
      await appIconPng(label, 192, binaryName),
    );
    console.log(`${OK} default icon for "${label}"`);
  }

  // The release key is the user's: named by the environment, never held here.
  const signing = androidSigning(Deno.env.toObject(), cfg.root);
  if (signing && "refused" in signing) {
    console.error(`${NO} ${signing.refused}`);
    Deno.exit(1);
  }
  if (signing && !doRelease) {
    console.warn(
      `${HEY} ${KEYSTORE_ENV} is set, but this is a debug build — it is ` +
        `signed with Android's debug key. Add --release to sign with yours.`,
    );
  }
  const signed = signing && doRelease ? signing : null;
  if (signed) await _declareSigning(androidDir);

  await _runGradle(
    cfg,
    androidDir,
    androidHome,
    jdk.home,
    appNameKotlin,
    doRelease,
    signed,
  );
  Deno.exit(0);
}

/** The environment a signed release build reads. Passwords are read from the
 *  environment by Gradle itself (`_declareSigning`) — never written to a file,
 *  a log, or deno.json. */
export const KEYSTORE_ENV = "AIO_ANDROID_KEYSTORE";
const KEYSTORE_PASSWORD_ENV = "AIO_ANDROID_KEYSTORE_PASSWORD";
const KEY_ALIAS_ENV = "AIO_ANDROID_KEY_ALIAS";
const KEY_PASSWORD_ENV = "AIO_ANDROID_KEY_PASSWORD";

/** The user's release keystore, as the environment names it: `null` when no
 *  keystore is named (the build then signs nothing, exactly as before),
 *  `refused` when one is named but cannot be used — said before Gradle runs,
 *  not as a stack trace from inside it. A relative path is the app root's. */
export function androidSigning(
  env: Record<string, string | undefined>,
  root: string,
  isFile = (p: string): boolean => {
    try {
      return Deno.statSync(p).isFile;
    } catch {
      // aio-ok: absent or unreadable is the answer — the caller refuses by name.
      return false;
    }
  },
): { keystore: string } | { refused: string } | null {
  const named = env[KEYSTORE_ENV];
  if (!named) return null;
  const keystore = resolve(root, named);
  if (!isFile(keystore)) {
    return {
      refused: `${KEYSTORE_ENV}=${named} — no keystore file at ${keystore}`,
    };
  }
  const missing = [KEYSTORE_PASSWORD_ENV, KEY_ALIAS_ENV].filter((k) => !env[k]);
  if (missing.length) {
    return {
      refused: `${KEYSTORE_ENV} is set but ${missing.join(" and ")} ` +
        `${missing.length > 1 ? "are" : "is"} not — a release is signed with ` +
        `the keystore, its password and the key's alias ` +
        `(${KEY_PASSWORD_ENV} when the key has its own password)`,
    };
  }
  return { keystore };
}

/** Give the generated project's release variant a signing config that reads
 *  the keystore from the environment at Gradle time. Appended like `_pinJdk`'s
 *  toolchain block, so an app's own `android/app/build.gradle.kts` is signed
 *  the same way. A signed release is not debuggable (AGP's release default). */
async function _declareSigning(androidDir: string): Promise<void> {
  const gradlePath = join(androidDir, "app", "build.gradle.kts");
  await Deno.writeTextFile(
    gradlePath,
    `
android {
    signingConfigs {
        create("aioRelease") {
            storeFile = file(System.getenv("${KEYSTORE_ENV}"))
            storePassword = System.getenv("${KEYSTORE_PASSWORD_ENV}")
            keyAlias = System.getenv("${KEY_ALIAS_ENV}")
            keyPassword = System.getenv("${KEY_PASSWORD_ENV}")
                ?: System.getenv("${KEYSTORE_PASSWORD_ENV}")
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("aioRelease")
        }
    }
}
`,
    { append: true },
  );
}

/** Does this APK need to talk to a plaintext `http://` / `ws://` server?
 *
 *  Android blocks cleartext by default from targetSdk 28 (this template is 35),
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
  return talksToServer(opts) ? 'android:usesCleartextTraffic="true"' : "";
}

/** The activity theme for deno.json `android.colorScheme` — it is what a
 *  WebView reads `prefers-color-scheme` from. Pure. */
export function _appTheme(scheme: "system" | "dark" | "light"): string {
  return {
    system: "Theme.AppCompat.DayNight.NoActionBar",
    dark: "Theme.AppCompat.NoActionBar",
    light: "Theme.AppCompat.Light.NoActionBar",
  }[scheme];
}

/** The manifest's camera declaration — deno.json `android: { "camera": true }`,
 *  and nothing otherwise.
 *
 *  It used to be unconditional, with a comment about QR scanning: EVERY aio
 *  APK told its user it could use the camera, the install dialog and the app's
 *  Play listing said so, and the overwhelming majority never opened one. An
 *  over-permission is not a cosmetic issue — it is the single line a reviewer
 *  reads before deciding what an app is allowed to do.
 *
 *  Deleting it outright would have broken the apps that DO scan a code, in the
 *  worst available way: `getUserMedia` denied by the OS, the page seeing a bare
 *  `NotAllowedError`, nothing anywhere saying which permission was missing. So
 *  the declaration is opt-in and the SAME flag reaches MainActivity.kt
 *  (`CAMERA_DECLARED`), which logs the exact key to add when a page asks for a
 *  camera this APK cannot give it. One decider, both halves. Pure.
 *
 *  BOTH camera features are declared `required="false"`, and that is measured,
 *  not assumed: requesting CAMERA makes Android IMPLY
 *  `uses-feature android.hardware.camera`, REQUIRED, and declaring only
 *  `camera.any` does not suppress it — `aapt2 dump badging` on a real APK built
 *  from this template said so
 *  (`uses-implied-feature … reason='requested android.permission.CAMERA
 *  permission'`). The template had carried the one-line form with a comment
 *  promising that "install stays possible on camera-less devices"; it did not.
 *  tests/build-android-camera.test.ts links both shapes with aapt2. */
export function _cameraPermission(camera: boolean | undefined): string {
  if (camera !== true) return "";
  return '<!-- Camera: opt-in, from deno.json `android: { "camera": true }` —\n' +
    "       a page that scans QR codes (getUserMedia in the WebView).\n" +
    "       BOTH features are optional, so the app still installs on a\n" +
    "       device without a camera: requesting the permission implies a\n" +
    "       REQUIRED android.hardware.camera unless it is declared here. -->\n" +
    '  <uses-permission android:name="android.permission.CAMERA" />\n' +
    '  <uses-feature android:name="android.hardware.camera" android:required="false" />\n' +
    '  <uses-feature android:name="android.hardware.camera.any" android:required="false" />';
}

/** THE decider for "this APK's app lives on a server" — a dev build or a
 *  client. It drives BOTH the manifest's cleartext attribute and the WebView's
 *  navigation rule (`TALKS_TO_SERVER` in MainActivity.kt). The navigation rule
 *  used to be switched off by the dev rewrite alone, so the client APK kept
 *  the standalone rule and could never leave its connect page — the same
 *  second-decider shape the cleartext comment above records, once more. */
function talksToServer(opts: { devUrl?: string | null; remote?: boolean }) {
  return Boolean(opts.devUrl || opts.remote);
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
  /** Which shell opens the page. The texts differ because the shells do: the
   *  Android one pairs by code (the `AioConnect` bridge) and can pin a
   *  self-signed certificate; the iOS one has no bridge — a share link is its
   *  only way to a keyed server, and it trusts what iOS trusts. */
  shell: "android" | "ios" = "android",
): Promise<void> {
  const ios = shell === "ios";
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
${
    ios
      ? ""
      : `      <input id="pin" type="text" inputmode="numeric" autocomplete="off" placeholder="pairing code (a keyed server)" />\n`
  }      <button type="submit">Connect</button>
    </form>
    <div id="err"></div>
    <div id="warn" style="margin-top:.8rem;font-size:.85rem;color:#fa3"></div>
    <div style="margin-top:.8rem;font-size:.8rem;color:#888">
${
    ios
      ? `      A keyed server needs its full share link (the
      <code>?token=…</code> URL the server prints at boot) — a bare address
      will be refused.`
      : `      A keyed server needs its pairing code (the server prints one at boot;
      <code>am pair</code> mints a new one) or its full share link (the
      <code>?token=…</code> URL) — a bare address will be refused.`
  }
    </div>
  </div>
  <script>
    var baked=${JSON.stringify(bakedServer ?? "")};
    var s=localStorage.getItem('aio_server')||baked;
    if(s)document.getElementById('addr').value=s;
    // Straight in on EVERY launch that has an address — the baked one on a
    // fresh install, else the user's stored choice (a deliberate change always
    // wins). It used to go straight in on the first launch only, so every
    // later launch of an installed client stopped on this form. \`#change\`
    // (what Back from the server opens) stays on the form, to change it.
    if(baked&&!localStorage.getItem('aio_server'))localStorage.setItem('aio_server',baked);
    // What a failed connect says. The shell sends it here by HASH — and when
    // this form is already the page showing, that is no reload: a tap on
    // Connect to a dead server changed nothing on screen. Said on load and
    // on every hash change.
    function why(){
      var a=localStorage.getItem('aio_server')||baked;
      try{a=new URL(a).origin}catch(x){}
      if(location.hash==='#unreachable')return 'Could not reach '+a+' — is the server running? Change the address, or Connect to retry.';
${
    ios
      ? `      if(location.hash==='#keyed')return a+' needs its key. Paste its share link (the ?token=… URL the server prints at boot).';
      if(location.hash==='#untrusted')return 'This device does not trust the certificate of '+a+' — a server run with --expose signs its own, and this app cannot pin it. Give the server a real certificate (tls: { cert, key }), or serve it with --no-tls on a network you trust.';`
      : `      if(location.hash==='#keyed')return a+' needs its key. Enter the pairing code the server shows (am pair mints a new one), or paste its share link.';
      if(location.hash==='#untrusted')return 'This device does not trust the certificate of '+a+' — a server run with --expose signs its own. Enter its pairing code or paste its share link (either one pins that certificate), or give the server a real certificate (tls: { cert, key }).';
      if(location.hash==='#changed')return 'The certificate of '+a+' is not the one this device paired with. If the server was reinstalled, pair again: its pairing code, or its share link. Otherwise something else is answering at that address.';`
  }
      return '';
    }
    var err=document.getElementById('err');
    window.onhashchange=function(){err.textContent=why()};
    // The native side of pairing (AioConnect in MainActivity.kt): one
    // question, one answer, matched by id.
    var seq=0,waiting={},native=typeof AioConnect==='object'?AioConnect:null;
    if(native)native.onmessage=function(e){var r=JSON.parse(e.data),f=waiting[r.id];delete waiting[r.id];if(f)f(r)};
    function ask(m){return new Promise(function(done){
      if(!native){done({error:${
    ios
      ? "'this app pairs by share link only — paste the ?token=… URL'"
      : "'this WebView cannot pair — update Android System WebView'"
  }});return}
      m.id=++seq;waiting[m.id]=done;native.postMessage(JSON.stringify(m));
    })}
    if(why())err.textContent=why();
    function enter(){
      if(why())err.textContent=why();
      else if(s&&location.hash!=='#change')location.href=s;
    }
    // localStorage reaches the disk when the WebView gets to it: a kill
    // within a second of pairing brought the app back WITHOUT the pairing
    // (and a pairing code works once). So the shell keeps the address too,
    // durably — asked first on every load, and what it holds wins. A shell
    // without the answer (no bridge, an older MainActivity.kt) changes
    // nothing: the stored address, as before. An answer that arrives after
    // a Connect is dropped: the form has already gone somewhere newer.
    var gone=0;
    if(native)ask({recall:1}).then(function(r){
      if(gone)return;
      if(r.server){s=r.server;localStorage.setItem('aio_server',s);document.getElementById('addr').value=s;warn()}
      enter();
    });else enter();
    // The hash is dropped first: a refusal comes back as a hash, and the one
    // already showing would be no change — the form kept its old line. The
    // server is opened once the shell holds the address (see above).
    function go(v){
      gone=1;localStorage.setItem('aio_server',v);history.replaceState(null,'',location.pathname);
      if(native)ask({remember:v}).then(function(){location.href=v});else location.href=v;
    }
    // A pairing code: the server answers it with its key (and, over TLS, the
    // certificate this device then trusts for it). An address typed without
    // a scheme is tried over https first — what --expose serves — then http.
    function pair(bases,pin,i){
      if(i>=bases.length){err.textContent='Could not reach '+bases[0]+' — is the server running?';return}
      ask({base:bases[i],pin:pin}).then(function(r){
        if(r.key)go(bases[i]+'/?token='+encodeURIComponent(r.key));
        else if(r.status===401)err.textContent='Invalid or expired pairing code — a code works once, for a few minutes. Run am pair on the server for a new one.';
        else if(r.status===429)err.textContent='Too many wrong codes from this device — wait a minute, then pair with a new code.';
        else if(r.status)err.textContent='Pairing failed: '+bases[i]+' answered HTTP '+r.status+' — is it a keyed aio server?';
        else if(i+1<bases.length)pair(bases,pin,i+1);
        else err.textContent='Pairing failed: '+r.error;
      });
    }
    // The address as it will be opened. Typed without a scheme it is http —
    // unless it carries a key (?token=): a share link is https unless it
    // says otherwise, and a key must not leave in clear text by default.
    function parse(v){
      var bare=v.indexOf('http://')!==0&&v.indexOf('https://')!==0,u=null;
      try{u=new URL(bare?'http://'+v:v);if(bare&&u.searchParams.get('token'))u=new URL('https://'+v)}catch(x){u=null}
      return {bare:bare,u:u};
    }
    // A keyed link over plain http to another machine: allowed (a keyed LAN
    // app served with --no-tls must keep working), and SAID — whoever shares
    // the network can read the key. Shown whenever such an address is in the
    // field: before Connect, and each time the form comes back.
    function warn(){
      var u=parse(document.getElementById('addr').value.trim()).u;
      var local=u&&/^(localhost|127\\.\\d+\\.\\d+\\.\\d+|\\[::1\\])$/.test(u.hostname);
      document.getElementById('warn').textContent=u&&u.protocol==='http:'&&u.searchParams.get('token')&&!local
        ?'This link sends the server\\'s key over plain http: anyone on the same network can read it. Use the https:// link if the server has one.':'';
    }
    document.getElementById('addr').oninput=warn;
    warn();
    document.getElementById('f').onsubmit=function(e){
      e.preventDefault();
      var v=document.getElementById('addr').value.trim(),pin=${
    ios ? "''" : "document.getElementById('pin').value.trim()"
  };
      if(!v)return;
      var p=parse(v),bare=p.bare,u=p.u;
      if(!u){err.textContent='Invalid URL';return}
      err.textContent='';
      if(pin){pair(bare?['https://'+u.host,'http://'+u.host]:[u.origin],pin,0);return}
      // A share link over TLS: before the WebView meets the certificate, the
      // server proves it holds this link's key ON that certificate — which
      // is then the one trusted. No proof changes nothing: the load goes on
      // and a certificate Android does not trust is refused, as before.
      var key=u.searchParams.get('token');
      v=bare?u.protocol+'//'+v:v;
      if(u.protocol==='https:'&&key&&native)ask({base:u.origin,key:key}).then(function(){go(v)});
      else go(v);
    };
  </script>
</body>
</html>`;
  await Deno.writeTextFile(join(assetsDir, "index.html"), connectHtml);
  console.log(`${OK} connect page`);
}

/** Read what the app's entry passes to `aio.run()` (see
 *  android-run-options.ts) and warn, naming each option that still cannot
 *  reach a local APK. Returns what the build bakes into the shell — nothing
 *  when the entry could not be probed (the warning then says why). */
export async function _readRunOptions(
  cfg: Pick<BuildConfig, "root" | "configEntry">,
  shell: "apk" | "web" = "apk",
): Promise<{ ui: ProbedRunOptions["ui"]; script: string }> {
  let src: string;
  try {
    src = await Deno.readTextFile(join(cfg.root, cfg.configEntry));
  } catch {
    // aio-ok: no readable entry → nothing to scan; the bundle step owns that error.
    return { ui: {}, script: "" };
  }
  // An entry that passes nothing has nothing to bake: it is not run.
  const scan = scanRunOptions(src);
  if (!scan.found || (scan.keys.length === 0 && !scan.opaque)) {
    return { ui: {}, script: "" };
  }
  const probed = await probeRunOptions(cfg.root, cfg.configEntry);
  const w = androidRunOptionsWarning(src, cfg.configEntry, shell, probed);
  if (w) warn(w.headline, w.body, w.fix);
  if (typeof probed === "string") return { ui: {}, script: "" };
  const baked = [
    ...Object.keys(probed.options),
    ...Object.keys(probed.ui).map((k) => `ui.${k}`),
  ];
  if (baked.length) {
    console.log(`${OK} aio.run() options baked in: ${baked.join(", ")}`);
  }
  return { ui: probed.ui, script: bakedRunOptionsScript(probed.options) };
}

/** Where a standalone APK's page and its files live — MainActivity.kt's
 *  `ASSET_HOST`, served by its `shouldInterceptRequest` and by nothing else. */
export const APK_ASSETS = "https://appassets.androidplatform.net/assets/";

/** What a worker bundle starts with in an APK. Forced by the platform:
 *  WebView 133 and later fetches the script of a worker STARTED BY A WORKER
 *  in its browser process, past `shouldInterceptRequest` — the asset origin's
 *  only server — so that worker never starts (measured: `net::ERR_ABORTED`,
 *  for every script URL). A worker's own `import` / `importScripts` are still
 *  intercepted, so a worker a worker starts is a same-origin Blob that loads
 *  the real script. Its `self.location` is then the Blob's; `import.meta.url`
 *  is the script's (see `_apkWorkers` for a classic one). A `blob:`/`data:`
 *  script starts as it always did. `url` is the bundle's own. Pure. */
export function _apkWorkerPrelude(url: string): string {
  return `(()=>{const W=self.Worker;if(!W)return;` +
    `self.Worker=class extends W{constructor(u,o){` +
    `const h=new URL(u,${JSON.stringify(url)}).href,s=JSON.stringify(h);` +
    `super(/^https?:/.test(h)?URL.createObjectURL(new Blob([` +
    `o&&o.type==="module"?"import "+s:"importScripts("+s+")"` +
    `],{type:"text/javascript"})):u,o)}}})();`;
}

/** Give each worker bundle staged in `assetsDir` its `_apkWorkerPrelude`, and
 *  its own URL where it reads `self.location.href` — which is what
 *  `import.meta.url` is in a classic worker's bundle, and a Blob's in a worker
 *  a worker started. Exported for its test. */
export async function _apkWorkers(
  assetsDir: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  const esbuild = await import(ESBUILD_SPEC);
  for (const name of names) {
    const file = join(assetsDir, name);
    const url = APK_ASSETS + name;
    const r = await esbuild.transform(await Deno.readTextFile(file), {
      loader: "js",
      target: "esnext",
      minifyWhitespace: true,
      define: { "self.location.href": JSON.stringify(url) },
      banner: _apkWorkerPrelude(url),
    });
    await Deno.writeTextFile(file, r.code);
  }
}

/** Exported for its test only (the warning below). */
export async function _writeLocalAssets(
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
  // the phone is not one app.
  // Never a silent drop (.katana/core.md). The APK's bundle entry imports
  // only App.tsx (`makeEntryCode`) — the app's entry module never runs on the
  // phone — so the build reads its `aio.run()` options here and bakes them:
  // `ui.*` into this shell, the rest for the runtime's boot. This used to
  // claim "ui.theme, ui.layout, ui.dir and ui.lang do [reach it], applied at
  // boot" — false for every APK built before the options were baked. What
  // still cannot travel is named. With no `ui.theme` known the shell carries
  // BOTH the inert tokens (active) and the full look (disabled).
  const run = await _readRunOptions(cfg);
  const androidHtml = androidLocalHTML(appTitle ?? binaryName, hasCSS, {
    themeName: binaryName,
    ...run.ui,
    head: (run.ui.head ?? "") + run.script + oldEngineNotice("apk"),
  });
  await Deno.copyFile(join(dist, BUNDLE_JS), join(assetsDir, BUNDLE_JS));
  // …and the browser workers it starts, beside it (same origin, same path).
  await _apkWorkers(assetsDir, await copyWorkerBundles(dist, assetsDir));
  await Deno.writeTextFile(join(assetsDir, "index.html"), androidHtml);
  if (hasCSS) {
    await Deno.copyFile(
      join(dist, APP_STYLE),
      join(assetsDir, APP_STYLE),
    );
  }
  await _packAssetMounts(cfg.root, assetsDir);
  console.log(`${OK} assets copied`);
}

/** deno.json `assets` — the directories the app SERVES — packaged at the same
 *  path under the page, so ONE relative `fetch("text/a.md")` reads the mount
 *  on desktop and the packaged copy in a standalone APK (which has no server
 *  to serve the mount). What ships is what the PRODUCTION server would serve,
 *  asked of the server's own deciders — `isProtectedPath` (dotfiles,
 *  `*.server.*` in any case, all `.ts`/`.tsx`/`.jsx` source),
 *  `isServerOnlySource` (`import "aio/server-only"`) and `realPathInside`
 *  (a symlink stays inside its mount). Where the server would answer 403 — a
 *  link out of the mount — the build is refused, naming it, rather than
 *  copying the link's target into the APK. Exported for its test. */
export async function _packAssetMounts(
  root: string,
  assetsDir: string,
  into = "the APK",
): Promise<void> {
  const taken = new Set(["index.html", BUNDLE_JS, APP_STYLE]);
  for (const m of assetMounts((await readDenoJson(root))?.config, root)) {
    const at = m.prefix.replace(/^\/+|\/+$/g, "");
    // aio-ok: path-split — a URL mount prefix, not an OS path
    const segs = at.split("/");
    if (
      !at || taken.has(segs[0]!) ||
      segs.some((s) => s === "" || s === "." || s === "..")
    ) {
      throw new Error(
        `${NO} deno.json assets["${m.prefix}"] cannot be packaged into ` +
          `${into}: a mount must be a sub-path like "/text", and not one of ` +
          `${[...taken].join(", ")} — the page's own files live there.`,
      );
    }
    const src = join(root, m.rel);
    const refuse = (why: string) =>
      new Error(
        `${NO} deno.json assets["${m.prefix}"] cannot be ` +
          `packaged into ${into}: ${why}`,
      );
    if (await realPathInside(src, assetsDir)) {
      throw refuse(
        `it contains the build output (${assetsDir}), so packaging it would ` +
          `copy the build into itself. Point the mount at a directory that ` +
          `does not hold dist/.`,
      );
    }
    let n = 0;
    // `open`: the real paths of the directories being walked — a link back
    // to one of them is a loop the server can serve forever and a copy cannot.
    const pack = async (dir: string, url: string, open: Set<string>) => {
      for await (const e of Deno.readDir(dir)) {
        const path = join(dir, e.name);
        const href = `${url}/${e.name}`;
        // Nothing under this name is servable (a dot segment): skip it whole.
        if (isProtectedPath(`${href}/a`, true)) continue;
        if (e.isSymlink) {
          let inside: boolean;
          try {
            inside = await realPathInside(src, path);
          } catch (err) {
            throw refuse(
              `${path} is a symlink that cannot be followed (${err}).`,
            );
          }
          if (!inside) {
            throw refuse(
              `${path} is a symlink that leads outside the mount — the ` +
                `server refuses to serve it (403), so it must not ship ` +
                `either. Remove the link, or copy the file into the mount.`,
            );
          }
        }
        const st = await Deno.stat(path);
        if (st.isDirectory) {
          const real = await Deno.realPath(path);
          if (open.has(real)) {
            throw refuse(`${path} links back to a directory that holds it.`);
          }
          await pack(path, href, new Set([...open, real]));
          continue;
        }
        if (!st.isFile) throw refuse(`${path} is not a file or a directory.`);
        if (isProtectedPath(href, true)) continue;
        if (isServerOnlySource(path, () => Deno.readTextFileSync(path))) {
          continue;
        }
        const to = join(assetsDir, href);
        await Deno.mkdir(dirname(to), { recursive: true });
        await Deno.copyFile(path, to);
        n++;
      }
    };
    await pack(src, `/${at}`, new Set([await Deno.realPath(src)]));
    console.log(`${OK} assets["${m.prefix}"] → ${count(n, "file")} packaged`);
  }
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
/** The app's title, safe to paste into a Kotlin string literal.
 *
 *  @internal Exported so it can be tested without a toolchain. */
export function _appNameKotlin(title: string): string {
  return title
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\$/g, "\\$")
    .replace(/"/g, '\\"');
}

/** The app's title, safe to paste into an XML attribute.
 *
 *  It strips control characters too, exactly as the Kotlin spelling does. They
 *  are not legal XML at any escape, so a title carrying a BEL, a VT or a NUL
 *  produced an `AndroidManifest.xml` that is not well-formed — "not
 *  well-formed (invalid token)" from the parser, with nothing naming the
 *  title. Two deciders for one fact, four lines apart, and only one of them
 *  knew. (The iOS side's `plistText` already stripped them.)
 *
 *  U+FFFE and U+FFFF are not XML characters either (same parser error).
 *
 *  And an XML-safe value is not yet an ANDROID-safe one: aapt2 reads the
 *  attribute as a string resource. Measured with aapt2 36 (`dump xmltree`):
 *  `back\slash` became the label `backslash` (a backslash starts an escape,
 *  `\u0041` became `A`), and a title starting with `?` or `@` is a resource
 *  REFERENCE — `?quest` failed the link with "resource attr/quest not found".
 *  Both are escaped with a backslash, the resource syntax for a literal.
 *  Quotes and apostrophes survive an attribute verbatim, so they only get the
 *  XML escape.
 *
 *  @internal Exported so it can be tested without a toolchain. */
export function _appNameXml(title: string): string {
  return title
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f\uFFFE\uFFFF]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/^[?@]/, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fill a generated project file's `{{TOKEN}}`s.
 *
 *  EVERY replacement is a FUNCTION, not a string, and that is the whole point
 *  of this existing. `String.prototype.replaceAll` interprets `$$`, `$&`,
 *  `` $` `` and `$'` inside a STRING replacement — and the value substituted
 *  here is the app's own title. Measured:
 *
 *      "Cash $$ Register"  → android:label="Cash $ Register"   (silent)
 *      "Cost $& Saver"     → "Cost {{APP_NAME}}amp; Saver"
 *      "Cost $` Saver"     → 225 characters of the preceding file spliced in,
 *                            and a manifest that does not parse
 *
 *  The Kotlin escape writes `\$`, which FED the pattern — so escaping made it
 *  worse rather than better. A function replacement is not a pattern.
 *
 *  Whitespace INSIDE the braces is normalised first. The template is a normal
 *  source file, so a formatter (or a merge) may rewrite `{{APP_NAME}}` as
 *  `{{ APP_NAME }}` — and then the substitution matched nothing, the placeholder
 *  survived into `AndroidManifest.xml`, and `gradle` failed with an opaque
 *  `ManifestMerger2$MergeFailureException` (field report,
 *  a field report; an overlay was reformatted by "Format the tree").
 *  A formatter must never be able to break a build silently.
 *
 *  @internal Exported so it can be tested without a toolchain. */
export function _fillTemplate(
  content: string,
  subs: Record<string, string>,
): string {
  // `{{ APP_NAME }}`, `{{\tAPP_NAME\n}}` → `{{APP_NAME}}`, before any lookup.
  // Only `[A-Z_]` names are tokens, so `{{ somethingLowercase }}` is left
  // exactly as written.
  let out = content.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, "{{$1}}");
  for (const [token, value] of Object.entries(subs)) {
    out = out.replaceAll(token, () => value);
  }
  return out;
}

const MAIN_ACTIVITY = "app/src/main/java/aio/app/MainActivity.kt";

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

/** The applicationId a placed APK was built with, from its file name — for
 *  the callers that install and launch it (`dev:android`, `install:android`).
 *  The fleet names the APK `<label>-<version>.apk` (`myapp-0.1.3-dev.apk` was
 *  built as `myapp-dev`), and deno.json `android.applicationId` overrides the
 *  label exactly as it did in the build. Deriving it from the raw file name
 *  launched `app.aio.myapp013dev` — a package that is not installed. */
export function apkApplicationId(
  apkFile: string,
  explicit?: string,
): string | null {
  // aio-ok: path-split — `\\` normalised to `/` first
  const name = apkFile.replaceAll("\\", "/").split("/").pop() ?? apkFile;
  return androidApplicationId(
    stripVersionToken(name.replace(/\.apk$/, "")),
    explicit,
  );
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

/** What an app's own `android/…/MainActivity.kt` drops of the template's.
 *  Pure — `sources` is every Kotlin/Java file the overlay supplied, joined.
 *
 *  Field report (a remote-desktop app, §5): the overlay replaces the template's activity
 *  whole, and nothing said the page had fallen back to `localStorage` — which
 *  the template's own comment measured losing a change on a kill 122 ms after
 *  it. Two things are checked, each only where it applies:
 *   - the durable store — a STANDALONE APK only (a client/dev APK never gets
 *     it, by design): the page looks for the JS global `"AioNativeStore"`, so
 *     the overlay must inject one under that exact name;
 *   - the insets frame — every APK: targetSdk 35 draws edge-to-edge, and
 *     without a listener the page draws under the status bar. */
export function ownActivityLosses(
  sources: string,
  opts: {
    standalone: boolean;
    /** Every XML file the overlay put under `res/`, joined. An activity that inflates a
     *  layout whose root sets `android:fitsSystemWindows="true"` (or a theme
     *  item doing the same) HAS insets handling — its Kotlin just never says
     *  the word, and reading only .kt/.java warned it falsely. */
    resXml?: string;
  },
): string[] {
  const where = "aio's android-template/app/src/main/java/aio/app/" +
    "MainActivity.kt";
  const out: string[] = [];
  const storeInstalled = /addJavascriptInterface\s*\(/.test(sources) &&
    sources.includes('"AioNativeStore"');
  if (opts.standalone && !storeInstalled) {
    out.push(
      `your android/…/MainActivity.kt does not install AioNativeStore, so ` +
        `this standalone APK keeps its state in the WebView's localStorage — ` +
        `a change can be LOST on a kill right after it (fsync + atomic rename ` +
        `is what the store adds). Copy class AioNativeStore from ${where} and ` +
        `add, in onCreate: addJavascriptInterface(AioNativeStore(File(` +
        `filesDir, "aio-store")), "AioNativeStore") plus its ` +
        `addDocumentStartJavaScript key line — see docs/build/` +
        `targets.md "Adding native Android code".`,
    );
  } else if (
    opts.standalone &&
    !(/addDocumentStartJavaScript\s*\(/.test(sources) &&
      sources.includes('"__aioNativeStoreKey"'))
  ) {
    // The store as 1.0.12 and earlier shipped it: unkeyed, so every frame —
    // a third-party <iframe> the app embeds — can call it.
    out.push(
      `your android/…/MainActivity.kt installs AioNativeStore WITHOUT its ` +
        `per-launch key (the unkeyed store of aio 1.0.12 or earlier), so any ` +
        `third-party <iframe> this app embeds can read and overwrite its ` +
        `saved state. Copy class AioNativeStore and its install block ` +
        `(addJavascriptInterface + WebViewCompat.addDocumentStartJavaScript ` +
        `handing "__aioNativeStoreKey" to the app's origin) from ` +
        `${where} — the file layout is unchanged, so saved state still loads.`,
    );
  }
  if (
    opts.standalone &&
    !(/addWebMessageListener\s*\(/.test(sources) &&
      sources.includes('"AioNativeFetch"'))
  ) {
    out.push(
      `your android/…/MainActivity.kt does not install AioNativeFetch, so ` +
        `nativeFetch() in this standalone APK REJECTS (it never falls back ` +
        `to a fetch that carries an Origin). Copy object AioNativeFetch and ` +
        `its install line (WebViewCompat.addWebMessageListener) from ${where}.`,
    );
  }
  if (
    !/setOnApplyWindowInsetsListener|fitsSystemWindows/.test(sources) &&
    !FITS_SYSTEM_WINDOWS_XML.test(opts.resXml ?? "")
  ) {
    out.push(
      `your android/…/MainActivity.kt (and its res/ XML) sets no ` +
        `window-insets handling, so on Android 15+ (targetSdk 35 is ` +
        `edge-to-edge) the page draws UNDER the status and navigation bars. ` +
        `Wrap the WebView in a FrameLayout that takes the system-bar insets ` +
        `as padding — the frame at the end of onCreate in ${where} — or set ` +
        `android:fitsSystemWindows="true" on your layout's root.`,
    );
  }
  if (!sources.includes("__aioBack")) {
    out.push(
      `your android/…/MainActivity.kt never asks the page about Back ` +
        `(window.__aioBack), so onBackButton handlers from aio/air never run ` +
        `and Back always does Android's default. Copy onBackPressed and ` +
        `defaultBack from ${where}.`,
    );
  }
  return out;
}

/** deno.json `build.android.strict`, validated — `null` for a value that is
 *  not a boolean (refused by name). Opt-in, off when absent: with it, an
 *  `android/` overlay whose MainActivity.kt drops anything
 *  {@link ownActivityLosses} names (the keyed store, the fetch bridge, the
 *  insets frame, Back) FAILS the build instead of warning — a release can no
 *  longer ship with a third-party frame able to read its state because a
 *  warning scrolled past. Pure. */
export function _androidStrict(config: unknown): boolean | null {
  const raw = (config as
    | { build?: { android?: { strict?: unknown } } }
    | null
    | undefined)?.build?.android?.strict;
  return raw === undefined ? false : typeof raw === "boolean" ? raw : null;
}

/** Why the build stops on an overlaid activity's `losses` — or null when it
 *  goes on (nothing lost, or not `strict`: each loss is then a warning). Pure. */
export function ownActivityRefusal(
  losses: readonly string[],
  strict: boolean,
): string | null {
  if (!strict || !losses.length) return null;
  return `build.android.strict: no APK was built — your ` +
    `android/…/MainActivity.kt drops ${count(losses.length, "thing")} the ` +
    `template's activity does (above). Fix the overlay; without "strict" ` +
    `the same build only warns.`;
}

/** `fitsSystemWindows` turned ON in XML — the layout attribute
 *  (`android:fitsSystemWindows="true"`) or a theme item
 *  (`<item name="android:fitsSystemWindows">true</item>`). `"false"` is not
 *  insets handling, so it does not count. */
const FITS_SYSTEM_WINDOWS_XML =
  /fitsSystemWindows(?:\s*=\s*"true"|"\s*>\s*true\s*<)/;

/** {@link ownActivityLosses} over an overlaid build tree: every overlaid
 *  Kotlin/Java source, and every overlaid resource XML (layouts and themes are
 *  where `fitsSystemWindows` usually lives). `overlaid` is the list
 *  `_overlay` returned — paths relative to `androidDir`. */
export async function ownActivityWarnings(
  androidDir: string,
  overlaid: readonly string[],
  opts: { standalone: boolean },
): Promise<string[]> {
  const read = (re: RegExp) =>
    Promise.all(
      overlaid.filter((f) => re.test(f)).map((f) =>
        Deno.readTextFile(join(androidDir, f))
      ),
    );
  const [code, xml] = await Promise.all([
    read(/\.(kt|java)$/),
    read(/^app\/src\/main\/res\/.+\.xml$/),
  ]);
  return ownActivityLosses(code.join("\n"), {
    standalone: opts.standalone,
    resXml: xml.join("\n"),
  });
}

async function _applyDevUrl(
  androidDir: string,
  devUrl: string,
  /** The app's `android/` overlay supplied its own MainActivity.kt. */
  ownActivity: boolean,
): Promise<void> {
  const actPath = join(androidDir, MAIN_ACTIVITY);
  const safeUrl = safeDevUrl(devUrl);
  const act = await Deno.readTextFile(actPath);
  const anchor =
    'loadUrl("https://appassets.androidplatform.net/assets/index.html")';
  // A rewrite whose anchor is missing ships an APK that loads the packaged
  // page instead of the dev server, and says nothing. Our own template
  // missing it is aio's bug: refuse. An app's own MainActivity.kt (an
  // `android/` overlay) is the app's to shape: say what did not happen.
  if (!act.includes(anchor)) {
    const what = `MainActivity.kt has no ${anchor} to point at ${safeUrl}`;
    if (!ownActivity) {
      throw new Error(
        `[aio] --android-dev-url: ${what} — the template changed and this ` +
          `rewrite did not.`,
      );
    }
    console.warn(
      `⚠ [aio] --android-dev-url: your android/${what}, so this dev APK loads ` +
        `whatever it loads — not the dev server. Load the dev URL yourself, ` +
        `or keep that line in your MainActivity.kt.`,
    );
    return;
  }
  // Navigation needs no rewrite: TALKS_TO_SERVER (filled above) keeps the
  // dev server's pages in the WebView.
  await Deno.writeTextFile(
    actPath,
    act.replace(anchor, () => `loadUrl("${safeUrl}")`),
  );
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
  /** The user's keystore, for a release it signs (see `androidSigning`). */
  signed: { keystore: string } | null = null,
): Promise<void> {
  void appNameKotlin;
  const gradleBin = findGradle();
  if (!gradleBin) {
    console.error(
      `${NO} gradle not found — install Gradle and ensure it's on PATH or in a standard location`,
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
    ...(signed ? { [KEYSTORE_ENV]: signed.keystore } : {}), // absolute
  };

  // Generate gradle wrapper — pins version for reproducible builds. 8.14.3
  // (AGP 8.7.x needs 8.9+): 8.12.1 mis-detected Ubuntu's OpenJDK as a JRE
  // ("Is JDK: false" → "[JAVA_COMPILER]" toolchain error); fixed in 8.13+.
  console.log(`generating gradle wrapper (using ${gradleBin})...`);
  const wrapperResult = await new Deno.Command(gradleBin, {
    args: ["wrapper", "--gradle-version", "8.14.3"],
    cwd: androidDir,
    stdout: "piped",
    stderr: "inherit",
    env: gradleEnv,
  }).output();

  if (wrapperResult.code !== 0) {
    console.error(`${NO} gradle wrapper generation failed`);
    Deno.exit(1);
  }

  await chmodIfSupported(join(androidDir, "gradlew"), 0o755);
  console.log(`${OK} gradle wrapper (pinned 8.14.3)`);

  // Build APK using wrapper
  // A signed release also writes the bundle (.aab) a store upload takes.
  const gradleTasks = doRelease
    ? ["assembleRelease", ...(signed ? ["bundleRelease"] : [])]
    : ["assembleDebug"];
  console.log(`./gradlew ${gradleTasks.join(" ")}...`);
  const gradlew = gradlewPath(Deno.build.os, androidDir);
  const gradleResult = await new Deno.Command(gradlew, {
    args: gradleTasks,
    cwd: androidDir,
    stdout: "inherit",
    stderr: "inherit",
    env: gradleEnv,
  }).output();

  if (gradleResult.code !== 0) {
    console.error(`${NO} gradle build failed`);
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
      `${NO} gradle reported success but wrote no APK in ` +
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
  console.log(`${OK} ${label}${built.suffix}.apk (${apkMb} MB)`);
  if (built.suffix) {
    console.log(
      `\n  This APK is UNSIGNED \u2014 Android will refuse to install it as is.\n` +
        `  aio does not hold your release key. Sign it yourself:\n` +
        `    zipalign -p -f 4 ${label}-unsigned.apk ${label}.apk\n` +
        `    apksigner sign --ks <your.keystore> ${label}.apk\n` +
        `  or let the build sign it (and write ${label}.aab for a store):\n` +
        `    ${KEYSTORE_ENV}=<your.keystore> ${KEYSTORE_PASSWORD_ENV}=\u2026 ` +
        `${KEY_ALIAS_ENV}=\u2026 <this build> --release\n`,
    );
  } else if (!doRelease) {
    // Said, not assumed: this file installs and runs, and no store takes it.
    console.log(
      `  debug build \u2014 signed with Android's debug key and debuggable: ` +
        `for your own devices, not store-ready. A store build is --release ` +
        `with ${KEYSTORE_ENV} (docs/build/targets.md).`,
    );
  }
  if (signed) {
    const aab = join(
      androidDir,
      "app/build/outputs/bundle/release/app-release.aab",
    );
    const aabDst = join(cfg.outDir ?? cfg.root, `${label}.aab`);
    try {
      await Deno.copyFile(aab, aabDst);
    } catch (e) {
      console.error(
        `${NO} gradle reported success but wrote no bundle at ${aab} ` +
          `(${e instanceof Error ? e.message : e})`,
      );
      Deno.exit(1);
    }
    const aabMb = ((await Deno.stat(aabDst)).size / 1024 / 1024).toFixed(1);
    console.log(
      `${OK} ${label}.aab (${aabMb} MB) \u2014 the bundle a store upload takes; ` +
        `both are signed with your key and not debuggable`,
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
