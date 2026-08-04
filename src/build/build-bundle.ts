/**
 * @module
 * Build bundle — esbuild bundling step, freshness cache check, asset copying.
 */
import { dirname, join, relative } from "@std/path";
import { ESBUILD_JSX } from "./esbuild-shared.ts";
import { aioBrowserPlugin } from "./esbuild-plugin.ts";
import { makeHttpPlugin } from "./build-integrity.ts";
import type { BuildConfig } from "./build-config.ts";
import { VERSION } from "../server/aio-cli.ts";
import { VERSION_STAMP } from "../protocol/protocol-version.ts";

/** Directories a source walk must never descend into. `dist` holds the walk's
 *  OWN output (freshly copied files there would flag the bundle stale
 *  forever), the rest are vendored or generated. Named here rather than
 *  avoided by not-walking, so a flat-layout app — entry at the project root,
 *  components in `components/` — is walked to the same depth as a `src/` one.
 *  It used to be walked one level deep, so an edit below the root silently
 *  kept serving a cached bundle. */
/*  Deliberately SHORT. Skipping a directory that turns out to hold real
 *  sources would hide an edit behind a cached bundle — the exact failure this
 *  walk exists to prevent — so only trees that are generated output (`dist`,
 *  `coverage`) or vendored (`node_modules`) are listed. `vendor/` is NOT: an
 *  app may legitimately import from it. The Android project the build writes
 *  is not listed either — it lives under the out dir, which the caller skips
 *  by PATH (a name-based "android" skip here once hid a real `src/android/`
 *  source tree from the walk). */
const WALK_SKIP_DIRS = new Set([
  "dist",
  "node_modules",
  "coverage",
]);

/** Recursively yields .ts/.tsx/.css mtimes under a directory, skipping build
 *  output, vendored code, dot-directories, and `skipPaths` (absolute paths —
 *  the configured out dir, which may not be named `dist`). */
async function* walkSrcFiles(
  dir: string,
  skipPaths?: Set<string>,
): AsyncGenerator<number> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        if (
          entry.name.startsWith(".") || WALK_SKIP_DIRS.has(entry.name) ||
          skipPaths?.has(path)
        ) {
          continue;
        }
        yield* walkSrcFiles(path, skipPaths);
      } else if (entry.isFile && /\.(tsx?|css)$/.test(entry.name)) {
        const s = await Deno.stat(path);
        if (s.mtime) yield s.mtime.getTime();
      }
    }
  } catch { /* no dir — skip */ }
}

/** Checks if dist/app.js is newer than all bundle inputs */
async function isBundleFresh(cfg: BuildConfig): Promise<boolean> {
  const {
    out,
    doForce,
    doAndroid,
    isRemote,
    frameworkSrcDir,
    root,
  } = cfg;
  if (doForce) return false;
  // Framework identity + target shape beat every mtime heuristic: a bundle
  // built by another aio version — or for the OTHER target, since all targets
  // share dist/app.js — is stale no matter how new it looks (remote/JSR builds
  // pin the version, so the stamp is checked there too).
  if (!await bundleMatchesFramework(out, doAndroid)) return false;
  try {
    const outStat = await Deno.stat(out);
    if (!outStat.mtime) return false; // AIO-227: can't verify freshness → rebuild
    const outMtime = outStat.mtime.getTime();

    const dj = await Deno.stat(join(root, "deno.json"));
    if (dj.mtime && dj.mtime.getTime() >= outMtime) return false;

    // Framework sources (skipped for remote — the JSR version is pinned, and
    // the stamp check above already catches a version change).
    //
    // This used to be a HANDPICKED list of six paths, one of which
    // (`state/factory.ts`) stopped existing in the methods restructure. The
    // stat threw, the outer catch turned it into "not fresh", and the cache
    // was dead from that day on: every build re-ran esbuild and the
    // "cached — use --force to rebuild" line could never print. Nothing
    // failed, so nothing was noticed. A walk cannot rot the way a list of
    // paths does, and it is strictly more correct — ANY framework edit
    // invalidates the bundle, not just the six files someone once picked.
    if (!isRemote) {
      for await (const mtime of walkSrcFiles(frameworkSrcDir)) {
        if (mtime >= outMtime) return false;
      }
    }

    // Walk the WHOLE project tree, not just src/ + the app dir: the bundle's
    // inputs are whatever the entry imports, and an app whose entry lives at
    // `apps/web/main.ts` may import from `packages/shared/` or `vendor/` —
    // dirs no shortlist can guess. The generated out dir is skipped by PATH
    // (it may not be named `dist`); node_modules, coverage and dot-dirs by
    // name. Equal mtimes count as stale (`>=`): a coarse-granularity fs can
    // land an edit in the artifact's own timestamp.
    const skipPaths = new Set([dirname(out)]);
    for await (const mtime of walkSrcFiles(root, skipPaths)) {
      if (mtime >= outMtime) return false;
    }
    return true;
  } catch {
    return false; /* no dist/app.js — needs build */
  }
}

/** The aio version stamp the bundle carries. It makes the artifact
 *  self-describing: the client announces it in the protocol handshake (so a
 *  version mismatch names which side is stale instead of "protocol v1 vs v2"),
 *  and `isBundleFresh` reads it back to invalidate a bundle built by a
 *  different aio — the mtime heuristic alone silently kept a stale dist/app.js
 *  after a framework upgrade, leaving a v1 client talking to a v2 server. */
export function versionStamp(version: string): string {
  return `globalThis.${VERSION_STAMP} = ${JSON.stringify(version)};\n`;
}

/** The bundle SHAPE stamp. Every target writes the same `dist/app.js`, but a
 *  browser bundle is ESM exporting `mount()` and an android bundle is an IIFE
 *  that auto-mounts — swap one for the other and the page does nothing. The
 *  mtimes are identical either way, so shape has to be recorded IN the
 *  artifact for the freshness check to tell them apart; without it, building
 *  `--android` after a browser build would happily reuse a bundle that cannot
 *  boot in a WebView. */
function targetStamp(doAndroid: boolean): string {
  return `globalThis.__aioBundleTarget = ${
    JSON.stringify(doAndroid ? "android" : "browser")
  };\n`;
}

/** The App.tsx import specifier for the generated entry (written at the
 *  project root), derived from THE app-dir decider (`cfg.appDir`) — never a
 *  hardcoded './src/App.tsx': the app dir is wherever the entry lives, exactly
 *  as the dev server resolves it (WYSIDIWYSIP). */
export function appImportSpecifier(root: string, appDir: string): string {
  const rel = relative(root, appDir).replaceAll("\\", "/");
  return rel === "" || rel === "." ? "./App.tsx" : `./${rel}/App.tsx`;
}

/** Generate the esbuild entry point code.
 *  Android (standalone WebView) auto-mounts — the generated index.html loads
 *  the bundle as a classic script, so there is no importer to call mount(). */
function makeEntryCode(doAndroid: boolean, appImport: string): string {
  const stamp = versionStamp(VERSION) + targetStamp(doAndroid);
  if (doAndroid) {
    return stamp + `\
import { mount as _mount } from 'aio/renderer'
import { ensureConnected } from 'aio/air'
import App from ${JSON.stringify(appImport)}
function boot() { ensureConnected(); _mount(document.getElementById('root'), App) }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
`;
  }
  return stamp + `\
import { mount as _mount } from 'aio/renderer'
import { ensureConnected } from 'aio/air'
import App from ${JSON.stringify(appImport)}
export function mount(el) { ensureConnected(); _mount(el, App) }
`;
}

/** True when dist/app.js was built by THIS aio version (reads the stamp back).
 *  A framework upgrade must invalidate the bundle even when every mtime says
 *  it's fresh — otherwise the shipped client keeps speaking the old wire
 *  protocol against a new server. */
async function bundleMatchesFramework(
  out: string,
  doAndroid: boolean,
): Promise<boolean> {
  try {
    const js = await Deno.readTextFile(out);
    return js.includes(versionStamp(VERSION).trim()) &&
      js.includes(targetStamp(doAndroid).trim());
  } catch {
    return false;
  }
}

/** Run the esbuild bundle step. Exits process on failure. */
export async function runBundle(
  cfg: BuildConfig,
  mainConfig: Record<string, unknown>,
): Promise<void> {
  const {
    out,
    dist,
    root,
    isRemote,
    frameworkSrcDir,
    doAndroid,
    appDir,
  } = cfg;

  // The decider must have RUN. `join(undefined, "App.tsx")` returns "." —
  // a directory that always stats fine — so a config built without `appDir`
  // sailed past the check below and died 60 lines later inside @std/path.
  // A missing decider is a broken build, and it says so here.
  if (typeof appDir !== "string" || appDir === "") {
    console.error(
      "[build] ✗ BuildConfig.appDir is unset — build it with " +
        "loadBuildConfig() (or resolveAppDir(root, entry)); the app dir is " +
        "the one rule that decides where App.tsx, style.css and icon.png " +
        "live, in dev and in the packaged app alike.",
    );
    Deno.exit(1);
  }

  // Fail loud BEFORE esbuild: the UI entry must exist where the decider says
  // the app lives. esbuild's own "could not resolve" names a generated temp
  // file; this names the rule that produced the path.
  const appEntry = join(appDir, "App.tsx");
  try {
    await Deno.stat(appEntry);
  } catch {
    console.error(
      `[build] ✗ ${appEntry} not found — the app dir is the entry's directory ` +
        `(deno.json "entry": ${cfg.configEntry}), the same place the dev server loads the UI from. ` +
        `Put App.tsx next to your entry, or set "entry" in deno.json to where the app lives.`,
    );
    Deno.exit(1);
  }

  const bundleFresh = await isBundleFresh(cfg);

  if (bundleFresh) {
    const s = await Deno.stat(out);
    console.log(
      `[build] \u2713 dist/app.js cached (${
        (s.size / 1024).toFixed(1)
      } KB) — use --force to rebuild`,
    );
  } else {
    // Clean dist/ and rebuild
    try {
      await Deno.remove(dist, { recursive: true });
    } catch { /* no dist — skip */ }
    await Deno.mkdir(dist, { recursive: true });

    // Build import map for esbuild
    const fwEntry = doAndroid ? "standalone-air.ts" : "browser-air.ts";
    const aioEntry = isRemote ? null : join(frameworkSrcDir, fwEntry);
    const aioImports = frameworkSrcDir
      ? {
        "aio/jsx-runtime": join(frameworkSrcDir, "jsx-runtime.ts"),
        "aio/renderer": join(frameworkSrcDir, "air/aio-renderer.ts"),
      }
      : {};
    const buildConfig = {
      compilerOptions: mainConfig.compilerOptions,
      imports: {
        ...(mainConfig.imports as Record<string, string>),
        ...(aioEntry ? { "aio": aioEntry, "aio/air": aioEntry } : {}),
        ...aioImports,
      },
    };
    const buildConfigPath = join(root, "_build.json");
    await Deno.writeTextFile(
      buildConfigPath,
      JSON.stringify(buildConfig, null, 2),
    );

    // Generate temp entry
    const buildEntryPath = join(root, "_build_entry.tsx");
    const entryCode = makeEntryCode(
      doAndroid,
      appImportSpecifier(root, appDir),
    );
    await Deno.writeTextFile(buildEntryPath, entryCode);

    // esbuild alias: skip npm:/jsr: specifiers (resolved via node_modules)
    const esbuildAlias: Record<string, string> = {};
    for (
      const [k, v] of Object.entries(
        buildConfig.imports as Record<string, string>,
      )
    ) {
      if (!v.startsWith("npm:") && !v.startsWith("jsr:")) esbuildAlias[k] = v;
    }

    let bundleOk = false;
    try {
      // B-6: pin the EXACT version deno.json pins (esbuild@0.24.2) so dev
      // transpile and prod bundle never resolve a different esbuild than tested.
      // deno-lint-ignore no-import-prefix
      const esbuild = await import("npm:esbuild@0.24.2");
      const jsxConfig = ESBUILD_JSX; // shared dev==prod JSX config

      const result = await esbuild.build({
        entryPoints: [buildEntryPath],
        bundle: true,
        // classic <script> in the WebView HTML — ESM would throw on `export`
        format: doAndroid ? "iife" : "esm",
        platform: "browser",
        target: "esnext",
        outfile: out,
        ...jsxConfig,
        alias: esbuildAlias,
        plugins: isRemote
          ? [aioBrowserPlugin(), makeHttpPlugin(cfg)]
          : [aioBrowserPlugin()],
        nodePaths: [join(root, "node_modules")],
        logLevel: "warning",
      });
      bundleOk = (result.errors?.length ?? 0) === 0;
    } catch (e) {
      console.error(`[build] \u2717 esbuild failed: ${e}`);
    } finally {
      await Deno.remove(buildConfigPath).catch(() => {});
      await Deno.remove(buildEntryPath).catch(() => {});
    }

    if (!bundleOk) {
      console.error("[build] \u2717 bundle failed");
      Deno.exit(1);
    }

    const stat = await Deno.stat(out);
    console.log(
      `[build] \u2713 dist/app.js (${(stat.size / 1024).toFixed(1)} KB)`,
    );
  }

  // Copy style.css to dist/ -- from THE app dir (cfg.appDir), the same place
  // the dev server serves it from (its hasCSS check reads baseDir). A
  // hardcoded src/ here shipped apps whose stylesheet existed in dev and
  // silently vanished from the prod build: the "white border" class (no CSS,
  // default 8px body margin). WYSIDIWYSIP: one decider, and a copy failure of
  // an EXISTING stylesheet is a broken build, never an optional skip.
  await Deno.mkdir(dist, { recursive: true });
  const styleSrc = join(appDir, "style.css");
  let hasStyle = false;
  try {
    await Deno.stat(styleSrc);
    hasStyle = true;
  } catch { /* no style.css at the app dir; legacy src/ checked below */ }
  if (hasStyle) {
    await Deno.copyFile(styleSrc, join(dist, "style.css"));
    console.log("[build] \u2713 dist/style.css");
  } else if (appDir !== join(root, "src")) {
    // The legacy trap, made loud: a style.css at src/ that the app-dir rule
    // does NOT cover was never served in dev; silently shipping it would make
    // prod differ from dev in the other direction. Refuse with the fix.
    let strayStyle = false;
    try {
      await Deno.stat(join(root, "src", "style.css"));
      strayStyle = true;
    } catch { /* no stray stylesheet */ }
    if (strayStyle) {
      console.error(
        "[build] ✗ src/style.css exists but the app dir is " + appDir +
          " (the entry's directory, where dev serves the UI from). " +
          "Move style.css next to your entry so dev and prod agree (WYSIDIWYSIP).",
      );
      Deno.exit(1);
    }
  }
  if (!hasStyle) {
    // Deletion must ship too: an mtime walk cannot see a REMOVED file, so a
    // stale dist/style.css would keep styling prod after dev went unstyled —
    // the white-border bug in reverse. Same for icon.png below.
    await Deno.remove(join(dist, "style.css")).catch(() => {});
  }

  // Copy icon.png to dist/ if it exists (same decider as style.css)
  const iconSrc = join(appDir, "icon.png");
  let hasIcon = false;
  try {
    await Deno.stat(iconSrc);
    hasIcon = true;
  } catch { /* no icon.png at the app dir */ }
  if (hasIcon) {
    await Deno.copyFile(iconSrc, join(dist, "icon.png"));
    console.log("[build] \u2713 dist/icon.png");
  } else {
    await Deno.remove(join(dist, "icon.png")).catch(() => {});
  }
}
