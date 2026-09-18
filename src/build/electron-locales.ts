/**
 * @module
 * Shrinking the Electron runtime safely — currently, its translations.
 *
 * Electron ships Chromium's UI strings in ~55 locales, and they are pure
 * application CHROME: menus, context items, error pages. An aio app's own text
 * lives in the Deno bundle, never in these files, so removing the ones an app
 * does not need cannot change a single string the app renders — the worst case
 * is Chromium's own menus in English.
 *
 * That makes it the largest SAFE saving in every desktop package, and it is
 * not a macOS-only one:
 *
 *   - **macOS** keeps them as `*.lproj` directories under the Electron
 *     framework's `Resources/` and the bundle's `Resources/` (≈66 MB).
 *   - **Linux / Windows** keep them as `locales/*.pak` beside the executable
 *     (≈46-49 MB), and the old packager shipped all of them.
 *
 * Both layouts are handled here rather than at each call site, because "which
 * locales survive" is one decision and a second copy of it would eventually
 * disagree with the first.
 */
import { join } from "@std/path";

/** Locales kept in a macOS runtime, by `.lproj` base name. */
export const DEFAULT_KEPT_LOCALES = ["en", "en_GB"] as const;

/** Locales kept in a Linux/Windows runtime, by `.pak` base name. Chromium
 *  spells these with regions (`en-US`), unlike the macOS bundle layout. */
export const DEFAULT_KEPT_LOCALE_PAKS = ["en-US", "en-GB"] as const;

/** Remove every `*.lproj` from a directory except those whose base name is in
 *  `keep`. Returns how many were removed; a missing directory is a no-op, since
 *  the layout differs between Electron versions and that is not a build error.
 *
 *  Pure-filesystem and synchronous (no I/O fan-out worth the ceremony for ~220
 *  small directories). */
export function trimLprojLocales(
  resourcesDir: string,
  keep: readonly string[] = DEFAULT_KEPT_LOCALES,
): number {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(resourcesDir)];
  } catch {
    return 0; // no Resources dir — nothing to trim
  }
  const kept = new Set(keep);
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory || !e.name.endsWith(".lproj")) continue;
    if (kept.has(e.name.slice(0, -".lproj".length))) continue;
    try {
      Deno.removeSync(join(resourcesDir, e.name), { recursive: true });
      removed++;
    } catch {
      // aio-ok: a locale that will not delete is bytes, not correctness, and
      // the caller reports the count it actually removed.
    }
  }
  return removed;
}

/** Remove every `*.pak` from a `locales/` directory except those in `keep`.
 *  Returns how many were removed, and is a no-op for a missing directory. */
export function trimLocalePaks(
  localesDir: string,
  keep: readonly string[] = DEFAULT_KEPT_LOCALE_PAKS,
): number {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(localesDir)];
  } catch {
    return 0;
  }
  const kept = new Set(keep);
  let removed = 0;
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(".pak")) continue;
    if (kept.has(e.name.slice(0, -".pak".length))) continue;
    try {
      Deno.removeSync(join(localesDir, e.name));
      removed++;
    } catch {
      // aio-ok: same rule as above — bytes, not correctness; the count is the
      // only thing the caller acts on.
    }
  }
  return removed;
}
