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
  return DIST_STAGED.includes(name);
}

/** The files every build stages in dist/ — see {@linkcode keepInDistStaging}. */
export const DIST_STAGED: readonly string[] = [
  BUNDLE_JS,
  APP_STYLE,
  APP_ICON,
  ELECTRON_VERSION_FILE,
  // The client bundle's source map — how a forwarded browser error names
  // the author's file instead of `app.js:1:22073`.
  BUNDLE_MAP,
];

/** The entries of a `dist/` no aio build ever wrote — non-empty, yet holding
 *  none of the files every build stages there ({@linkcode keepInDistStaging})
 *  and no release `manifest.json` — else []. Dotfiles (`.DS_Store`) decide
 *  nothing. Pure.
 *
 *  dist/ is exempt from the out-dir guard because aio owns it; a project that
 *  arrived with a `dist/` of its OWN (a web build's output, hand-placed files)
 *  had all of it deleted by its first `deno task build`, under a green
 *  summary. */
export function foreignDist(entries: readonly string[]): string[] {
  const named = entries.filter((e) => !e.startsWith("."));
  const ours = named.some((e) => keepInDistStaging(e) || e === "manifest.json");
  return ours ? [] : [...named].sort();
}

/** The refusal for a foreign `dist` directory (see {@linkcode foreignDist}),
 *  or null when it is aio's, empty or absent. Every path that empties dist/
 *  asks this first. */
export async function foreignDistRefusal(dist: string): Promise<string | null> {
  const entries: string[] = [];
  try {
    for await (const e of Deno.readDir(dist)) entries.push(e.name);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const foreign = foreignDist(entries);
  if (foreign.length === 0) return null;
  const shown = foreign.slice(0, 5).join(", ") +
    (foreign.length > 5 ? `, … (${foreign.length} in all)` : "");
  return `refusing to build: ${dist} holds files no aio build put there ` +
    `(${shown}), and dist/ is aio's staging dir, emptied on every build: ` +
    `they would be DELETED.\n  fix: move them out of dist/ first (dist/ ` +
    `cannot be renamed — the build always stages there).`;
}

/** The refusal for an artifact directory a build is about to EMPTY (the web
 *  site, the iOS project) when no aio build wrote it — it holds entries
 *  (dotfiles aside) but not `mark`, a file whose text includes `sign` — or
 *  null when it is aio's, empty or absent. The same rule as dist/: a user
 *  folder that happens to share the artifact's name is never emptied. */
export async function foreignArtifactRefusal(
  dir: string,
  mark: string,
  sign: string,
): Promise<string | null> {
  const entries: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.name.startsWith(".")) entries.push(e.name);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  if (entries.length === 0) return null;
  try {
    if ((await Deno.readTextFile(`${dir}/${mark}`)).includes(sign)) return null;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const shown = entries.sort().slice(0, 5).join(", ") +
    (entries.length > 5 ? `, … (${entries.length} in all)` : "");
  return `refusing to build: ${dir} holds files no aio build put there ` +
    `(${shown}), and the build empties that directory: they would be ` +
    `DELETED.\n  fix: move or rename that directory first.`;
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
 *  what the build wants is for it to be empty, and that is what this does.
 *
 *  `last`: the paths (relative, `/`-separated) that prove the directory is
 *  aio's — the file its foreign-directory check looks for. They go LAST, so a
 *  build interrupted mid-clean leaves a directory that still says whose it is:
 *  removed in readdir order, the proof could go first, and the next build
 *  refused the half-emptied folder as a user's, to be deleted by hand. */
export async function emptyDir(
  dir: string,
  last: readonly string[] = [],
): Promise<void> {
  const held = await clearExcept(dir, last);
  // Each held head in ONE removal: a nested proof (`App/x.swift`) removed
  // before its directory left an empty `App/` that proves nothing.
  for (const head of held) {
    try {
      await Deno.remove(`${dir}/${head}`, { recursive: true });
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}

/** Remove everything in `dir` except the `keep` paths (and the directories
 *  on the way to them); returns the top-level names kept. */
async function clearExcept(
  dir: string,
  keep: readonly string[],
): Promise<string[]> {
  const held = new Map<string, string[]>();
  for (const p of keep) {
    const [head = "", ...rest] = p.split("/");
    held.set(head, [
      ...(held.get(head) ?? []),
      ...(rest.length ? [rest.join("/")] : []),
    ]);
  }
  try {
    for await (const e of Deno.readDir(dir)) {
      if (held.has(e.name)) continue;
      await Deno.remove(`${dir}/${e.name}`, { recursive: true });
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  for (const [head, rest] of held) {
    if (rest.length) await clearExcept(`${dir}/${head}`, rest);
  }
  return [...held.keys()];
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
