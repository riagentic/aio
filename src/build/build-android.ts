/**
 * @module
 * Build Android — generates Android project from template, builds APK via Gradle.
 */
import { dirname, join } from "@std/path";
import {
  findGradle,
  findJdk,
  GRADLE_MAX_JDK,
  type JdkResult,
  resolveSdk,
} from "./build-helpers.ts";
import { ANDROID_TEMPLATE } from "./android-template.ts";
import { androidLocalHTML } from "../server/server-html-gen.ts";
import type { BuildConfig } from "./build-config.ts";

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

  // Derive application ID from binary name — THE one rule (see
  // androidApplicationId below; dev:android derives the same id from the APK
  // label, which IS the binary name, so both must share the rule or drift).
  const applicationId = androidApplicationId(binaryName);
  if (!applicationId) {
    console.error(
      `[android] \u2717 binary name "${binaryName}" produces invalid applicationId — must start with a letter`,
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
  const iconPath = join(cfg.appDir, "icon.png");
  let hasIcon = false;
  try {
    await Deno.stat(iconPath);
    hasIcon = true;
  } catch { /* no icon — skip */ }

  // Replace placeholders in template files
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
    content = content.replaceAll(
      "{{APP_NAME}}",
      xmlFiles.has(f) ? appNameXml : appNameKotlin,
    );
    content = content.replaceAll(
      "{{ICON_ATTR}}",
      hasIcon ? 'android:icon="@mipmap/ic_launcher"' : "",
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
      await _writeConnectPage(assetsDir, appNameXml);
    } else {
      await _writeLocalAssets(cfg, assetsDir);
    }
  }

  // Copy icon to mipmap resources
  if (hasIcon) {
    const mipmapDir = join(androidDir, "app/src/main/res/mipmap-hdpi");
    await Deno.mkdir(mipmapDir, { recursive: true });
    await Deno.copyFile(iconPath, join(mipmapDir, "ic_launcher.png"));
    console.log(`[android] \u2713 icon from ${iconPath}`);
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

async function _writeConnectPage(
  assetsDir: string,
  appNameXml: string,
): Promise<void> {
  const connectHtml = `<!DOCTYPE html>
<html>
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
      <input id="addr" type="text" placeholder="192.168.1.100:8000" autofocus spellcheck="false" />
      <button type="submit">Connect</button>
    </form>
    <div id="err"></div>
  </div>
  <script>
    var s=localStorage.getItem('aio_server');
    if(s)document.getElementById('addr').value=s;
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
  console.log("[android] \u2713 connect page");
}

async function _writeLocalAssets(
  cfg: BuildConfig,
  assetsDir: string,
): Promise<void> {
  const { dist, appTitle, binaryName } = cfg;
  let hasCSS = false;
  try {
    await Deno.stat(join(dist, "style.css"));
    hasCSS = true;
  } catch { /* no css — skip */ }
  // ONE shell decider — see androidLocalHTML: a hand-rolled copy here shipped
  // a different default viewport than every other target (WYSIDIWYSIP).
  // Raw title: androidLocalHTML escapes it itself (escHtml in headContent).
  const androidHtml = androidLocalHTML(appTitle ?? binaryName, hasCSS);
  await Deno.copyFile(join(dist, "app.js"), join(assetsDir, "app.js"));
  await Deno.writeTextFile(join(assetsDir, "index.html"), androidHtml);
  if (hasCSS) {
    await Deno.copyFile(join(dist, "style.css"), join(assetsDir, "style.css"));
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
/** THE applicationId rule: `app.aio.<label sans non-alphanumerics>`, or null
 *  when the label cannot make a valid id (must start with a letter). Shared
 *  by the build (from `binaryName`) and `dev:android` (from the APK label,
 *  which the build sets to the binary name) — one rule, or the installed dev
 *  app and the built APK disagree on identity. */
export function androidApplicationId(label: string): string | null {
  const sanitized = label.replace(/[^a-z0-9]/g, "");
  if (!sanitized || !/^[a-z]/.test(sanitized)) return null;
  return `app.aio.${sanitized}`;
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

  const manifestPath = join(androidDir, "app/src/main/AndroidManifest.xml");
  let manifest = await Deno.readTextFile(manifestPath);
  manifest = manifest.replace(
    'android:allowBackup="false"',
    'android:allowBackup="false"\n        android:usesCleartextTraffic="true"',
  );
  await Deno.writeTextFile(manifestPath, manifest);
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
  await Deno.chmod(gradlew, 0o755);
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

  // Copy APK to project root
  const apkVariant = doRelease
    ? "release/app-release.apk"
    : "debug/app-debug.apk";
  const apkSrc = join(androidDir, "app/build/outputs/apk", apkVariant);
  const apkLabel = cfg.doRemote ? `${cfg.binaryName}-client` : cfg.binaryName;
  const apkDst = join(cfg.root, `${apkLabel}.apk`);
  await Deno.copyFile(apkSrc, apkDst);
  const apkStat = await Deno.stat(apkDst);
  const apkMb = (apkStat.size / 1024 / 1024).toFixed(1);
  console.log(`[android] \u2713 ${apkLabel}.apk (${apkMb} MB)`);
}
