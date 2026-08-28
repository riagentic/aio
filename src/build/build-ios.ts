// build-ios.ts — the `ios-client` target: an Xcode project whose one screen is
// a WKWebView that opens the packaged connect page and navigates to the aio
// server the user names. The same shape as `android-client`, for the same
// reason: there is no Deno runtime on iOS, so the app itself cannot run there
// — its server runs elsewhere, and this is the maximum an iPhone can carry.
//
// What this produces depends on the host, and it says so:
//   - on ANY host: `dist/ios/<name>-ios-client/` — the complete project
//     (sources, plist, icon, `www/index.html`), ready to open in Xcode. That is
//     the artifact.
//   - on macOS with `xcodebuild`: additionally a simulator `App.app`, unsigned
//     (a device build is signed by the developer's own team in Xcode).
import { dirname, join } from "@std/path";
import { IOS_TEMPLATE } from "./ios-template.ts";
import type { BuildConfig } from "./build-config.ts";
import { readDenoJson } from "../server/deno-json.ts";
import { appIconPng } from "./app-icon.ts";
import { _writeConnectPage, androidVersion } from "./build-android.ts";
import { misplacedIconHint, resolveAppIcon } from "./build-helpers.ts";

/** The reverse-DNS bundle id: `ios.bundleId` from deno.json when declared,
 *  else `app.aio.<label>` — one decider, like `androidApplicationId`. */
export function iosBundleId(
  label: string,
  explicit: string | undefined,
): string | null {
  if (explicit !== undefined) {
    return isValidBundleId(explicit) ? explicit : null;
  }
  const sanitized = label.replace(/[^a-z0-9]/g, "");
  if (!sanitized || !/^[a-z]/.test(sanitized)) return null;
  return `app.aio.${sanitized}`;
}

/** Apple's rule: alphanumerics, hyphens and dots; two or more segments. */
export function isValidBundleId(id: string): boolean {
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(id);
}

/** Text that is interpolated into a plist `<string>`: control characters
 *  dropped, XML-escaped. */
export function plistText(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) {
      continue;
    }
    out += ch;
  }
  return out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render the template with this build's facts. Pure — the file set is a
 *  unit test, not a claim. */
export function renderIosTemplate(facts: {
  appName: string;
  bundleId: string;
  versionName: string;
  versionCode: number;
  /** With no `build.server` baked in, the user types an address, and a LAN
   *  server is usually plain http — so App Transport Security must not veto
   *  it. A baked-in https server keeps ATS strict. */
  allowArbitraryLoads: boolean;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, content] of Object.entries(IOS_TEMPLATE)) {
    out[rel] = content
      .replaceAll("{{APP_NAME}}", plistText(facts.appName))
      .replaceAll("{{BUNDLE_ID}}", facts.bundleId)
      .replaceAll("{{VERSION_NAME}}", facts.versionName)
      .replaceAll("{{VERSION_CODE}}", String(facts.versionCode))
      .replaceAll(
        "{{ATS_ARBITRARY}}",
        facts.allowArbitraryLoads ? "true" : "false",
      )
      .replaceAll(
        "{{ATS_COMMENT}}",
        facts.allowArbitraryLoads
          ? "No server is baked in, so any address the user types must be reachable."
          : "The baked-in server is https, so only local networking is opened.",
      );
  }
  return out;
}

/** Where the project lands: `<root>/<name>-ios-client/` — a DIRECTORY
 *  artifact in the project root, where every per-target build leaves its
 *  output for the fleet build to stage into `dist/`. */
export function iosProjectDir(
  cfg: Pick<BuildConfig, "root" | "binaryName">,
): string {
  return join(cfg.root, iosArtifactName(cfg.binaryName));
}

/** The artifact's name — the one spelling the builder writes and the fleet
 *  recognises. */
export function iosArtifactName(binaryName: string): string {
  return `${binaryName}-ios-client`;
}

export async function buildIos(cfg: BuildConfig): Promise<void> {
  const { root, binaryName, appTitle } = cfg;
  if (!cfg.doRemote) {
    // No `ios` app target exists and none can: the app IS a Deno process.
    console.error(
      "[ios] ✗ there is no Deno runtime on iOS, so an app cannot run " +
        "there — only a CLIENT can. Build `ios-client` (`--ios --remote`), " +
        "and run the server as `server` / `server-app` elsewhere.",
    );
    Deno.exit(1);
  }
  const mainConfig = (await readDenoJson(root))?.config ?? {};
  const version = androidVersion(cfg.version);
  const explicitId = (mainConfig.ios as { bundleId?: string } | undefined)
    ?.bundleId;
  const bundleId = iosBundleId(binaryName, explicitId);
  if (!bundleId) {
    console.error(
      explicitId !== undefined
        ? `[ios] ✗ ios.bundleId ${JSON.stringify(explicitId)} is not a ` +
          `valid bundle identifier — reverse-DNS, two or more dot-separated ` +
          `segments of letters, digits and hyphens (e.g. "com.example.wallet")`
        : `[ios] ✗ name "${binaryName}" produces no valid bundle id — ` +
          `it must start with a letter`,
    );
    Deno.exit(1);
  }
  const appName = appTitle ?? binaryName;
  const dir = iosProjectDir(cfg);
  try {
    await Deno.remove(dir, { recursive: true });
  } catch { /* aio-ok: a first build has nothing to remove */ }
  const files = renderIosTemplate({
    appName,
    bundleId,
    versionName: version.name,
    versionCode: version.code,
    allowArbitraryLoads: !(cfg.bakedServer?.startsWith("https://") ?? false),
  });
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(dir, rel);
    await Deno.mkdir(dirname(dest), { recursive: true });
    await Deno.writeTextFile(dest, content);
  }

  // The connect page — the same one the Android client opens.
  const www = join(dir, "App", "www");
  await Deno.mkdir(www, { recursive: true });
  await _writeConnectPage(www, plistText(appName), cfg.bakedServer, "ios");

  // Icon: the app's own `icon.png` when it has one (Xcode validates the
  // 1024×1024 requirement at archive time and says so), else the generated
  // monogram at exactly that size.
  const iconDest = join(
    dir,
    "App",
    "Assets.xcassets",
    "AppIcon.appiconset",
    "icon-1024.png",
  );
  const { icon, misplaced } = await resolveAppIcon(root, cfg.appDir);
  if (misplaced) {
    console.warn(`[ios] ⚠ ${misplacedIconHint(misplaced, cfg.appDir)}`);
  }
  if (icon) {
    await Deno.copyFile(icon, iconDest);
    console.log(`[ios] ✓ icon from ${icon} (App Store requires 1024×1024)`);
  } else {
    await Deno.writeFile(iconDest, await appIconPng(binaryName, 1024));
    console.log("[ios] ✓ icon (generated monogram, 1024×1024)");
  }
  console.log(
    `[ios] ✓ Xcode project ${
      join(dir, "App.xcodeproj")
    } (${bundleId} ${version.name})`,
  );

  // xcodebuild exists only on macOS. Elsewhere the project IS the artifact,
  // and the next step is named rather than implied.
  const xcodebuild = await _whichXcodebuild();
  if (!xcodebuild) {
    console.log(
      `[ios] note: no xcodebuild on this host (${Deno.build.os}) — the ` +
        `project is complete; on a Mac, open App.xcodeproj inside the ` +
        `artifact (or run \`deno task build --targets=ios-client\` there) ` +
        `to build and sign it.`,
    );
    return;
  }
  const derived = join(dir, "build");
  const p = await new Deno.Command(xcodebuild, {
    args: [
      "-project",
      join(dir, "App.xcodeproj"),
      "-scheme",
      "App",
      "-configuration",
      "Release",
      "-sdk",
      "iphonesimulator",
      "-derivedDataPath",
      derived,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!p.success) {
    const err = new TextDecoder().decode(p.stderr) +
      new TextDecoder().decode(p.stdout);
    console.error(
      `[ios] ✗ xcodebuild failed:\n${
        err.trimEnd().split("\n").slice(-20).join("\n")
      }`,
    );
    Deno.exit(1);
  }
  const app = join(
    derived,
    "Build",
    "Products",
    "Release-iphonesimulator",
    "App.app",
  );
  console.log(
    `[ios] ✓ ${app} (simulator, unsigned) — for a device, open the ` +
      `project in Xcode, pick your team, and Archive.`,
  );
}

async function _whichXcodebuild(): Promise<string | null> {
  if (Deno.build.os !== "darwin") return null;
  try {
    const p = await new Deno.Command("xcrun", {
      args: ["--find", "xcodebuild"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!p.success) return null;
    return new TextDecoder().decode(p.stdout).trim() || null;
  } catch {
    return null;
  }
}
