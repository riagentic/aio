/**
 * @module
 * Build Android — generates Android project from template, builds APK via Gradle.
 */
import { dirname, join } from "@std/path";
import { findGradle, findJdk } from "./build-helpers.ts";
import { ANDROID_TEMPLATE } from "./android-template.ts";
import type { BuildConfig } from "./build-config.ts";

/** Build the Android APK. Exits process on completion or error. */
export async function buildAndroid(cfg: BuildConfig): Promise<void> {
  const { root, dist, binaryName, appTitle, doRemote, doRelease } = cfg;

  const androidHome = Deno.env.get("ANDROID_HOME");
  if (!androidHome) {
    console.error(
      "[android] \u2717 ANDROID_HOME not set — install Android SDK and set ANDROID_HOME",
    );
    Deno.exit(1);
  }

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

  // Derive application ID from binary name
  const sanitizedId = binaryName.replace(/[^a-z0-9]/g, "");
  if (!sanitizedId || !/^[a-z]/.test(sanitizedId)) {
    console.error(
      `[android] \u2717 binary name "${binaryName}" produces invalid applicationId — must start with a letter`,
    );
    Deno.exit(1);
  }
  const applicationId = `app.aio.${sanitizedId}`;
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

  // Check for user icon
  const iconPath = join(root, "src", "icon.png");
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

  console.log(`[android] app: ${appNameKotlin} (${applicationId})`);

  // Copy assets into android project
  const assetsDir = join(androidDir, "app/src/main/assets");
  await Deno.mkdir(assetsDir, { recursive: true });

  if (doRemote) {
    await _writeConnectPage(assetsDir, appNameXml);
  } else {
    await _writeLocalAssets(cfg, assetsDir, appNameXml);
  }

  // Copy icon to mipmap resources
  if (hasIcon) {
    const mipmapDir = join(androidDir, "app/src/main/res/mipmap-hdpi");
    await Deno.mkdir(mipmapDir, { recursive: true });
    await Deno.copyFile(iconPath, join(mipmapDir, "ic_launcher.png"));
    console.log("[android] \u2713 icon from src/icon.png");
  }

  await _runGradle(cfg, androidDir, androidHome, appNameKotlin, doRelease);
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
  appNameXml: string,
): Promise<void> {
  const { dist } = cfg;
  let hasCSS = false;
  try {
    await Deno.stat(join(dist, "style.css"));
    hasCSS = true;
  } catch { /* no css — skip */ }
  const cssLink = hasCSS
    ? '\n  <link rel="stylesheet" href="./style.css">'
    : "";
  const androidHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appNameXml}</title>${cssLink}
</head>
<body>
  <div id="root"></div>
  <script src="./app.js"></script>
</body>
</html>`;
  await Deno.copyFile(join(dist, "app.js"), join(assetsDir, "app.js"));
  await Deno.writeTextFile(join(assetsDir, "index.html"), androidHtml);
  if (hasCSS) {
    await Deno.copyFile(join(dist, "style.css"), join(assetsDir, "style.css"));
  }
  console.log("[android] \u2713 assets copied");
}

async function _runGradle(
  cfg: BuildConfig,
  androidDir: string,
  androidHome: string,
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

  // Gradle compiles with the JVM it runs on — a JRE has `java` but no `javac`,
  // which fails as "Toolchain … does not provide … [JAVA_COMPILER]". Pin
  // JAVA_HOME to a real JDK (with javac) so gradlew launches on it; fail loud
  // with install steps when the machine only has a JRE.
  const jdkHome = findJdk();
  if (!jdkHome) {
    console.error(
      "[android] ✗ no JDK with javac found — Android builds need a full JDK (a JRE is not enough)",
    );
    console.error("  install one, then retry:");
    console.error("    • Debian/Ubuntu: sudo apt install openjdk-21-jdk");
    console.error("    • macOS:         brew install openjdk@21");
    console.error(
      "    • or set JAVA_HOME to an existing JDK (must contain bin/javac)",
    );
    Deno.exit(1);
  }
  console.log(`[android] ✓ JDK ${jdkHome}`);

  const gradleEnv = {
    ...Deno.env.toObject(),
    ANDROID_HOME: androidHome,
    JAVA_HOME: jdkHome,
  };

  // Generate gradle wrapper — pins version for reproducible builds (AGP 8.7.x needs Gradle 8.9+)
  console.log(`[android] generating gradle wrapper (using ${gradleBin})...`);
  const wrapperResult = await new Deno.Command(gradleBin, {
    args: ["wrapper", "--gradle-version", "8.12.1"],
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
  console.log("[android] \u2713 gradle wrapper (pinned 8.12.1)");

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
