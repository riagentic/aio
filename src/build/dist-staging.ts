// dist-staging.ts — what survives the clean that runs before `deno compile`.
//
// NOT exported from `src/build.ts`. That file is the `aio/build` entry, so
// anything on it is public surface and frozen forever; this is an internal
// rule about one directory, and a rule does not become an API by needing a
// test.
import { join } from "@std/path";
import {
  APP_ICON,
  APP_STYLE,
  BUNDLE_JS,
  BUNDLE_MAP,
  isWorkerBundle,
} from "../server/app-files.ts";
import { ELECTRON_VERSION_FILE } from "../electron/electron-runtime-fetch.ts";
import { moveArtifact } from "./build-helpers.ts";

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
  // …and the browser workers' bundles, which are named by the app's own
  // files: a pattern, not a list.
  return DIST_STAGED.includes(name) || isWorkerBundle(name);
}

/** Copy the browser workers' bundles (`isWorkerBundle`) from `dist` to
 *  `to` — beside the bundle that starts them, wherever a target puts that.
 *  Returns their names. A copy that fails throws: a page whose worker did not
 *  travel with it loads and then does nothing. */
export async function copyWorkerBundles(
  dist: string,
  to: string,
): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(dist)) {
    if (e.isFile && isWorkerBundle(e.name)) names.push(e.name);
  }
  for (const name of names.sort()) {
    await Deno.copyFile(join(dist, name), join(to, name));
  }
  return names;
}

/** The files every build stages in dist/ — see {@linkcode keepInDistStaging}. */
export const DIST_STAGED: readonly string[] = [
  BUNDLE_JS,
  APP_STYLE,
  APP_ICON,
  ELECTRON_VERSION_FILE,
  // The generated monogram as SVG, written beside icon.png by the bundle
  // step and read by the packaged shell's `/__aio/icon` fallback
  // (electron-uds.ts) — dropped by this clean in between until it was listed.
  "icon.svg",
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

/** The `dist/` entries a previous build left there as its OUTPUT (`out` was
 *  dist/), which the staging clean of a build to ANOTHER out would delete:
 *  with a release `manifest.json` present, it and every entry that is not
 *  staging (dotfiles aside), sorted — else []. Pure.
 *
 *  From a field report: `"out": "dist"` held the last release, a test build
 *  with `--out=dist-online` emptied dist/ as staging, and the release was
 *  gone without a word. */
export function distRelease(entries: readonly string[]): string[] {
  if (!entries.includes("manifest.json")) return [];
  return entries.filter((e) => !e.startsWith(".") && !keepInDistStaging(e))
    .sort();
}

/** Move a previous release out of `dist` (see {@linkcode distRelease}) into
 *  `to`, before a build whose out is elsewhere empties dist/. Returns the
 *  names moved — [] when there was none (or no dist/). A move that fails
 *  throws: the caller must not build over what is left. */
export async function keepDistRelease(
  dist: string,
  to: string,
): Promise<string[]> {
  const entries: string[] = [];
  try {
    for await (const e of Deno.readDir(dist)) entries.push(e.name);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  const names = distRelease(entries);
  if (names.length === 0) return [];
  await Deno.mkdir(to, { recursive: true });
  for (const n of names) await moveArtifact(join(dist, n), join(to, n));
  return names;
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

/** What to say about the release that was in the out dir, at the two moments
 *  it is at risk. `aside`: it could not be set aside before the build.
 *  `failed`: the build produced nothing to put in its place.
 *
 *  Whether it survives depends on whose directory `out` is. `dist/` is the
 *  builds' own staging, emptied by every one of them, so a release that was
 *  not set aside is gone. Any other out dir is written only when there are
 *  artifacts to place: it is as it was — and the build used to say "holds no
 *  release" about a directory with the last good release still in it. Pure. */
export function previousReleaseNote(
  when: "aside" | "failed",
  rel: string,
  o: { preserved: boolean; outIsStaging: boolean },
): string {
  if (when === "aside") {
    return `It is still there and still intact` +
      (o.outIsStaging
        ? `, but this build will overwrite it: if it fails, there is no ` +
          `release to put back.`
        : `, and stays so until this build has artifacts to replace it with.`);
  }
  if (o.preserved) return `the previous ${rel}/ is intact`;
  return o.outIsStaging ? `${rel}/ holds no release` : `${rel}/ is as it was`;
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
    // aio-ok: path-split — `keep` is documented relative and `/`-separated (emptyDir)
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
 *  Another filesystem (an out dir on its own mount, a bind-mounted `dist/`):
 *  each entry is copied and removed instead ({@link moveArtifact}). It used
 *  to throw there, so on such a project NO build ever set its previous
 *  release aside: a failed build had nothing to put back, and a narrower one
 *  could not say which targets it had dropped. `rename` is injectable so that
 *  path runs on one filesystem.
 *
 *  Returns false when `from` does not exist — the caller's "there was no
 *  previous release to protect", said once rather than inferred from a catch.
 *
 *  ALL OR NOTHING. What this replaced was a single `rename(dir, aside)`, which
 *  the filesystem made atomic for free; N renames are not, and the caller
 *  treats a throw as "there was nothing to protect" and carries on. Half a
 *  release left in the directory and the other half discarded with the staging
 *  tree is worse than either outcome, and it is reachable: a copy that runs
 *  out of space half way. So a failure rolls every moved entry back before
 *  rethrowing, and the caller's catch then means what it always meant.
 *
 *  This is the inode-preserving half of what the rename used to do; see
 *  {@link emptyDir} for why the directory must not move. */
export async function moveDirContents(
  from: string,
  to: string,
  rename: (from: string, to: string) => Promise<void> = Deno.rename,
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
      await moveArtifact(`${from}/${n}`, `${to}/${n}`, rename);
      moved.push(n);
    }
  } catch (e) {
    // Back, one by one, in the order they went. A rollback that itself fails
    // must not replace the original error — that one says what went wrong.
    for (const n of moved) {
      try {
        await moveArtifact(`${to}/${n}`, `${from}/${n}`, rename);
      } catch { /* aio-ok: the original error below is the one to report */ }
    }
    throw e;
  }
  return true;
}

/** esbuild's input record for `dist/app.js`, relative to the project root
 *  (build-bundle.ts writes and reads it — the freshness check's half that is
 *  not in dist/). */
export const BUNDLE_INPUTS = join(".aio", "bundle-inputs.json");

/** Where a fleet whose `out` IS dist/ keeps the staged bundle between builds,
 *  relative to the project root (see {@linkcode stashBundle}). */
export const BUNDLE_CACHE = join(".aio", "bundle-cache");

const RECORD = "bundle-inputs.json";

async function removeIfThere(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/** Move dist/'s staged bundle ({@linkcode keepInDistStaging}) and its input
 *  record into {@linkcode BUNDLE_CACHE}, before a fleet with the default
 *  `out: "dist"` empties dist/ into the release. Without it every
 *  `deno task build` re-ran esbuild: the release placement deleted the bundle
 *  the next build's freshness check needed.
 *
 *  The bundle and its record move as ONE pair, and by rename only: a copy
 *  gets a new mtime, and freshness is "app.js newer than every input" — a
 *  copied app.js would look newer than an edit it never saw. A move that
 *  fails is said and leaves no cache (the next build rebuilds: correct, only
 *  slower). Returns the names cached. */
export async function stashBundle(
  root: string,
  dist: string,
  /** The cache dir, relative to `root` — a {@linkcode parkOtherShape} slot. */
  at: string = BUNDLE_CACHE,
): Promise<string[]> {
  const cache = join(root, at);
  await removeIfThere(cache);
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dist)) {
      // Not electron.json: build.ts writes it, not the bundle step, so a
      // restored copy could reach a target that would otherwise have none.
      if (
        e.isFile && keepInDistStaging(e.name) &&
        e.name !== ELECTRON_VERSION_FILE
      ) names.push(e.name);
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  const record = join(root, BUNDLE_INPUTS);
  // No bundle or no record: nothing a later build could trust.
  if (!names.includes(BUNDLE_JS)) return [];
  try {
    await Deno.stat(record);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  try {
    await Deno.mkdir(cache, { recursive: true });
    for (const n of names) await Deno.rename(join(dist, n), join(cache, n));
    await Deno.rename(record, join(cache, RECORD));
    return names;
  } catch (e) {
    console.warn(
      `⚠ could not keep the bundle in ${at}: ${e} — the next ` +
        `build re-runs esbuild`,
    );
    await removeIfThere(cache);
    return [];
  }
}

/** Put a {@linkcode stashBundle}d bundle back into the (empty) dist/ staging,
 *  with its record — so the targets' builds find exactly what the last one
 *  left there, the same as with any other `out`. The record already in
 *  `.aio/` described the dist/ that was just moved aside, so it goes first
 *  either way. A cache without its record is never restored. Returns whether
 *  a bundle was restored. */
export async function restoreBundle(
  root: string,
  dist: string,
  /** The cache dir, relative to `root` — a {@linkcode parkOtherShape} slot. */
  at: string = BUNDLE_CACHE,
): Promise<boolean> {
  const cache = join(root, at);
  const record = join(root, BUNDLE_INPUTS);
  await removeIfThere(record);
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(cache)) names.push(e.name);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
  try {
    if (!names.includes(RECORD)) return false;
    await Deno.mkdir(dist, { recursive: true });
    for (const n of names) {
      if (n !== RECORD) await Deno.rename(join(cache, n), join(dist, n));
    }
    await Deno.rename(join(cache, RECORD), record);
    return true;
  } catch (e) {
    console.warn(
      `⚠ could not restore the bundle from ${at}: ${e} — this ` +
        `build re-runs esbuild`,
    );
    await removeIfThere(record);
    return false;
  } finally {
    await removeIfThere(cache);
  }
}

/** Where a bundle of ANOTHER shape waits while a target of this one builds,
 *  relative to the project root: one slot per shape + UI entry. */
export const BUNDLE_SHAPES = join(".aio", "bundle-shapes");

/** A slot name for a bundle's stamps (`readBundleStamps`). */
const slotOf = (target: string, ui: string) =>
  `${target}-${ui.replace(/[^A-Za-z0-9._-]/g, "_")}`;

/** Before a target bundles: when dist/ holds the bundle of ANOTHER shape or
 *  UI entry (`have`, its stamps), park it — with its input record — in its
 *  {@linkcode BUNDLE_SHAPES} slot, and bring back this target's own slot
 *  (`want`) if an earlier build parked one.
 *
 *  One dist/app.js serves every target, so a fleet mixing shapes (a browser
 *  and a web or android target) re-ran esbuild for BOTH on every build: each
 *  target found the other's bundle. Moved by rename, so the freshness check
 *  compares real mtimes; that check still decides — a restored bundle whose
 *  sources moved is rebuilt. Nothing is restored over a bundle that could
 *  not be parked (no record): what the target builds replaces it whole.
 *  Returns whether a bundle was restored. */
export async function parkOtherShape(
  root: string,
  dist: string,
  have: { target?: string; ui: string } | null,
  want: { target: string; ui: string },
): Promise<boolean> {
  const wanted = slotOf(want.target, want.ui);
  if (have) {
    if (!have.target) return false; // unstamped: not ours to sort
    const held = slotOf(have.target, have.ui);
    if (held === wanted) return false;
    const parked = await stashBundle(root, dist, join(BUNDLE_SHAPES, held));
    if (parked.length === 0) return false;
  }
  return await restoreBundle(root, dist, join(BUNDLE_SHAPES, wanted));
}
