/**
 * @module
 * Framework versions for apps — the pin, the store, and the link between them.
 *
 * THE PROBLEM. A source-layout app imports aio through a gitignored `dep/aio`
 * symlink pointing at the one checkout on the machine. Commit the app, clone it
 * a month later (or on a colleague's box), run `am fix`, and it links to
 * whatever aio happens to be installed now. Nothing in the repo says which
 * version it was written against, so "it compiled last month" is not a fact you
 * can reproduce.
 *
 * THE FIX, in three parts, each deliberately dull:
 *
 *  1. The pin lives in the app's `deno.json` as `"aioVersion": "v1.0.0-alpha38"`
 *     — one string, committed, next to `appId`/`title` which already live there.
 *  2. Versions are provided as **git worktrees** of the install clone
 *     (`~/.local/lib/aio`, which install.sh creates with full history + tags).
 *     A worktree shares the object store, so a second version costs a checkout,
 *     not a download.
 *  3. `dep/aio` points at the pinned version's directory. `am link` / `am fix`
 *     read the pin and provision it, so clone → `am fix` → build is reproducible.
 *
 * THE INVARIANT: a committed pin is always EXACT. A tag is immutable by nature;
 * `main` is not, so `am pin main` RESOLVES it to `main-<sha>` and commits that.
 * "Follow main" is therefore an action you re-run (`am pin main` again), never a
 * stored state that changes the framework under an app that did not ask. Two apps
 * that both track main get two immutable checkouts, and `git clone && am fix`
 * reproduces the exact tree even for a main-follower.
 *
 * Deliberately NOT here: version ranges, a resolver, a second lockfile. Deno's
 * own `deno.lock` already pins npm/jsr deps; this pins the framework, and one
 * exact string is the whole mechanism.
 */

import { sayErr } from "./am-output.ts";
import { electronSpec, testedElectronOf } from "./am-electron.ts";
import {
  LOCAL_PIN_FILE,
  readDenoJson,
  readDenoJsonSync,
  readFrameworkPin,
} from "../server/deno-json.ts";
import {
  compareVersions as compareRawVersions,
  isComparableVersion,
} from "../server/updates-core.ts";
import { basename, join, resolve, SEPARATOR as SEP } from "@std/path";
import { ageSince } from "../server/single-instance-lock.ts";

/** The moving pin — `origin/main`, refreshed on every link. */
export const MAIN = "main";

/** "The newest release", as a WORD — `am pin latest`, the sibling of
 *  {@link MAIN}. Not a ref: it RESOLVES to one through {@link latestTag},
 *  within the app's current major unless `--major` says otherwise. The
 *  `--latest` flag is the same act under its older spelling. */
export const LATEST = "latest";

// The pin vocabulary — where versions live, what a path pin means, and whether
// a `dep/aio` link satisfies a pin — lives in `src/server/framework-pin.ts`,
// because `aio doctor` reports on the same pairing and `server` may not import
// `am`. It used to be restated there, and the two answers disagreed on every
// local-dev (`path:`) pin. Re-exported so `am`'s callers keep their imports.
export {
  isPathPin,
  linkSatisfiesPin,
  PATH_PIN_PREFIX,
  pathPinTarget,
  pinnedFrameworkPath,
  /** The version a linked app is ACTUALLY using, read back from the link
   *  target. `dep/aio` → `…/aio-versions/<ref>` gives the ref; anything else
   *  (a dev checkout) reports no ref, because that is the honest answer. */
  refOfLink,
  versionPath,
  versionsDir,
} from "../server/framework-pin.ts";
import {
  isPathPin,
  pathPinTarget,
  versionPath,
  versionsDir,
} from "../server/framework-pin.ts";
import {
  GIT_NO_PROMPT_ENV,
  looksLikeAuthChallenge,
} from "../server/git-noninteractive.ts";

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; out: string }> {
  try {
    const p = await new Deno.Command("git", {
      args: ["-C", cwd, ...args],
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      // C locale: this module PARSES git's output (`worktree list`, the lock
      // reason). A translated git wrote `locked initialisiere` where the
      // parser looked for `initializing`, and a checkout still being written
      // was torn down as junk.
      env: { ...GIT_NO_PROMPT_ENV, LC_ALL: "C", LANGUAGE: "C" },
    }).output();
    return {
      ok: p.success,
      out: new TextDecoder().decode(p.success ? p.stdout : p.stderr).trim(),
    };
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) };
  }
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
};

/** Is `root` a git clone we can cut worktrees from? A tarball copy is not. */
export async function isClone(root: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--git-dir"])).ok;
}

/** Every version tag the clone knows, newest first. */
export async function knownTags(root: string): Promise<string[]> {
  // Only tags in the RELEASED lineage — reachable from origin/main. A tag on an
  // orphaned commit names a release that never happened (an abandoned
  // feature-freeze attempt, a local experiment, a reverted branch), and offering
  // it as "latest" hands an app a tree that was never shipped. This repo had
  // exactly such a tag, and it out-ranked the real latest release by semver: the
  // first live run of `am create` pinned it. Ordering was right; the data wasn't.
  //
  // Falls back to every tag when origin/main isn't known (no remote, or a clone
  // so shallow it has no branch ref) — better to offer something than nothing.
  let r = await git(root, ["tag", "-l", "v*", "--merged", "origin/main"]);
  if (!r.ok) r = await git(root, ["tag", "-l", "v*"]);
  if (!r.ok) return [];
  const raw = r.out.split("\n").map((l) => l.trim()).filter(Boolean);
  // Semver order, newest first — not git's date or refname order (see the
  // Version ordering block below for why both are wrong for us).
  return sortVersions(raw).map((v) => v.raw);
}

/** The newest tag — what `am create` pins by default (a released version, never
 *  whatever WIP sits on the branch tip). Same rule install.sh uses. */
export async function latestTag(
  root: string,
  opts: { major?: number } = {},
): Promise<string | null> {
  return newestVersion(await knownTags(root), opts)?.raw ?? null;
}

// ── Version ordering ────────────────────────────────────────
//
// Tags must be ordered by SEMVER, never by tag date. Two reasons, both of which
// bite exactly when aio grows up:
//
//  • a maintenance release (v1.2.1 tagged after v2.0.0) is chronologically
//    newest but semantically older, so date order would hand a 2.x user a 1.x
//    checkout;
//  • this repo already proves the two orders disagree — an abandoned
//    `v1.0.0-beta` (July 9) sorts above `v1.0.0-alpha38` (July 28) by version
//    and below it by date.
//
// Git's own `--sort=-v:refname` gets prerelease ordering wrong for our scheme
// too (it is lexical within the prerelease part, so `alpha9 > alpha38`), so the
// comparison lives here where it can be tested.

export type Semver = {
  major: number;
  minor: number;
  patch: number;
  /** "alpha" | "beta" | "rc" | "" (a final release). */
  pre: string;
  /** The number after the prerelease word (alpha38 → 38). */
  preNum: number;
  raw: string;
};

/** Parse `v1.2.3`, `v1.0.0-alpha38`, `v2.0.0-rc1`, `v1.2.3+build1`. Null when
 *  the tag cannot be ORDERED at all.
 *
 *  ONE DECIDER for orderability, the same one the in-app updater uses. This
 *  used to be a second regex and it was STRICTER — measured, it dropped
 *  `v1.2.3+build1`, `v1.2.3-rc.1+abc`, `v2.0.0-RC1` and `v1.0.0-alpha77.1`,
 *  every one of which `updates-core` orders without complaint. Build metadata
 *  is the one that bites: a publisher stamping the commit into the version
 *  (the exact case `updates-core`'s own parser was fixed for) got
 *  `am pin latest` answering "already on the newest" from a tag list whose
 *  newest entry the app's own updater was offering — two answers, no error,
 *  and the ordering had already been unified while the FILTER was left behind.
 *
 *  `pre`/`preNum` stay best-effort display fields: the ORDER comes from
 *  `compareVersions` below, which delegates, so nothing depends on them. */
export function parseVersion(tag: string): Semver | null {
  const t = tag.trim();
  if (!isComparableVersion(t)) return null;
  const core = t.replace(/^v/, "").split("+", 1)[0]!;
  const dash = core.indexOf("-");
  const nums = (dash === -1 ? core : core.slice(0, dash)).split(".");
  const pre = dash === -1 ? "" : core.slice(dash + 1);
  const m = /^([A-Za-z]+)\.?(\d*)/.exec(pre);
  return {
    major: Number(nums[0] ?? 0),
    minor: Number(nums[1] ?? 0),
    patch: Number(nums[2] ?? 0),
    pre: (m?.[1] ?? "").toLowerCase(),
    preNum: m?.[2] ? Number(m[2]) : 0,
    raw: tag,
  };
}

/** Negative when `a` is older. A final release outranks any prerelease of the
 *  same version (1.0.0 > 1.0.0-rc1), and prereleases rank alpha < beta < rc.
 *
 *  ONE ORDERING. This used to be a second implementation, and it disagreed with
 *  the one the in-app updater uses on 22 of 24 tried pairs — every one of them
 *  the shape this project ships (`alpha9` vs `alpha62`), because SemVer
 *  compares such identifiers as ASCII. `am pin latest` and `updates` could
 *  therefore name different releases as "newest" from the same tag list. The
 *  parsing stays here (it decides which tags are orderable AT ALL); the order
 *  comes from `updates-core`. */
export function compareVersions(a: Semver, b: Semver): number {
  return compareRawVersions(a.raw, b.raw);
}

/** Release tags, newest FIRST, by semver. Unparseable tags are dropped rather
 *  than guessed at — a tag we can't order can't be offered as "latest". */
export function sortVersions(tags: string[]): Semver[] {
  return tags
    .map(parseVersion)
    .filter((v): v is Semver => v !== null)
    .sort((a, b) => compareVersions(b, a));
}

/** The newest release, optionally restricted to one major line.
 *
 *  `am pin latest` restricts to the app's CURRENT major: crossing a major is a
 *  breaking upgrade and must be asked for (`--major`), not delivered by a command
 *  whose name says "latest". That distinction is what makes this survive 2.0. */
export function newestVersion(
  tags: string[],
  opts: { major?: number } = {},
): Semver | null {
  const all = sortVersions(tags);
  const scoped = opts.major === undefined
    ? all
    : all.filter((v) => v.major === opts.major);
  return scoped[0] ?? null;
}

/** Refs already provisioned under the versions dir. */
export async function provisioned(): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(versionsDir())) {
      if (e.isDirectory || e.isSymlink) out.push(e.name);
    }
  } catch { /* nothing provisioned yet */ }
  return out.sort();
}

export type EnsureResult =
  | { ok: true; path: string; created: boolean; ref: string }
  | { ok: false; error: string };

/** A LOCKED store registration younger than this is an add IN FLIGHT
 *  (another `am` provisioning right now) and is left alone; older, it is a
 *  checkout killed mid-`git worktree add`. A real add of the whole framework
 *  takes seconds. ANY lock counts, whatever its reason says: git TRANSLATES
 *  the reason it writes (`initializing` → `initialisiere`), so a lock written
 *  by a localized git — an older `am`, or the user's own — cannot be told
 *  apart by its words. The store is aio's; its locks mean "being written". */
export const STALE_INIT_LOCK_MS = 10 * 60_000;

type Registration = {
  path: string;
  prunable: boolean;
  /** Age of the worktree's lock in ms, or null when it is not locked. */
  lockAgeMs: number | null;
};

/** `root`'s worktree registrations, with the age of any lock read from git's
 *  own admin dir (`<common-dir>/worktrees/<id>/locked`). */
async function registrations(root: string): Promise<Registration[]> {
  const list = await git(root, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return [];
  const common = await git(root, ["rev-parse", "--git-common-dir"]);
  const lockAge = new Map<string, number>(); // worktree path → lock age
  if (common.ok) {
    const admin = join(resolve(root, common.out), "worktrees");
    const ids = await Array.fromAsync(Deno.readDir(admin)).catch(() => []);
    for (const e of ids) {
      const gitdir = await Deno.readTextFile(join(admin, e.name, "gitdir"))
        .catch(() => null);
      const lock = await Deno.stat(join(admin, e.name, "locked"))
        .catch(() => null);
      if (gitdir === null || lock?.mtime == null) continue;
      lockAge.set(
        resolve(gitdir.trim().replace(/[\\/]\.git$/, "")),
        ageSince(lock.mtime.getTime()),
      );
    }
  }
  const out: Registration[] = [];
  for (const block of list.out.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    const locked = /^locked\b/m.test(block);
    out.push({
      path,
      prunable: /^prunable\b/m.test(block),
      lockAgeMs: locked ? (lockAge.get(resolve(path)) ?? Infinity) : null,
    });
  }
  return out;
}

/** The completion marker: written beside a store checkout ONLY after
 *  `git worktree add` returned. "Has mod.ts" is not "finished" — git writes
 *  files in sorted order, so mod.ts exists while src/ is still being written
 *  (measured: a racing `am` got `ok` with 543 of 20000 files). A FILE beside
 *  the directory, not in it: inside, it would be an untracked file in the
 *  checkout; and `provisioned()` lists directories only. */
export function completionMarker(storePath: string): string {
  return `${storePath}.provisioned`;
}

/** Tear down a torn store checkout — unregister (`-f -f` takes a locked
 *  one) and delete — judged by its RESULT: null when `path` is gone, else why
 *  it is still there. A leftover (a read-only subdir, a busy file) is a torn
 *  checkout the next `exists()` calls provisioned: ok:true for a broken
 *  framework, forever. */
async function tearDown(root: string, path: string): Promise<string | null> {
  const unregistered = await git(root, [
    "worktree",
    "remove",
    "-f",
    "-f",
    path,
  ]);
  const deleted = await Deno.remove(path, { recursive: true }).then(
    () => null,
    (e: unknown) => e instanceof Deno.errors.NotFound ? null : e,
  );
  if (!(await Deno.lstat(path).then(() => true, () => false))) return null;
  return deleted instanceof Error
    ? deleted.message
    : unregistered.ok
    ? "it is still there"
    : unregistered.out || "git worktree remove failed";
}

/** The refusal for a checkout {@linkcode tearDown} could not remove. */
const stuckError = (path: string, why: string): EnsureResult => ({
  ok: false,
  error: `${path} is an incomplete checkout and could not be removed ` +
    `(${why}) — delete it by hand and re-run.`,
});

/** The version store, in BOTH spellings: git records the REAL path at add
 *  time, so a symlinked HOME or AIO_VERSIONS_DIR registers under the resolved
 *  one, and matching only the literal prefix never pruned — the next add then
 *  failed on "missing but already registered worktree", every time. */
async function storePrefixes(): Promise<string[]> {
  const literal = resolve(versionsDir());
  const real = await Deno.realPath(literal).catch(() => literal);
  return [...new Set([literal, real])].map((d) => d + SEP);
}

/** Drop registrations in `root`'s .git that are dead AND live under the
 *  version store (`versionsDir()`) — each by its exact path, never anything
 *  else. Dead is: the directory is gone (`prunable`), or a checkout killed
 *  mid-`git worktree add` — LOCKED for longer than
 *  {@linkcode STALE_INIT_LOCK_MS} — whose half-written directory goes too.
 *
 *  Not `git worktree prune`: that expires EVERY missing entry at once (gc
 *  waits three months), and `root` may be the developer's own aio checkout —
 *  one of THEIR worktrees on an unmounted drive or a moved folder lost its
 *  registration and read "not a git repository" once it came back. A dead
 *  entry in the store is aio's own and is re-provisioned on demand; anything
 *  elsewhere is not aio's to forget. @internal */
export async function pruneStoreRegistrations(
  root: string,
): Promise<{ removed: string[]; stuck: Map<string, string> }> {
  const stores = await storePrefixes();
  const removed: string[] = [];
  /** Store paths whose teardown left them in place → why. */
  const stuck = new Map<string, string>();
  for (const r of await registrations(root)) {
    if (!stores.some((d) => resolve(r.path).startsWith(d))) continue;
    const killedMidAdd = r.lockAgeMs !== null &&
      r.lockAgeMs > STALE_INIT_LOCK_MS;
    if (!r.prunable && !killedMidAdd) continue;
    if (!r.prunable) {
      // Killed mid-add — but "killed" is not "torn": git may have finished
      // writing and died before unlocking. Only POSITIVE evidence deletes.
      const state = await checkoutState(r.path);
      if (state === "whole") {
        await git(r.path, ["worktree", "unlock", r.path]);
        await markLegacy(r.path);
        continue;
      }
      if (state === "unknown") continue; // never delete what we cannot read
    }
    // A store path, by the check above — registration and half-checkout.
    const why = await tearDown(root, r.path);
    if (why) {
      stuck.set(resolve(r.path), why);
      continue;
    }
    removed.push(r.path);
    await Deno.remove(completionMarker(r.path)).catch(() => {
      // aio-ok: a dead entry usually never got its marker
    });
  }
  return { removed, stuck };
}

/**
 * Make `ref` available on disk and return its path.
 *
 * `main` is refreshed to `origin/main` every time (it is explicitly a moving
 * target); a tag is checked out once and then reused untouched, because an
 * immutable pin is the entire value proposition.
 */
/** A LOCAL-DEV pin (`isPathPin`) is deliberately machine-specific: committing
 *  it pins teammates to a path that likely does not exist, which fails LOUDLY
 *  (ensureVersion refuses with the fix) rather than silently linking something
 *  else. `am pin latest` returns to a reproducible tag pin. */
export async function ensureVersion(
  root: string,
  ref: string,
): Promise<EnsureResult> {
  // A path pin needs no provisioning — the checkout IS the version. Verify it
  // exists and is an aio checkout; a missing path is a loud stop, never a
  // silent fallback to some other framework.
  if (isPathPin(ref)) {
    const target = pathPinTarget(ref);
    if (await exists(join(target, "mod.ts"))) {
      return { ok: true, path: target, created: false, ref };
    }
    return {
      ok: false,
      error: `local-dev pin ${ref} points at a path with no aio checkout ` +
        `(mod.ts not found). Restore the checkout, re-pin with ` +
        `"am pin <path>", or return to a release: "am pin latest".`,
    };
  }

  const path = versionPath(ref);
  let already = await exists(path);

  if (!await isClone(root)) {
    // Nothing to cut a worktree from. Say exactly what to do rather than
    // silently linking a different version than the app asked for.
    if (already) return { ok: true, path, created: false, ref };
    return {
      ok: false,
      error:
        `${root} is not a git clone, so aio ${ref} cannot be provisioned. ` +
        `Reinstall with install.sh (it clones with full history), or point ` +
        `--aio=<path> at a checkout of ${ref}.`,
    };
  }

  // Dead store entries first (a vanished dir, a checkout killed mid-add), then
  // THIS version's directory: one without mod.ts is a half-written checkout
  // (21022 of 30000 files, measured), and returning it as provisioned made the
  // app build against a torn framework — forever, since a tag is never
  // re-checked. It is removed and provisioned again below.
  // A dead entry that could not be removed is refused BY NAME here: left to
  // `settleStoreDir`, its freshly-touched directory read as an add "in flight".
  const { stuck } = await pruneStoreRegistrations(root);
  const stuckWhy = stuck.get(resolve(path));
  if (stuckWhy) return stuckError(path, stuckWhy);
  const refused = await settleStoreDir(root, path, ref);
  if (refused) return refused;
  already = await exists(path);

  // A TAG is immutable: provision once, then never touch it again. That is the
  // whole value — the bytes an app was built against cannot change under it.
  if (already && ref !== MAIN) return { ok: true, path, created: false, ref };

  // Not provisioned yet. Fetch once so a tag published after install is known.
  // `main-<sha>` is a RESOLVED moving pin (what gets committed — see below);
  // its target is the commit, so a clone reproduces the exact tree.
  const sha = /^main-([0-9a-f]{7,40})$/.exec(ref)?.[1];
  const target = sha ? sha : ref === MAIN ? `origin/${MAIN}` : ref;
  let has = await git(root, ["rev-parse", "--verify", "--quiet", target]);
  let fetchFailed = "";
  if (!has.ok) {
    const fetched = await git(root, [
      "fetch",
      "--tags",
      "--force",
      "origin",
      MAIN,
    ]);
    if (!fetched.ok) fetchFailed = fetched.out;
    has = await git(root, ["rev-parse", "--verify", "--quiet", target]);
  }
  if (!has.ok) {
    const tags = (await knownTags(root)).slice(0, 8);
    // The fetch failing is a DIFFERENT fact than the ref not existing, and
    // hiding it behind "version not found" sent a user hunting the wrong
    // bug. Notably: GitHub rate-limits anonymous HTTPS git and answers a
    // throttled fetch of a PUBLIC repo with an auth challenge
    // (intermittently — a retry may pass). Prompts are off
    // (GIT_NO_PROMPT_ENV), so that challenge lands here as a failure, and
    // the message must say what it is and what to do.
    const fetchNote = !fetchFailed ? "" : `\nRefreshing from origin also ` +
      `failed: ${fetchFailed.split("\n")[0]}\n` +
      (looksLikeAuthChallenge(fetchFailed)
        ? `GitHub is rate-limiting anonymous fetches from this network ` +
          `right now (it challenges even public repos; a retry in a minute ` +
          `often passes). aio itself never needs credentials.`
        : `Check the network and the remote, then retry.`) +
      `\nManual fetch: git -C ${root} fetch --tags --force origin ${MAIN}`;
    return {
      ok: false,
      error:
        `aio version "${ref}" not found in ${root}. Known: ${
          tags.join(", ") || "(none)"
        }${
          tags.length === 8 ? ", …" : ""
        }. Both WORDS are accepted: "${LATEST}" for the newest release, ` +
        `"${MAIN}" for the branch tip.` + fetchNote,
    };
  }

  // A moving ref resolves to the COMMIT it currently points at, and is stored
  // under that commit. Two apps that both pin "main" therefore get two immutable
  // checkouts, not one shared mutable directory — otherwise `am fix` in one app
  // silently rewrites the framework under the other, which is precisely the class
  // of surprise this whole mechanism exists to remove. Re-pinning "main" later
  // provisions the newer commit and relinks; old ones are inert until pruned.
  let storePath = path;
  let storeRef = ref;
  if (ref === MAIN) {
    const sha = await git(root, ["rev-parse", "--short=12", target]);
    if (sha.ok && sha.out) {
      storeRef = `main-${sha.out}`;
      storePath = versionPath(storeRef);
      const why = stuck.get(resolve(storePath));
      if (why) return stuckError(storePath, why);
      const torn = await settleStoreDir(root, storePath, sha.out);
      if (torn) return torn;
      if (await exists(storePath)) {
        return { ok: true, path: storePath, created: false, ref: storeRef };
      }
    }
  }

  await Deno.mkdir(versionsDir(), { recursive: true });
  // Detached worktree: no branch is claimed, so several apps can pin several
  // versions and the install clone stays free to move independently.
  const add = await git(root, [
    "worktree",
    "add",
    "--detach",
    storePath,
    target,
  ]);
  if (!add.ok) {
    return { ok: false, error: `git worktree add failed: ${add.out}` };
  }
  if (!await exists(join(storePath, "mod.ts"))) {
    return {
      ok: false,
      error:
        `provisioned ${ref} at ${storePath} but it has no mod.ts — not an aio checkout`,
    };
  }
  // Only NOW is it a version: every file is written and git has unlocked it.
  await Deno.writeTextFile(completionMarker(storePath), `${target}\n`);
  return { ok: true, path: storePath, created: true, ref: storeRef };
}

/** Is a store checkout whole? `"torn"` only on POSITIVE evidence — mod.ts
 *  absent, or git lists tracked files missing; `"unknown"` when git cannot
 *  answer (a moved/re-cloned registering repo, "dubious ownership"), which is
 *  never a reason to delete. */
async function checkoutState(
  path: string,
): Promise<"whole" | "torn" | "unknown"> {
  if (!await exists(join(path, "mod.ts"))) return "torn";
  const missing = await git(path, ["ls-files", "--deleted"]);
  if (!missing.ok) return "unknown";
  return missing.out === "" ? "whole" : "torn";
}

/** Mark a checkout finished that an older `am` (or a killed-after-checkout
 *  add) left without a marker. Best-effort: an unwritable store only means
 *  the check runs again next time. */
async function markLegacy(path: string): Promise<void> {
  const marker = completionMarker(path);
  if (await exists(marker)) return;
  await Deno.writeTextFile(marker, "legacy\n").catch(() => {
    // aio-ok: re-checked next time; nothing depends on the marker existing
  });
}

/** Decide what an EXISTING store directory is, before anyone trusts it:
 *
 *  - being written right now — a lock younger than
 *    {@linkcode STALE_INIT_LOCK_MS}, or a young directory git has not
 *    registered yet → refused (never torn down under another `am`);
 *  - finished — its {@linkcode completionMarker} is there and it is unlocked;
 *  - a LEGACY checkout (an `am` from before the marker, or one whose lock
 *    went stale) — has mod.ts, and `git ls-files --deleted` finds every
 *    tracked file PRESENT (content is not compared) → unlocked, marked now
 *    and kept: a complete old checkout is never torn down. One git cannot
 *    inspect at all is kept too, with a note;
 *  - anything else — a torn checkout → unregistered (`-f -f` takes a locked
 *    one) and deleted, so the caller provisions it afresh.
 *
 *  Null = usable or gone; an error result = refused. */
async function settleStoreDir(
  root: string,
  path: string,
  target: string,
): Promise<EnsureResult | null> {
  const st = await Deno.lstat(path).catch(() => null);
  if (!st) return null;
  // The lock is read through the checkout's OWN `.git` file, not through
  // `root`'s registrations: the store is shared by every aio clone on the
  // machine (the installed one, a dev checkout), and a version another clone
  // is writing — or wrote — is registered THERE.
  const gitFile = await Deno.readTextFile(join(path, ".git")).catch(() => null);
  const gitdirRaw = gitFile
    ? /^gitdir:\s*(.+)$/m.exec(gitFile)?.[1]
    : undefined;
  const gitdir = gitdirRaw ? resolve(path, gitdirRaw.trim()) : null;
  const lock = gitdir
    ? await Deno.stat(join(gitdir, "locked")).catch(() => null)
    : null;
  // `ageSince`: a stamp from the FUTURE (the clock stepped back) is OLD —
  // raw subtraction said "started -3600s ago" and refused forever.
  const since = (t: Date | null | undefined) =>
    t ? ageSince(t.getTime()) : Infinity;
  // Locked: git is (or was) writing it. No `.git` file yet: git has just made
  // the directory and not linked it — young means in flight too.
  const age = lock ? since(lock.mtime) : gitdir ? null : since(st.mtime);
  if (age !== null && age <= STALE_INIT_LOCK_MS) {
    return {
      ok: false,
      error: `${path} is being provisioned right now (started ` +
        `${Math.round(age / 1000)}s ago) — retry in a moment.`,
    };
  }
  const marker = completionMarker(path);
  const hasMod = await exists(join(path, "mod.ts"));
  if (!lock && hasMod && await exists(marker)) return null;
  // Everything else is judged on EVIDENCE, and only positive evidence of a
  // torn checkout deletes anything. A `git` that cannot answer — the clone
  // that registered this checkout was moved, re-cloned or reinstalled, or
  // "dubious ownership" — is NOT evidence: that is exactly how a complete
  // v1.0.9 checkout was deleted, and with the tag gone upstream (or offline)
  // it could never come back.
  const state = hasMod ? await checkoutState(path) : "torn";
  if (state === "whole") {
    if (lock) await git(path, ["worktree", "unlock", path]);
    await markLegacy(path);
    return null;
  }
  if (state === "unknown") {
    sayErr(
      `am: note: ${path} has mod.ts but git cannot inspect it (its clone ` +
        `moved or was re-installed?) — kept as a finished checkout, as ` +
        `before. \`am pin ${basename(path)}\` after removing it re-provisions.`,
    );
    await markLegacy(path);
    return null;
  }
  // Torn. Tear down only what can be provisioned again from `root` —
  // otherwise refuse, loudly, and leave the directory where it is.
  const canRebuild = (await git(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${target}^{commit}`,
  ])).ok;
  if (!canRebuild) {
    return {
      ok: false,
      error: `${path} is an incomplete checkout (tracked files are missing), ` +
        `and ${root} does not have ${target} to provision it again — it was ` +
        `left in place. Fetch the tag (git -C ${root} fetch --tags origin) ` +
        `and re-run.`,
    };
  }
  const stuck = await tearDown(root, path);
  if (stuck) return stuckError(path, stuck);
  await Deno.remove(marker).catch(() => {
    // aio-ok: a torn checkout usually has no marker
  });
  return null;
}

/** Remove a provisioned version (its worktree registration too). No
 *  repo-wide `git worktree prune` here: `root` may be the developer's own
 *  checkout, and that call forgets every worktree of theirs whose directory
 *  is momentarily missing. `-f -f` removes this one even when locked. */
export async function removeVersion(
  root: string,
  ref: string,
): Promise<boolean> {
  const path = versionPath(ref);
  if (await isClone(root)) {
    await git(root, ["worktree", "remove", "-f", "-f", path]);
  }
  await Deno.remove(completionMarker(path)).catch(() => {
    // aio-ok: a legacy or torn version has none
  });
  try {
    await Deno.remove(path, { recursive: true });
  } catch { /* already gone */ }
  return !(await exists(path));
}

// ── The app's pin ───────────────────────────────────────────

/** The app's framework pin (null when unpinned): `.aio/pin.local` first,
 *  then `aioVersion` in deno.json — `readFrameworkPin` is THE reader. */
export async function readPin(appDir: string): Promise<string | null> {
  return (await readFrameworkPin(appDir)).pin;
}

/** Where a pin is RECORDED. A path pin goes to the git-ignored
 *  `.aio/pin.local` (per-machine, never committed) and leaves `aioVersion`
 *  alone; a version ref goes to deno.json — and REMOVES a local override, so
 *  `am pin latest` is really a move to that release rather than a line the
 *  override keeps winning over. Returns what was written, for the report. */
export async function writePin(
  appDir: string,
  ref: string,
): Promise<{ file: string; removedLocal: boolean }> {
  const local = join(appDir, LOCAL_PIN_FILE);
  if (isPathPin(ref)) {
    await Deno.mkdir(join(appDir, ".aio"), { recursive: true });
    await Deno.writeTextFile(local, pathPinTarget(ref) + "\n");
    await ensureGitIgnored(appDir, ".aio/");
    return { file: LOCAL_PIN_FILE, removedLocal: false };
  }
  let removedLocal = false;
  try {
    await Deno.remove(local);
    removedLocal = true;
  } catch { /* no override to remove */ }
  await writeDenoJsonPin(appDir, ref);
  return { file: "deno.json", removedLocal };
}

/** Append `entry` to the app's `.gitignore` when it is not already covered —
 *  the scaffold writes `.aio/` (see am-cmd-create.ts), but an app created
 *  before that, or by hand, must not commit its per-machine override. */
async function ensureGitIgnored(appDir: string, entry: string): Promise<void> {
  const path = join(appDir, ".gitignore");
  let raw = "";
  try {
    raw = await Deno.readTextFile(path);
  } catch { /* none yet */ }
  const covered = raw.split("\n").map((l) => l.trim()).some((l) =>
    l === entry || l === entry.replace(/\/$/, "") || l === "/" + entry
  );
  if (covered) return;
  await Deno.writeTextFile(
    path,
    raw + (raw === "" || raw.endsWith("\n") ? "" : "\n") + entry + "\n",
  );
}

/** Write `aioVersion` into an app's deno.json, preserving formatting elsewhere.
 *  A targeted text edit rather than a JSON round-trip: the app's config is the
 *  developer's file, and reformatting it as a side effect of pinning is rude. */
async function writeDenoJsonPin(appDir: string, ref: string): Promise<void> {
  // WHICH file: the one Deno reads (`DENO_JSON_NAMES`, first match) — so a
  // `deno.jsonc` app gets its pin written INTO deno.jsonc. Hardcoding
  // `deno.json` here made `am pin <ver>` on such an app provision the
  // version, relink dep/aio, and then die on NotFound — half-pinned, with a
  // stack trace where the report should be.
  const path = readDenoJsonSync(appDir)?.path ?? join(appDir, "deno.json");
  const raw = await Deno.readTextFile(path);
  const line = `  "aioVersion": ${JSON.stringify(ref)}`;
  const existing = /^\s*"aioVersion"\s*:\s*"[^"]*"\s*,?\s*$/m;
  if (existing.test(raw)) {
    const hadComma = /^\s*"aioVersion"[^\n]*,\s*$/m.test(raw);
    await Deno.writeTextFile(
      path,
      raw.replace(existing, line + (hadComma ? "," : "")),
    );
    return;
  }
  // Insert as the first field so it reads as the app's identity, like appId.
  const open = raw.indexOf("{");
  if (open < 0) throw new Error(`${path} is not a JSON object`);
  const rest = raw.slice(open + 1);
  const needsComma = /^\s*[}\]]/.test(rest) === false;
  await Deno.writeTextFile(
    path,
    raw.slice(0, open + 1) + "\n" + line + (needsComma ? "," : "") + rest,
  );
}

/** Where `dep/aio` currently points (null when absent or not a symlink). */
export async function currentLink(appDir: string): Promise<string | null> {
  try {
    return await Deno.readLink(join(appDir, "dep", "aio"));
  } catch {
    return null;
  }
}

/** Point `dep/aio` at `target`, replacing any existing link. */
export async function linkTo(appDir: string, target: string): Promise<void> {
  const dep = join(appDir, "dep");
  await Deno.mkdir(dep, { recursive: true });
  const link = join(dep, "aio");
  try {
    const st = await Deno.lstat(link);
    // Only ever replace a SYMLINK: a real directory there is someone's vendored
    // copy, and deleting it would destroy work the app owns.
    if (!st.isSymlink) {
      throw new Error(
        `${link} exists and is not a symlink — remove it yourself if you meant to replace a vendored copy`,
      );
    }
    await Deno.remove(link);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      if (e instanceof Error && e.message.includes("not a symlink")) throw e;
    }
  }
  await Deno.symlink(target, link);
}

// ── The other half of the pin ───────────────────────────────
//
// Pinning the framework SOURCE is only half a pin. A source-layout app's own
// import map carries the bare dependencies the framework needs (`immer`,
// `esbuild`, `@std/path`, …) because `dep/aio/**` resolves through the APP's map,
// not the framework's. So an app can pin aio exactly and still feed it the wrong
// immer: the framework pins `immer@10.2.0` while a scaffolded app says `^10`, and
// the day aio needs `immer@^11` that app breaks at RUNTIME while claiming to be
// pinned. A half-pin that looks like a pin is worse than no pin.
//
// The pinned checkout is the authority: it declares the exact versions it was
// tested with in its own deno.json. `syncFrameworkDeps` copies those across.

/** Dependency keys the FRAMEWORK owns in an app's import map. Anything else in
 *  the app's map is the app author's business and is never touched. */
export const FRAMEWORK_DEPS = [
  "esbuild",
  "immer",
  "happy-dom",
  "@std/path",
  "@std/assert",
  "@std/jsonc",
] as const;

export type DepChange = { key: string; from: string | null; to: string };

/** Align the app's framework-owned dep entries with what the pinned version
 *  declares. Returns what changed, so the caller can SAY so — silently editing
 *  someone's deno.json would be its own kind of failure. */
export async function syncFrameworkDeps(
  appDir: string,
  versionPathOfPin: string,
): Promise<DepChange[]> {
  let want: Record<string, string>;
  try {
    const fw = ((await readDenoJson(versionPathOfPin))?.config ?? {}) as {
      imports?: Record<string, string>;
    };
    want = fw.imports ?? {};
  } catch {
    return []; // no readable framework config — nothing authoritative to copy
  }
  // THE reader, for the same reason as `writeDenoJsonPin`: both names, JSONC.
  // A `deno.json` with one `//` comment used to throw out of `JSON.parse`
  // here — AFTER the pin was written — and `cmdPin` reported the sync as
  // failed; a `deno.jsonc` app silently got no sync at all.
  const found = await readDenoJson(appDir);
  if (!found) return [];
  const appPath = found.path;
  const raw = await Deno.readTextFile(appPath);
  const app = found.config as { imports?: Record<string, string> };
  const have = app.imports ?? {};
  const changes: DepChange[] = [];
  let out = raw;
  for (const key of FRAMEWORK_DEPS) {
    const target = want[key];
    // Only keys the app already declares AND the framework pins: adding a dep an
    // app never used would widen its graph for no reason.
    if (!target || !(key in have) || have[key] === target) continue;
    const re = new RegExp(
      `("${key.replace("/", "\\/")}"\\s*:\\s*)"[^"]*"`,
    );
    if (!re.test(out)) continue;
    out = out.replace(re, `$1${JSON.stringify(target)}`);
    changes.push({ key, from: have[key] ?? null, to: target });
  }
  // Electron: not in the framework's own import map (aio never imports it),
  // so the version comes from the pinned aio's source — the one Electron
  // that release is tested with and that its build ships. Same rule as above:
  // only an app that already declares it.
  const tested = await testedElectronOf(versionPathOfPin);
  if (
    tested && "electron" in have && have["electron"] !== electronSpec(tested)
  ) {
    const re = /("electron"\s*:\s*)"[^"]*"/;
    if (re.test(out)) {
      out = out.replace(re, `$1${JSON.stringify(electronSpec(tested))}`);
      changes.push({
        key: "electron",
        from: have["electron"] ?? null,
        to: electronSpec(tested),
      });
    }
  }
  if (changes.length > 0) await Deno.writeTextFile(appPath, out);
  return changes;
}

/** The Deno version the pinned framework requires, when it says. */
export async function pinnedMinDeno(
  versionPathOfPin: string,
): Promise<string | null> {
  try {
    const src = await Deno.readTextFile(
      join(versionPathOfPin, "src", "server", "deno-version.ts"),
    );
    return /MIN_DENO\s*=\s*"([^"]+)"/.exec(src)?.[1] ?? null;
  } catch {
    return null;
  }
}
