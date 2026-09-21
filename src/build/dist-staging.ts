// dist-staging.ts — what survives the clean that runs before `deno compile`.
//
// NOT exported from `src/build.ts`. That file is the `aio/build` entry, so
// anything on it is public surface and frozen forever; this is an internal
// rule about one directory, and a rule does not become an API by needing a
// test.
import {
  APP_ICON,
  APP_STYLE,
  BUNDLE_JS,
  BUNDLE_MAP,
} from "../server/app-files.ts";
import { ELECTRON_VERSION_FILE } from "../electron/electron-runtime-fetch.ts";

/** Which `dist/` entries survive the staging clean that runs before
 *  `deno compile`.
 *
 *  dist/ is STAGING, never a destination: anything left in it ships inside the
 *  binary, so the clean cannot be narrowed to "files this build wrote" without
 *  also shipping the previous target's leftovers. That makes this an
 *  ALLOWLIST, and an allowlist is a place for a new artifact to be silently
 *  dropped — which is exactly what happened to `BUNDLE_MAP`: the bundle step
 *  wrote it and the server read it, and this loop deleted it in between, so
 *  the feature was present at both ends and absent in the middle. A named,
 *  tested predicate is the fix: adding a staged file means adding it here, and
 *  a test can ask the question directly. */
export function keepInDistStaging(name: string): boolean {
  return name === BUNDLE_JS || name === APP_STYLE ||
    name === APP_ICON || name === ELECTRON_VERSION_FILE ||
    // The client bundle's source map — how a forwarded browser error names
    // the author's file instead of `app.js:1:22073`.
    name === BUNDLE_MAP;
}

// ── the directory itself ────────────────────────────────────────────────────

/** Empty `dir` — remove everything INSIDE it and leave the directory itself,
 *  with its inode, exactly where it was. A missing `dir` is not an error.
 *
 *  Why the inode matters, from a field report that cost an afternoon: a lab VM
 *  bind-mounts the app's `dist/` and serves it to the guest. The build used to
 *  `rename` that directory aside and `mkdir` a fresh one — and a bind mount
 *  follows the INODE, not the path, so from the next rebuild on the guest saw
 *  an EMPTY share, for the life of the lab, while every host-side reading
 *  (`am lab`'s hand-off, the share server, `ls dist/`) was correct. A 404 from
 *  a server that was just shown serving that exact file reads as "the build is
 *  broken", and both halves of that are wrong.
 *
 *  A bind mount is only the loudest victim. An open `cd dist`, a file watcher,
 *  an editor's tree and a `docker run -v` all hold the inode, and replacing it
 *  silently strands every one of them. Nothing wants the directory replaced;
 *  what the build wants is for it to be empty, and that is what this does. */
export async function emptyDir(dir: string): Promise<void> {
  try {
    for await (const e of Deno.readDir(dir)) {
      await Deno.remove(`${dir}/${e.name}`, { recursive: true });
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/** Move every entry of `from` into `to`, leaving both directories themselves
 *  in place (`to` is created). Same filesystem: each entry is a rename, so
 *  nothing is copied and a 700 MB artifact costs what a rename costs.
 *
 *  Returns false when `from` does not exist — the caller's "there was no
 *  previous release to protect", said once rather than inferred from a catch.
 *
 *  ALL OR NOTHING. What this replaced was a single `rename(dir, aside)`, which
 *  the filesystem made atomic for free; N renames are not, and the caller
 *  treats a throw as "there was nothing to protect" and carries on. Half a
 *  release left in the directory and the other half discarded with the staging
 *  tree is worse than either outcome, and it is reachable: `.aio/` on a
 *  different mount from `dist/` makes even the first rename throw EXDEV (the
 *  build's own `moveFile` exists for exactly that). So a failure rolls every
 *  moved entry back before rethrowing, and the caller's catch then means what
 *  it always meant.
 *
 *  This is the inode-preserving half of what the rename used to do; see
 *  {@link emptyDir} for why the directory must not move. */
export async function moveDirContents(
  from: string,
  to: string,
): Promise<boolean> {
  let names: string[];
  try {
    names = [];
    for await (const e of Deno.readDir(from)) names.push(e.name);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
  await Deno.mkdir(to, { recursive: true });
  const moved: string[] = [];
  try {
    for (const n of names) {
      await Deno.rename(`${from}/${n}`, `${to}/${n}`);
      moved.push(n);
    }
  } catch (e) {
    // Back, one by one, in the order they went. A rollback that itself fails
    // must not replace the original error — that one says what went wrong.
    for (const n of moved) {
      try {
        await Deno.rename(`${to}/${n}`, `${from}/${n}`);
      } catch { /* aio-ok: the original error below is the one to report */ }
    }
    throw e;
  }
  return true;
}
