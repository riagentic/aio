/**
 * @module
 * Build configuration — parses CLI flags, reads deno.json, derives all shared build state.
 */
import { basename, dirname, join, resolve } from "@std/path";
import { slugify } from "./build-helpers.ts";
import { appIdFromConfig } from "../server/single-instance-lock.ts";
import { bakedServerUrl, resolveEntryPath } from "../server/paths.ts";
import {
  BUILD_BOOL_FLAGS,
  BUILD_VALUE_FLAGS,
  flagHint,
  flagVocabulary,
  unknownBuildFlags,
} from "./build-flags.ts";
import {
  crossCompileBlocker,
  hostPlatform,
  isHostPlatform,
  PLATFORMS,
  resolvePlatforms,
} from "./platforms.ts";

/** The entry an app declares in `deno.json`, and the scaffold's default when
 *  it declares none. THE entry decider: every tool that needs to know which
 *  module IS the app — the build, `dev:android`'s server child, the app dir
 *  rule below — reads it from here. A hardcoded `"src/app.ts"` elsewhere is a
 *  second decider, and it breaks the moment an app puts its entry anywhere
 *  else (WYSIDIWYSIP).
 *
 *  `override` is a per-BUILD entry (`--entry=`, which `build-all` passes for a
 *  target that declares its own `entry`) — one repo can hold two apps, a relay
 *  and a client, and each target must compile its own module. It flows through
 *  the same decider so `appDir` and everything derived from it follow for free;
 *  a target-specific app-dir rule would be exactly the second decider this
 *  function exists to prevent. */
export function resolveEntry(
  mainConfig: Record<string, unknown>,
  override?: string,
): string {
  // Delegates: `am` needs the same answer and cannot import the build.
  return resolveEntryPath(mainConfig, override);
}

/** THE app-dir decider (WYSIDIWYSIP), as one named rule rather than an
 *  expression inlined at its single call site: the app dir is the ENTRY'S
 *  DIRECTORY — exactly what the runtime resolves as `baseDir`
 *  (`aio.ts _inferBaseDir`: the main module's directory). Dev serving and prod
 *  packaging must never resolve an app asset from two different places, so
 *  anything that needs the app dir without a full `loadBuildConfig()` (a test,
 *  a tool) calls THIS instead of re-deriving it. */
export function resolveAppDir(root: string, configEntry: string): string {
  return resolve(root, dirname(configEntry));
}

export interface BuildConfig {
  // Paths
  root: string;
  dist: string;
  out: string;
  frameworkSrcDir: string;

  // Flags
  doElectron: boolean;
  doAndroid: boolean;
  doClient: boolean;
  doCli: boolean;
  doRemote: boolean;
  doCompile: boolean;
  doForce: boolean;
  doRelease: boolean;
  doService: boolean;
  doHeadless: boolean;

  /** dev:android — build a thin APK whose WebView loads this live dev-server URL
   *  (http://localhost:PORT, tunneled via `adb reverse`) instead of bundling
   *  assets. Enables cleartext. */
  androidDevUrl: string | undefined;
  /** deno.json `android.applicationId` — the app's PERMANENT Play Store
   *  identity. Undefined means "derive it" (`app.aio.<name>`), which is aio's
   *  namespace and therefore unpublishable under someone else's name. */
  androidApplicationId: string | undefined;
  /** True when `configEntry` came from `--entry=` rather than deno.json — so an
   *  error can blame the place the value ACTUALLY came from. */
  entryFromFlag: boolean;
  /** deno.json `build.server` as a URL — the address a shipped CLIENT defaults
   *  to. Null when the app declares none (see `bakedServerUrl`). */
  bakedServer: string | null;

  // App identity
  binaryName: string;
  appTitle: string | undefined;
  configEntry: string;
  /** THE app-dir decider (WYSIDIWYSIP). Absolute directory of the app's UI
   *  files — App.tsx, style.css, icon.png. Derived as dirname(entry), the same
   *  rule the runtime uses (`_inferBaseDir`: the main module's directory), so
   *  dev serving and prod packaging can never resolve the app's assets from
   *  two different places. Every build step that touches an app asset MUST
   *  read this field — a second hardcoded path is the bug class that shipped
   *  a stylesheet in dev and silently dropped it from the prod bundle. */
  appDir: string;
  /** The raw `--entry=` value when THIS build was given one (a per-target entry
   *  from build-all), else undefined. `configEntry` already folds it in; this
   *  field only answers "did the caller NAME a module?", which is the one
   *  question a target with its own conventional default (`--cli --remote` →
   *  `src/client.ts`) has to ask before falling back. */
  entryOverride: string | undefined;
  rendererMode: "aio";

  // Platform
  os: string;
  arch: string;
  archStr: string;

  /** Cross-compilation platform name (`linux`, `windows`, `macos-arm64`, …).
   *  Always set; equals the host platform unless `--platform=` asked for
   *  another. See src/build/platforms.ts. */
  platform: string;
  /** The `deno compile --target` triple, or undefined when building for the
   *  host (no flag — let deno use its own default). */
  targetTriple: string | undefined;
  /** Executable suffix for this platform (".exe" on Windows). */
  exeExt: string;

  // Framework resolution
  isRemote: boolean;
  frameworkBase: URL;
}

/** Refuse a build whose flags we do not understand, naming the vocabulary.
 *  An unrecognized flag is read as ABSENT, so the build would have produced a
 *  different artifact and exited 0 — see build-flags.ts. */
function assertKnownFlags(args: readonly string[]): void {
  const unknown = unknownBuildFlags(args);
  if (unknown.length === 0) return;
  console.error(
    `[build] \u2717 unknown flag(s): ${unknown.join(", ")}` +
      unknown.map(flagHint).join("") +
      `\n         known: ${
        flagVocabulary(BUILD_BOOL_FLAGS, BUILD_VALUE_FLAGS)
      }` +
      `\n         (an unrecognized flag would have been ignored, and this ` +
      `build would have produced a DIFFERENT artifact than you asked for.)`,
  );
  Deno.exit(1);
}

/** Load and validate build configuration from CLI flags + deno.json */
export async function loadBuildConfig(): Promise<BuildConfig> {
  assertKnownFlags(Deno.args);
  const root = Deno.cwd();
  const dist = resolve(join(root, "dist"));
  const out = join(dist, "app.js");

  // framework src/ root — this module lives in src/build/, entries live at src/
  const frameworkBase = new URL("..", import.meta.url);
  const isRemote = frameworkBase.protocol !== "file:";
  const frameworkSrcDir = isRemote
    ? ""
    : (import.meta.dirname ? dirname(import.meta.dirname) : ".");

  const doElectron = Deno.args.includes("--electron");
  const doAndroid = Deno.args.includes("--android");
  const doClient = Deno.args.includes("--client");
  const doCli = Deno.args.includes("--cli");
  const doRemote = Deno.args.includes("--remote");
  const doCompile = Deno.args.includes("--compile") || doElectron;
  const doForce = Deno.args.includes("--force");
  const doRelease = Deno.args.includes("--release");
  const doService = Deno.args.includes("--service");
  const doHeadless = Deno.args.includes("--headless");

  // Reject conflicting shell flags
  const shellFlags = [
    doElectron && "--electron",
    doAndroid && "--android",
    doCli && "--cli",
    doClient && "--client",
  ].filter(Boolean);
  if (shellFlags.length > 1) {
    console.error(
      `[build] \u2717 conflicting flags: ${
        shellFlags.join(" + ")
      } — pick one shell target`,
    );
    Deno.exit(1);
  }

  const mainConfig = JSON.parse(
    await Deno.readTextFile(join(root, "deno.json")),
  );
  const rendererMode = "aio" as const;
  const appTitle = mainConfig.title as string | undefined;
  // --entry=<module> overrides deno.json's `entry` for THIS build only (a
  // per-target entry from build-all). appDir, and with it every app-asset path,
  // derives from it through the existing rule — no second app-dir rule.
  const entryArg = Deno.args.find((a) => a.startsWith("--entry="))?.slice(
    "--entry=".length,
  );
  const configEntry = resolveEntry(mainConfig, entryArg);
  const appDir = resolveAppDir(root, configEntry);
  // ONE slugify decider for the binary name. Without a `title`, the fallback
  // used the raw directory name, so a project folder called `My App` produced
  // a binary literally named `My App` under `deno task compile` while
  // `deno task build` (which slugifies the same fallback) produced `my-app` —
  // two names for one artifact, and a shell-hostile one at that.
  //
  // The chain itself belongs to `appIdFromConfig`, not here: a compiled app
  // infers its APP ID from this very filename, so naming the binary and
  // resolving the id are one decision. Reading `title` while ignoring `appId`
  // made them two, and an app that set `appId` changed data directories the
  // moment it was compiled.
  const defaultName = appIdFromConfig(mainConfig) ?? slugify(basename(root));
  const rawName = Deno.args.find((a) => a.startsWith("--name="))?.slice(7);
  const binaryName = rawName ? slugify(rawName) : defaultName;

  const androidApplicationId =
    (mainConfig.android as { applicationId?: string } | undefined)
      ?.applicationId;
  const androidDevUrl = Deno.args.find((a) =>
    a.startsWith("--android-dev-url=")
  )?.slice("--android-dev-url=".length);

  const os = Deno.build.os;
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  const archStr = arch === "aarch64" ? "arm64" : "x64";

  // --platform=<name>: which OS/arch this binary is FOR. Defaults to the host,
  // so every existing invocation behaves exactly as before.
  const rawPlatform = Deno.args.find((a) => a.startsWith("--platform="))
    ?.slice("--platform=".length) ?? "host";
  const resolved = resolvePlatforms([rawPlatform]);
  if (!resolved.ok) {
    console.error(`[build] \u2717 ${resolved.error}`);
    Deno.exit(1);
  }
  const platform = resolved.platforms[0] ?? hostPlatform();
  const spec = PLATFORMS[platform]!;
  // A cross build must not pretend it can also be an Electron/Android bundle.
  if (!isHostPlatform(platform)) {
    const shell = doElectron ? "electron" : doAndroid ? "android" : null;
    if (shell) {
      const why = crossCompileBlocker(shell);
      console.error(
        `[build] \u2717 --platform=${platform} cannot be combined with ` +
          `--${shell}: ${why}`,
      );
      Deno.exit(1);
    }
  }

  return {
    root,
    dist,
    out,
    frameworkSrcDir,
    doElectron,
    doAndroid,
    doClient,
    doCli,
    doRemote,
    doCompile,
    doForce,
    doRelease,
    doService,
    doHeadless,
    androidDevUrl,
    androidApplicationId,
    entryFromFlag: entryArg !== undefined,
    bakedServer: bakedServerUrl(
      (mainConfig.build as { server?: string } | undefined)?.server,
    ),
    binaryName,
    appTitle,
    configEntry,
    appDir,
    entryOverride: entryArg,
    rendererMode,
    os,
    arch,
    archStr,
    platform,
    targetTriple: isHostPlatform(platform) ? undefined : spec.triple,
    exeExt: spec.exeExt,
    isRemote,
    frameworkBase,
  };
}
