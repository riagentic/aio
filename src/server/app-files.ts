/**
 * @module
 * The app's file conventions — ONE spelling each.
 *
 * These names were literals scattered across the build, the server, the dev
 * checks, the watcher, the linter and `am`: "App.tsx" alone appeared 26 times
 * in 12 files, almost always as `x ?? "App.tsx"` — every site independently
 * re-deciding the default. That is not a style problem, it is a bug generator,
 * and it has fired twice in one week:
 *
 *  • `ui.entry` was honoured by the dev server and ignored by the BUNDLER, so
 *    an app that renamed its root component rendered one thing under
 *    `deno task dev` and another once compiled (R-2).
 *  • the boot lint kept checking a hardcoded `App.tsx`, so an app that set
 *    `ui.entry` failed its OWN startup check while the server was about to
 *    serve the right file.
 *
 * Both are the same failure: a fact became configurable in one place and
 * stayed hardcoded in the others, because nothing named the fact. A default
 * spelled once can be threaded once; a default spelled twenty-six times has to
 * be FOUND twenty-six times, and the ones you miss are found by users.
 *
 * `tests/one-fact-one-spelling.test.ts` holds the line: the literal counts are
 * a shrink-only ledger, so a new hardcoded copy fails the gate and names this
 * module.
 */

/** The app's root component, relative to the app dir. Overridable per app:
 *  `ui.entry` (runtime) and `build.ui` / `--ui=` (the build). Callers should
 *  take the RESOLVED value where one exists and fall back to this only when
 *  there is genuinely no config in reach. */
export const UI_ENTRY = "App.tsx";

/** The app's stylesheet, beside the entry. Its presence is also the signal
 *  that the app owns its own styling (`ui.theme: "auto"` steps aside). */
export const APP_STYLE = "style.css";

/** The app's icon. PNG first — that is the file the build, Electron and
 *  Android all read, so a project with both cannot end up with a browser tab
 *  that disagrees with its taskbar entry. */
export const APP_ICON = "icon.png";

/** The bundle the browser loads in prod, inside {@link DIST_DIR}. */
export const BUNDLE_JS = "app.js";

/** Bundle STAGING — embedded into the binary wholesale and wiped by every
 *  build, which is why it is never where artifacts land (`--out=` is). */
export const DIST_DIR = "dist";

/** Where a build assembles things that are NOT its output: the AppImage
 *  `AppDir`, the generated Gradle project, and anything else a packager needs
 *  on disk to produce one file.
 *
 *  These used to live INSIDE `dist/` — `dist/AppDir/` held a whole copied
 *  Electron runtime (hundreds of MB) and was never removed, `dist/android/`
 *  held the Gradle project. So the directory an app author looks in for "what
 *  did this build produce" was mostly scaffolding, and no rule said which
 *  entries were output.
 *
 *  `dist/` is now exactly the answer to that question: artifacts, the browser
 *  assets they are built from, and `manifest.json`. Nothing nested. Scratch
 *  that is worth keeping between runs (Gradle's incremental state) is kept
 *  here rather than deleted, so flattening `dist/` costs no build time. */
export const BUILD_SCRATCH_DIR = ".aio/build";

/** The scaffold's entry module. THE entry decider is `resolveEntryPath()`;
 *  this is only its fallback when a project declares nothing. */
export const DEFAULT_ENTRY = "src/app.ts";

/** Does this app ship its own stylesheet? THE decider — the theme decision and
 *  the boot line that reports it must never answer differently.
 *
 *  Both dirs, because they are the same question asked from two places: the app
 *  dir is where a developer puts `style.css`, and `dist/` is where the build
 *  copied it — which is the ONLY one a compiled binary has, since `baseDir`
 *  there falls back to `<cwd>/src` and usually does not exist. Asking only the
 *  app dir is how a compiled app with a stylesheet had its shell correctly step
 *  aside while boot announced "the default look is in effect (no style.css)".
 */
export function appHasStylesheet(
  baseDir: string | null | undefined,
  distDir?: string | null,
): boolean {
  for (const dir of [baseDir, distDir]) {
    if (!dir) continue;
    try {
      Deno.statSync(`${dir}/${APP_STYLE}`);
      return true;
    } catch { /* next candidate */ }
  }
  return false;
}
