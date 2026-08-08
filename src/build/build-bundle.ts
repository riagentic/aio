/**
 * @module
 * Build bundle — esbuild bundling step, freshness cache check, asset copying.
 */
import { dirname, join, relative, resolve } from "@std/path";
import { bundleFrameworkEntries, ESBUILD_JSX } from "./esbuild-shared.ts";
import { aioBrowserPlugin } from "./esbuild-plugin.ts";
import { makeHttpPlugin } from "./build-integrity.ts";
import type { BuildConfig } from "./build-config.ts";
import { VERSION } from "../server/aio-cli.ts";
import { VERSION_STAMP } from "../protocol/protocol-version.ts";

/** Where the bundle's REAL input list is recorded — esbuild's own metafile,
 *  reduced to the local files it actually read.
 *
 *  Not inside `dist/`: the compile step embeds `dist/` verbatim into the
 *  binary (absolute build-machine paths have no business shipping), and
 *  `build.ts` sweeps everything but app.js/style.css/icon.png out of it before
 *  compiling — the record would be gone before the next freshness check. */
function inputsManifestPath(root: string): string {
  return join(root, ".aio", "bundle-inputs.json");
}

interface BundleInputs {
  v: 2;
  /** The artifact these inputs produced — a record for another out path says
   *  nothing about this one. */
  out: string;
  /** THE app-dir decider's answer for the app this bundle was built FROM
   *  (`BuildConfig.appDir`) — a record for another app says nothing about this
   *  one either.
   *
   *  EVERY target bundles to the same `dist/app.js`, so `out` alone cannot tell
   *  two apps apart. One repo CAN hold two: `"targets": { "server": { "entry":
   *  "src/relay/app.ts" }, "browser": { "entry": "src/app.ts" } }` is a
   *  documented, supported layout (see TargetOverride.entry). Without this
   *  field, the relay's build read the browser app's input record, found every
   *  path older than `dist/app.js`, printed "cached — use --force" and shipped
   *  the OTHER app's UI: same version stamp, same shape stamp, exit 0. The
   *  headless path is worse still — it never rebuilds, so `embedVerdict` saw
   *  `fresh: true` and embedded the wrong app's bundle verbatim. */
  app: string;
  inputs: string[];
}

/** The record version. Bumped when the record's KEY changes: an older record
 *  cannot say which app it belongs to, so it must not be trusted — a missing
 *  record means "rebuild", which is always safe. */
const BUNDLE_INPUTS_V = 2;

/** Persist esbuild's input set (absolute paths) next to the build state.
 *
 *  This is the ONLY honest dependency set. The heuristic it replaces walked
 *  the project tree for `.ts/.tsx/.css` FROM THE CWD, so it was wrong in two
 *  directions at once: `App.tsx` importing `./helper.js` or `./data.json` had
 *  those edits invisible (wrong extensions), and a monorepo app at
 *  `apps/web/` importing `../../packages/shared/lib.ts` had the whole sibling
 *  package invisible (wrong root) — both printed "cached — use --force" and
 *  shipped the OLD code, which `--compile` then embedded verbatim.
 *
 *  Every recorded path is stat'ed here, so entries that are not real local
 *  files (esbuild plugin namespaces, `http:`/`npm:` specifiers, the generated
 *  temp entry, which is deleted before this runs) never enter the list. */
async function writeBundleInputs(
  root: string,
  out: string,
  app: string,
  metafileInputs: Record<string, unknown> | undefined,
): Promise<void> {
  const inputs: string[] = [];
  for (const key of Object.keys(metafileInputs ?? {})) {
    // esbuild reports paths relative to the cwd it ran in (this process's).
    const abs = resolve(root, key);
    try {
      if ((await Deno.stat(abs)).isFile) inputs.push(abs);
    } catch { /* virtual/namespaced/remote input — nothing to stat */ }
  }
  const rec: BundleInputs = {
    v: BUNDLE_INPUTS_V,
    out,
    app,
    inputs: [...new Set(inputs)].sort(),
  };
  const path = inputsManifestPath(root);
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(rec) + "\n");
  } catch (e) {
    // A record we cannot write is a CACHE we cannot use — the next build
    // rebuilds, which is correct, just slower. Say so rather than leave the
    // "cached" line unexplainably absent forever.
    console.warn(
      `[build] \u26a0 could not record the bundle's inputs at ${path}: ${e} — ` +
        `every build will re-run esbuild until this is writable`,
    );
  }
}

/** The recorded input set for `out` AS BUILT FROM `app`, or null when there is
 *  no usable record. Both halves of the key must match: the record describes
 *  one artifact built from one app, and anything else is a rebuild. */
async function readBundleInputs(
  root: string,
  out: string,
  app: string,
): Promise<string[] | null> {
  try {
    const rec = JSON.parse(
      await Deno.readTextFile(inputsManifestPath(root)),
    ) as BundleInputs;
    if (
      rec?.v !== BUNDLE_INPUTS_V || rec.out !== out || rec.app !== app ||
      !Array.isArray(rec.inputs)
    ) {
      return null;
    }
    return rec.inputs;
  } catch {
    return null;
  }
}

/** Is `out` newer than every input esbuild actually read to produce it?
 *
 *  No record → NOT fresh. A guess about what the bundle depends on is what
 *  shipped stale code; the absence of the honest answer means rebuild. */
export async function isBundleFresh(cfg: BuildConfig): Promise<boolean> {
  const { out, doForce, doAndroid, root, appDir } = cfg;
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

    // deno.json is an input esbuild never sees: it supplies the import map and
    // compilerOptions the bundle was built with.
    const dj = await Deno.stat(join(root, "deno.json"));
    if (dj.mtime && dj.mtime.getTime() >= outMtime) return false;

    const inputs = await readBundleInputs(root, out, appDir);
    if (!inputs || inputs.length === 0) return false;
    for (const path of inputs) {
      // A DELETED input is a change too — stat throws, the catch below turns
      // it into "not fresh".
      const s = await Deno.stat(path);
      // Equal mtimes count as stale (`>=`): a coarse-granularity fs can land
      // an edit in the artifact's own timestamp.
      if (!s.mtime || s.mtime.getTime() >= outMtime) return false;
    }
    return true;
  } catch {
    return false; /* no dist/app.js, or an input vanished — needs build */
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

/** What a `dist/app.js` on disk SAYS it is: the aio version that built it and
 *  the target shape it was built for. `null` when there is no bundle at all.
 *
 *  THE stamp reader — both the path that REBUILDS ({@link isBundleFresh}) and
 *  the path that PACKAGES ({@link ensureEmbeddedBundle}) read it here. It was
 *  read by the rebuild path only, so a target that skips bundling embedded
 *  whatever `dist/` happened to hold: `compile:android` then `compile:service`
 *  shipped a server binary serving an IIFE that the prod shell mounts with
 *  `const { mount } = await import('/app.js')` → `mount` undefined → blank
 *  page, exit 0. */
export async function readBundleStamps(
  out: string,
): Promise<{ version?: string; target?: string } | null> {
  let js: string;
  try {
    js = await Deno.readTextFile(out);
  } catch {
    return null;
  }
  const pick = (name: string): string | undefined =>
    js.match(
      new RegExp(`globalThis\\.${name}\\s*=\\s*"([^"]*)"`),
    )?.[1];
  return { version: pick(VERSION_STAMP), target: pick("__aioBundleTarget") };
}

/** True when dist/app.js was built by THIS aio version AND for this target's
 *  shape (reads the stamps back). A framework upgrade must invalidate the
 *  bundle even when every mtime says it's fresh — otherwise the shipped client
 *  keeps speaking the old wire protocol against a new server. */
async function bundleMatchesFramework(
  out: string,
  doAndroid: boolean,
): Promise<boolean> {
  const s = await readBundleStamps(out);
  return !!s && s.version === VERSION &&
    s.target === (doAndroid ? "android" : "browser");
}

/** Human name for a bundle shape, for a message that has to name BOTH. */
function shapeName(t: string | undefined): string {
  return t === "android"
    ? "android (IIFE, auto-mounts, no `export`)"
    : t === "browser"
    ? "browser (ESM exporting mount())"
    : `${JSON.stringify(t ?? null)} (no target stamp — built by an older aio)`;
}

/** What the packaging path must DO about the bundle it is about to embed.
 *  Pure, so the whole table is a unit test instead of a claim about a code
 *  path that only runs inside a real `deno compile`. */
export type EmbedVerdict =
  | { action: "embed" }
  | { action: "rebuild"; message: string }
  | { action: "refuse"; message: string };

/** Decide whether `dist/app.js` may be embedded as-is by a target that did NOT
 *  build it.
 *
 *  `--headless`/server targets skip the bundle step but still
 *  `deno compile --include dist/`, so whatever `dist/` holds is what the binary
 *  serves — forever, since that target never rebuilds one. Two ways that goes
 *  wrong, both silent until a user opens the app:
 *
 *   1. WRONG SHAPE — `compile:android` leaves an IIFE in `dist/app.js`;
 *      `compile:service` then ships a server whose prod shell does
 *      `const { mount } = await import('/app.js')` → `mount` undefined → blank
 *      page, exit 0.
 *   2. STALE — an arbitrarily old browser bundle from some earlier build, since
 *      the server target never rebuilds one.
 *
 *  No bundle at all (`stamps === null`) is NOT an error: that is the headless
 *  build, and the prod server answers with the loud 503 "Headless build — no
 *  browser UI" page. */
export function embedVerdict(opts: {
  /** Stamps read off the artifact, or null when there is no artifact. */
  stamps: { version?: string; target?: string } | null;
  /** The shape THIS target embeds and serves. */
  want: "browser" | "android";
  /** The aio version doing the packaging. */
  version: string;
  /** Inputs-based freshness (irrelevant when the stamps already disagree). */
  fresh: boolean;
  /** Is there an App.tsx at the app dir to rebuild from? */
  canRebuild: boolean;
  /** For the message. */
  out: string;
  appEntry: string;
}): EmbedVerdict {
  const { stamps, want, version, out } = opts;
  if (!stamps) return { action: "embed" }; // no UI → the 503 page, unchanged
  const why = stamps.target !== want
    ? `holds a ${shapeName(stamps.target)} bundle, but this target embeds ` +
      `and serves the ${shapeName(want)} shape`
    : stamps.version !== version
    ? `was built by aio ${stamps.version ?? "(unstamped)"} — this build is ` +
      version
    : !opts.fresh
    // Both halves of the freshness key, named: `dist/app.js` is shared by
    // every target AND by every app in the repo, so "not fresh" means either
    // its own sources moved under it or it belongs to a different app.
    ? "is not the current bundle for this app (its sources changed, or it " +
      "was built from another app in this repo)"
    : null;
  if (why === null) return { action: "embed" };
  if (!opts.canRebuild) {
    return {
      action: "refuse",
      message:
        `[build] \u2717 ${out} ${why}, and there is no ${opts.appEntry} ` +
        `to rebuild it from.\n` +
        `        This target embeds dist/ verbatim — the binary would serve ` +
        `that bundle as-is.\n` +
        `        Rebuild the ${
          shapeName(want)
        } bundle for this app, or delete ` +
        `dist/ (a UI-less build serves the "no browser UI" page instead).`,
    };
  }
  return {
    action: "rebuild",
    message: `[build] \u26a0 ${out} ${why} — rebuilding the ${
      shapeName(want)
    } bundle before packaging`,
  };
}

/** Apply {@link embedVerdict} for a build that skipped the bundle step. */
export async function ensureEmbeddedBundle(
  cfg: BuildConfig,
  mainConfig: Record<string, unknown>,
): Promise<void> {
  const appEntry = join(cfg.appDir, "App.tsx");
  let canRebuild = false;
  try {
    canRebuild = (await Deno.stat(appEntry)).isFile;
  } catch { /* no UI source here */ }
  const verdict = embedVerdict({
    stamps: await readBundleStamps(cfg.out),
    want: cfg.doAndroid ? "android" : "browser",
    version: VERSION,
    fresh: await isBundleFresh({ ...cfg, doForce: false }),
    canRebuild,
    out: cfg.out,
    appEntry,
  });
  if (verdict.action === "embed") return;
  if (verdict.action === "refuse") {
    console.error(verdict.message);
    Deno.exit(1);
  }
  console.warn(verdict.message);
  await runBundle({ ...cfg, doForce: true }, mainConfig);
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
        `(${
          cfg.entryFromFlag
            ? `--entry=${cfg.configEntry}`
            : `deno.json "entry": ${cfg.configEntry}`
        }), the same place the dev server loads the UI from. ` +
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

    // Build import map for esbuild. THE `aio*` table (bundleFrameworkEntries)
    // is package-root relative; frameworkSrcDir is `<pkg>/src`. A remote (JSR)
    // framework has no local files at all — makeHttpPlugin applies the SAME
    // table against the fetched package instead.
    const aioImports = frameworkSrcDir
      ? Object.fromEntries(
        Object.entries(bundleFrameworkEntries(doAndroid)).map((
          [spec, rel],
        ) => [spec, join(dirname(frameworkSrcDir), rel)]),
      )
      : {};
    const buildConfig = {
      compilerOptions: mainConfig.compilerOptions,
      imports: {
        ...(mainConfig.imports as Record<string, string>),
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
    let metaInputs: Record<string, unknown> | undefined;
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
        // The module graph esbuild actually read — the freshness cache stats
        // THESE, instead of guessing extensions and roots (a guess shipped
        // stale bundles for `.js`/`.json` imports and for every monorepo
        // sibling package).
        metafile: true,
      });
      bundleOk = (result.errors?.length ?? 0) === 0;
      metaInputs = result.metafile?.inputs as
        | Record<string, unknown>
        | undefined;
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

    // Record the REAL inputs (after the temp entry/config are gone, so they
    // cannot enter the list and make every later build look stale).
    await writeBundleInputs(root, out, appDir, metaInputs);

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
