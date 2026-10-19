// android-overlay-drift.ts — "the template your overlay replaces changed".
//
// An `android/` overlay file replaces aio's template file WHOLE, so it
// freezes that file at the day it was copied: two field reports shipped seven
// releases of template fixes (the keyed native store, AioNativeFetch, Back)
// that never reached their APK, with nothing said. The build cannot know what
// a file was copied from, so it records the template's hash the first time it
// sees an overlay replace it, and warns from the build on which that template
// changed. Kept in `.aio/` — the build's own, never part of the version — so
// recording dirties no tree.
import { join } from "@std/path";
import { sha256Hex } from "./ship.ts";

/** Path of the record, relative to the project root. */
export const OVERLAY_RECORD = ".aio/android-overlay.json";

/** Per overlaid template path: the template it was first seen replacing,
 *  the aio that shipped it, and the overlay's own content then. */
export type OverlayRecord = Record<
  string,
  { template: string; aio: string; overlay: string }
>;

/** The next record and the warnings, for the overlaid files that replace a
 *  template file. A file seen for the first time is recorded. A template
 *  that changed since is warned about — until the overlay itself changes
 *  (it was re-based), which records the pair afresh. Pure. */
export function overlayDrift(
  record: OverlayRecord,
  now: Record<string, { template: string; overlay: string }>,
  aio: string,
): { record: OverlayRecord; warnings: string[] } {
  const next: OverlayRecord = {};
  const warnings: string[] = [];
  for (const [path, h] of Object.entries(now).sort()) {
    const was = record[path];
    if (was && was.template !== h.template && was.overlay === h.overlay) {
      next[path] = was;
      warnings.push(
        `android/${path} overlays a template that changed since it was ` +
          `copied (aio ${was.aio} → ${aio}): what aio fixed in that file ` +
          `since does not reach this APK — fix: re-base it on aio's ` +
          `android-template/${path} (this warning stops once the overlay ` +
          `changes), or delete it to use the template.`,
      );
      continue;
    }
    next[path] = { ...h, aio: was?.template === h.template ? was.aio : aio };
  }
  return { record: next, warnings };
}

/** Read the record, compare, write it back; returns the warnings. `overlaid`
 *  are the overlay's paths (relative, `/`), `templates` aio's template. */
export async function checkOverlayDrift(
  root: string,
  overlaid: readonly string[],
  templates: Readonly<Record<string, string>>,
  aio: string,
): Promise<string[]> {
  const enc = new TextEncoder();
  const now: Record<string, { template: string; overlay: string }> = {};
  for (const p of overlaid) {
    const t = templates[p];
    if (t === undefined) continue; // an added file replaces nothing
    now[p] = {
      template: await sha256Hex(enc.encode(t)),
      overlay: await sha256Hex(
        await Deno.readFile(join(root, "android", p)),
      ),
    };
  }
  const file = join(root, OVERLAY_RECORD);
  let record: OverlayRecord = {};
  try {
    const raw = JSON.parse(await Deno.readTextFile(file));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) record = raw;
  } catch (e) {
    // A missing record is the first sight; a corrupt one is said, and
    // recorded afresh — drift detection restarts from this build.
    if (!(e instanceof Deno.errors.NotFound)) {
      console.warn(`⚠ ${OVERLAY_RECORD} is unreadable (${e}) — recording anew`);
    }
  }
  const r = overlayDrift(record, now, aio);
  if (JSON.stringify(r.record) !== JSON.stringify(record)) {
    await Deno.mkdir(join(root, ".aio"), { recursive: true });
    await Deno.writeTextFile(file, JSON.stringify(r.record, null, 2) + "\n");
  }
  return r.warnings;
}
