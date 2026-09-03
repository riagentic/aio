/**
 * @module
 * THE project-root resolver for `am` — one answer to "which project is this
 * invocation about?", shared by every reader of the project's config.
 *
 * `am` had two: `projectRoot()` (walks UP to the nearest deno.json — what
 * scoped `stop --all` and `doctor`) and `Deno.cwd()` (what `resolveAmAppId`,
 * the entry lookup, the component list and `am theme` read). From a
 * SUBDIRECTORY of an app they disagree: the first finds the app, the second
 * reads no deno.json at all and falls through to the directory's basename —
 * so `cd src && am status` asked about an app called "src" and reported it
 * stopped while the real one ran. Two deciders for one fact is the bug class;
 * this module is the one decider, dependency-free so both `am-utils` and
 * `am-components` can import it without a cycle.
 */
import { dirname, join, resolve, SEPARATOR as sep } from "@std/path";
import { DENO_JSON_NAMES } from "../server/deno-json.ts";

/** The project this `am` invocation is about: the nearest ancestor of the cwd
 *  holding a `deno.json`/`deno.jsonc`, or the cwd when there is none.
 *
 *  The walk UP is the point. A compiled app is routinely launched from
 *  somewhere inside its own project rather than the root — `dist/<app>/./<app>`
 *  is the normal way to run a built server — and its lock records THAT
 *  directory. Comparing against the bare cwd would leave exactly those
 *  instances running while reporting that everything stopped. */
export function projectRoot(from = Deno.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    for (const name of DENO_JSON_NAMES) {
      try {
        if (Deno.statSync(join(dir, name)).isFile) return dir;
      } catch { /* keep walking */ }
    }
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

/** Does the cwd sit inside a project at all — is there a deno.json at
 *  {@linkcode projectRoot}? When there is, the app id `am` derives from it is
 *  the project's own and never a guess. */
export function cwdIsProject(): boolean {
  const root = projectRoot();
  for (const name of DENO_JSON_NAMES) {
    try {
      if (Deno.statSync(join(root, name)).isFile) return true;
    } catch { /* not this name */ }
  }
  return false;
}

/** Is `path` inside `root` (or root itself)? Compared as path SEGMENTS, so
 *  `/home/u/remote-old` is not treated as living inside `/home/u/remote`. */
export function isUnder(root: string, path: string): boolean {
  const a = resolve(root);
  const b = resolve(path);
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}
