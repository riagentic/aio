/**
 * @module
 * Build configuration — parses CLI flags, reads deno.json, derives all shared build state.
 */
import { isArtifactName } from "../build-all.ts";
import { readDenoJson } from "../server/deno-json.ts";
import { BUNDLE_JS, DIST_DIR, UI_ENTRY } from "../server/app-files.ts";
import { basename, dirname, join, resolve, SEPARATOR } from "@std/path";
import { slugify } from "./build-helpers.ts";
import { bad, step, warn } from "./build-say.ts";
import { NO } from "../diagnostics/fmt.ts";
import {
  type BuildVersion,
  buildVersionFor,
  buildVersionNotes,
} from "./build-version.ts";
import { appIdFromConfig } from "../server/single-instance-lock.ts";
import { bakedServerUrl, resolveEntryPath } from "../server/paths.ts";
import {
  BUILD_BOOL_FLAGS,
  BUILD_VALUE_FLAGS,
  flagHint,
  flagVocabulary,
  isBuildQuestion,
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
  /** `--ios`: the `ios-client` Xcode project (there is no iOS app target). */
  doIos: boolean;
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
  /** THE app version this build carries — `major.minor.<commit count>`,
   *  resolved once (by the fleet when it runs this build, else here) and
   *  stamped into every artifact. See build-version.ts. */
  version: BuildVersion;
  configEntry: string;
  /** THE app-dir decider (WYSIDIWYSIP). Absolute directory of the app's UI
   *  files — App.tsx, style.css, icon.png. Derived as dirname(entry), the same
   *  rule the runtime uses (`_inferBaseDir`: the main module's directory), so
   *  dev serving and prod packaging can never resolve the app's assets from
   *  two different places. Every build step that touches an app asset MUST
   *  read this field — a second hardcoded path is the bug class that shipped
   *  a stylesheet in dev and silently dropped it from the prod bundle. */
  appDir: string;
  /** `--allow-server-only` — the developer asserting that the server-only
   *  code this app reaches is guarded and never taken on Android, where there
   *  is no Deno runtime to run it. Without it, that build is refused. */
  allowServerOnly: boolean;
  /** The UI component this build bundles, relative to {@link appDir} —
   *  `--ui=` else deno.json `build.ui`, else the `App.tsx` convention. The
   *  build-side half of dev's `ui.entry`: the bundle records what it was built
   *  from and the server refuses a mismatch, so the pair cannot silently
   *  diverge (dev==prod). */
  uiEntry: string;
  /** Where final artifacts land (`--out=`, resolved against root; default:
   *  the project root). dist/ stays the embedded-asset staging area — it is
   *  wiped and embedded wholesale, never a place to collect releases. */
  outDir: string;
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
    `${NO} unknown flag(s): ${unknown.join(", ")}` +
      unknown.map(flagHint).join("") +
      `\n         known: ${
        flagVocabulary(BUILD_BOOL_FLAGS, BUILD_VALUE_FLAGS)
      }` +
      `\n         (an unrecognized flag would have been ignored, and this ` +
      `build would have produced a DIFFERENT artifact than you asked for.)`,
  );
  Deno.exit(1);
}

/** Every refusal a build makes about its ARGV, before anything is read from
 *  disk or built — one decider, so the two callers cannot disagree.
 *
 *  It has two callers because there are two moments: `loadBuildConfig` (the
 *  build itself) and the delegation in `build.ts` that hands a target to the
 *  fleet. The delegation runs FIRST, so without this the generic "that is not
 *  a build target" would have shadowed every specific message here — an
 *  unknown flag, two shell targets at once, a `--service` with nothing to
 *  serve. A worse message for the same mistake is a regression even when the
 *  exit code is identical. */
export function refuseBadBuildArgs(args: readonly string[]): void {
  assertKnownFlags(args);
  // Two shell targets in one build: the second would silently win.
  const shells = ["--electron", "--android", "--ios", "--cli", "--client"]
    .filter((f) => args.includes(f));
  if (shells.length > 1) {
    console.error(
      `${NO} conflicting flags: ${shells.join(" + ")} — pick one shell target`,
    );
    Deno.exit(1);
  }
  // `--service` writes a systemd unit for the BINARY this build produces, so
  // on its own it describes a file that will not exist. The pipeline used to
  // accept it: it bundled `dist/app.js`, reached "nothing left to do", and
  // exited 0 — a successful-looking command that did a fraction of what its
  // flag implies.
  const compiles = args.includes("--compile") || args.includes("--electron");
  if (args.includes("--service") && !compiles) {
    console.error(
      "\u2717 --service writes a systemd unit for a compiled binary, " +
        "and this build compiles nothing.\n" +
        "       fix: `--compile --service` (the combination the unit file " +
        "describes), or drop --service to build only the bundle.",
    );
    Deno.exit(1);
  }
}

/** Load and validate build configuration from CLI flags + deno.json */
export async function loadBuildConfig(): Promise<BuildConfig> {
  refuseBadBuildArgs(Deno.args);
  const root = Deno.cwd();
  const dist = resolve(join(root, DIST_DIR));
  const out = join(dist, BUNDLE_JS);

  // framework src/ root — this module lives in src/build/, entries live at src/
  const frameworkBase = new URL("..", import.meta.url);
  const isRemote = frameworkBase.protocol !== "file:";
  const frameworkSrcDir = isRemote
    ? ""
    : (import.meta.dirname ? dirname(import.meta.dirname) : ".");

  const doElectron = Deno.args.includes("--electron");
  const doAndroid = Deno.args.includes("--android");
  const doIos = Deno.args.includes("--ios");
  const doClient = Deno.args.includes("--client");
  const doCli = Deno.args.includes("--cli");
  const doRemote = Deno.args.includes("--remote");
  const doCompile = Deno.args.includes("--compile") || doElectron;
  const doForce = Deno.args.includes("--force");
  const doRelease = Deno.args.includes("--release");
  const doService = Deno.args.includes("--service");
  const doHeadless = Deno.args.includes("--headless");

  const mainConfig = (await readDenoJson(root))?.config ?? {};
  const rendererMode = "aio" as const;
  const appTitle = mainConfig.title as string | undefined;
  // --entry=<module> overrides deno.json's `entry` for THIS build only (a
  // per-target entry from build-all). appDir, and with it every app-asset path,
  // derives from it through the existing rule — no second app-dir rule.
  const entryArg = Deno.args.find((a) => a.startsWith("--entry="))?.slice(
    "--entry=".length,
  );
  const uiArg = Deno.args.find((a) => a.startsWith("--ui="))?.slice(
    "--ui=".length,
  );
  const outArg = Deno.args.find((a) => a.startsWith("--out="))?.slice(
    "--out=".length,
  );
  const configEntry = resolveEntry(mainConfig, entryArg);
  const defaultName = appIdFromConfig(mainConfig) ?? slugify(basename(root));
  const rawName = Deno.args.find((a) => a.startsWith("--name="))?.slice(7);
  const binaryName = rawName ? slugify(rawName) : defaultName;
  // THE app version. The fleet resolves it once and hands it down
  // (AIO_BUILD_VERSION); a direct single-target build resolves it here and
  // prints the notes itself — exactly once per build either way.
  let versionResolved: Awaited<ReturnType<typeof buildVersionFor>>;
  try {
    versionResolved = await buildVersionFor(
      root,
      mainConfig.version,
      {
        out: (mainConfig.build as { out?: string } | undefined)?.out,
        // A previous build's artifact left in the project root (the
        // single-target build writes there) is an OUTPUT, not a change: the
        // onboarding lab built the same scaffold twice and got two dirty
        // hashes for one codebase.
        isOutput: (rel) =>
          !rel.includes("/") && isArtifactName(rel, binaryName),
      },
    );
  } catch (e) {
    // A refused version is a written message with the fix in it — print it,
    // never a stack.
    console.error(e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  }
  const { bv: version, fromFleet } = versionResolved;
  // Notes are for a person: stderr. The version line is progress, stdout —
  // except when the build was asked a QUESTION (`--print-*`), whose stdout is
  // an answer a script parses (the onboarding one-liner read
  // "version …" as a path once).
  const asked = isBuildQuestion(Deno.args);
  if (!fromFleet && !asked) {
    for (const n of buildVersionNotes(version)) warn(n);
    step("version", version.version);
  }
  const appDir = resolveAppDir(root, configEntry);
  // UI entry: --ui= (per-target, from build-all) else deno.json build.ui,
  // else the App.tsx convention — validated NOW, at the build, not as a
  // missing-module error deep inside esbuild.
  const uiExplicit = uiArg ??
    (mainConfig.build as { ui?: string } | undefined)?.ui;
  const uiEntry = uiExplicit ?? UI_ENTRY;
  // Validate only an EXPLICIT ui entry — the App.tsx convention may
  // legitimately be absent (headless/CLI builds bundle no UI), and the bundle
  // step already decides that case.
  if (uiExplicit !== undefined) {
    try {
      await Deno.stat(join(appDir, uiEntry));
    } catch {
      console.error(
        `${NO} UI entry not found: ${join(appDir, uiEntry)}\n` +
          `  (from ${
            uiArg !== undefined ? "--ui=" : "deno.json build.ui"
          }; the path is relative to the app dir — the directory of the entry module)`,
      );
      Deno.exit(1);
    }
  }
  const outDir = resolve(root, outArg ?? ".");
  // dist/ is STAGING, not a destination: `deno compile --include dist/` embeds
  // it wholesale, and every build wipes what it does not own there — an
  // artifact collected inside it is embedded into the next binary AND deleted
  // by the build after that. Both are silent. Refuse, and name the fix.
  if (outDir === dist || outDir.startsWith(dist + SEPARATOR)) {
    console.error(
      `${NO} --out=${outArg} points inside dist/ — dist/ is the bundle ` +
        `staging dir: it is embedded into the binary wholesale and wiped by ` +
        `every build. Pick another directory (--out=release, --out=out/agent).`,
    );
    Deno.exit(1);
  }
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

  const androidApplicationId =
    (mainConfig.android as { applicationId?: string } | undefined)
      ?.applicationId;
  const androidDevUrl = Deno.args.find((a) =>
    a.startsWith("--android-dev-url=")
  )?.slice("--android-dev-url=".length);

  // os/arch describe the artifact being BUILT, not the machine building it.
  // They were `Deno.build.*`, which was harmless while only the host's shell
  // could be packaged — and became a silent wrong answer the moment Electron
  // could cross-build: `--platform=windows` produced a LINUX AppImage and the
  // summary called it the windows artifact. Resolved from the platform spec
  // below (see `platform`), which is the same table the triple comes from.

  // --platform=<name>: which OS/arch this binary is FOR. Defaults to the host,
  // so every existing invocation behaves exactly as before.
  const rawPlatform = Deno.args.find((a) => a.startsWith("--platform="))
    ?.slice("--platform=".length) ?? "host";
  const resolved = resolvePlatforms([rawPlatform]);
  if (!resolved.ok) {
    bad(resolved.error);
    Deno.exit(1);
  }
  const platform = resolved.platforms[0] ?? hostPlatform();
  const spec = PLATFORMS[platform]!;
  const os = spec.os;
  const arch = spec.arch;
  const archStr = arch === "aarch64" ? "arm64" : "x64";
  // A cross build must not pretend it can package something this host cannot.
  // `crossCompileBlocker` is the ONE decider — it answers per (target,
  // platform, host), because Electron for Windows/macOS is a download plus a
  // zip while Electron for Linux is an AppImage and needs `appimagetool`.
  // Asking it without the platform is what produced "cannot be combined with
  // --electron: null" — a refusal whose reason was the absence of one.
  if (!isHostPlatform(platform)) {
    const shell = doElectron
      ? "electron"
      : doAndroid
      ? "android"
      : doIos
      ? "ios"
      : null;
    const why = shell ? crossCompileBlocker(shell, platform) : null;
    if (shell && why) {
      console.error(
        `${NO} --platform=${platform} cannot be combined with ` +
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
    doIos,
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
    allowServerOnly: Deno.args.includes("--allow-server-only"),
    entryFromFlag: entryArg !== undefined,
    bakedServer: bakedServerUrl(
      (mainConfig.build as { server?: string } | undefined)?.server,
    ),
    binaryName,
    appTitle,
    version,
    configEntry,
    appDir,
    uiEntry,
    outDir,
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
