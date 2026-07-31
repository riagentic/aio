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

import { dirname, join } from "@std/path";
import { homedir } from "../server/paths.ts";

/** The moving pin — `origin/main`, refreshed on every link. */
export const MAIN = "main";

/** Where provisioned versions live: `~/.local/lib/aio-versions/<ref>/`.
 *
 *  A sibling of the install clone rather than a directory inside it: a worktree
 *  under the clone would show up as untracked and collide with install.sh's
 *  `git checkout --force`. Fixed location so it is the same on every machine,
 *  and one `rm -rf` away from a clean slate. */
export function versionsDir(): string {
  return Deno.env.get("AIO_VERSIONS_DIR") ??
    join(homedir(), ".local", "lib", "aio-versions");
}

/** Path a given ref is (or would be) provisioned at. */
export function versionPath(ref: string): string {
  return join(versionsDir(), ref);
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; out: string }> {
  try {
    const p = await new Deno.Command("git", {
      args: ["-C", cwd, ...args],
      stdout: "piped",
      stderr: "piped",
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
//    `v1.0.0-beta1` (July 9) sorts above `v1.0.0-alpha38` (July 28) by version
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

const PRE_RANK: Record<string, number> = { alpha: 1, beta: 2, rc: 3 };

/** Parse `v1.2.3`, `v1.0.0-alpha38`, `v2.0.0-rc1`. Null when unparseable. */
export function parseVersion(tag: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.?(\d*))?$/.exec(tag.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ?? "",
    preNum: m[5] ? Number(m[5]) : 0,
    raw: tag,
  };
}

/** Negative when `a` is older. A final release outranks any prerelease of the
 *  same version (1.0.0 > 1.0.0-rc1), and prereleases rank alpha < beta < rc. */
export function compareVersions(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const ra = a.pre === "" ? 99 : PRE_RANK[a.pre] ?? 50;
  const rb = b.pre === "" ? 99 : PRE_RANK[b.pre] ?? 50;
  if (ra !== rb) return ra - rb;
  return a.preNum - b.preNum;
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
 *  `am pin --latest` restricts to the app's CURRENT major: crossing a major is a
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

/**
 * Make `ref` available on disk and return its path.
 *
 * `main` is refreshed to `origin/main` every time (it is explicitly a moving
 * target); a tag is checked out once and then reused untouched, because an
 * immutable pin is the entire value proposition.
 */
/** A LOCAL-DEV pin: `aioVersion: "path:/abs/checkout"` — the app follows a
 *  framework checkout on THIS machine (framework co-development). Deliberately
 *  machine-specific: committing it pins teammates to a path that likely does
 *  not exist, which fails LOUDLY (ensureVersion refuses with the fix) rather
 *  than silently linking something else. `am pin --latest` returns to a
 *  reproducible tag pin. */
export const PATH_PIN_PREFIX = "path:";
export function isPathPin(ref: string): boolean {
  return ref.startsWith(PATH_PIN_PREFIX);
}
export function pathPinTarget(ref: string): string {
  return ref.slice(PATH_PIN_PREFIX.length);
}

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
        `"am pin <path>", or return to a release: "am pin --latest".`,
    };
  }

  const path = versionPath(ref);
  const already = await exists(path);

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

  // A TAG is immutable: provision once, then never touch it again. That is the
  // whole value — the bytes an app was built against cannot change under it.
  if (already && ref !== MAIN) return { ok: true, path, created: false, ref };

  // Not provisioned yet. Fetch once so a tag published after install is known.
  // `main-<sha>` is a RESOLVED moving pin (what gets committed — see below);
  // its target is the commit, so a clone reproduces the exact tree.
  const sha = /^main-([0-9a-f]{7,40})$/.exec(ref)?.[1];
  const target = sha ? sha : ref === MAIN ? `origin/${MAIN}` : ref;
  let has = await git(root, ["rev-parse", "--verify", "--quiet", target]);
  if (!has.ok) {
    await git(root, ["fetch", "--tags", "--force", "origin", MAIN]);
    has = await git(root, ["rev-parse", "--verify", "--quiet", target]);
  }
  if (!has.ok) {
    const tags = (await knownTags(root)).slice(0, 8);
    return {
      ok: false,
      error: `aio version "${ref}" not found in ${root}. Known: ${
        tags.join(", ") || "(none)"
      }${tags.length === 8 ? ", …" : ""}. Use "main" for the branch tip.`,
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
    // A stale registration from a deleted directory is the common cause.
    await git(root, ["worktree", "prune"]);
    const retry = await git(root, [
      "worktree",
      "add",
      "--detach",
      storePath,
      target,
    ]);
    if (!retry.ok) {
      return { ok: false, error: `git worktree add failed: ${retry.out}` };
    }
  }
  if (!await exists(join(storePath, "mod.ts"))) {
    return {
      ok: false,
      error:
        `provisioned ${ref} at ${storePath} but it has no mod.ts — not an aio checkout`,
    };
  }
  return { ok: true, path: storePath, created: true, ref: storeRef };
}

/** Remove a provisioned version (its worktree registration too). */
export async function removeVersion(
  root: string,
  ref: string,
): Promise<boolean> {
  const path = versionPath(ref);
  if (await isClone(root)) {
    await git(root, ["worktree", "remove", "--force", path]);
    await git(root, ["worktree", "prune"]);
  }
  try {
    await Deno.remove(path, { recursive: true });
  } catch { /* already gone */ }
  return !(await exists(path));
}

// ── The app's pin ───────────────────────────────────────────

/** Read `aioVersion` from an app's deno.json (null when unpinned). */
export async function readPin(appDir: string): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(join(appDir, "deno.json"));
    const cfg = JSON.parse(raw) as { aioVersion?: unknown };
    return typeof cfg.aioVersion === "string" && cfg.aioVersion
      ? cfg.aioVersion
      : null;
  } catch {
    return null;
  }
}

/** Write `aioVersion` into an app's deno.json, preserving formatting elsewhere.
 *  A targeted text edit rather than a JSON round-trip: the app's config is the
 *  developer's file, and reformatting it as a side effect of pinning is rude. */
export async function writePin(appDir: string, ref: string): Promise<void> {
  const path = join(appDir, "deno.json");
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

/** The version a linked app is ACTUALLY using, read back from the link target.
 *  `dep/aio` → `…/aio-versions/<ref>` gives the ref; anything else (a dev
 *  checkout) reports the path, because that is the honest answer. */
export function refOfLink(target: string): string | null {
  const base = dirname(target);
  return base === versionsDir() ? target.slice(base.length + 1) : null;
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
    const fw = JSON.parse(
      await Deno.readTextFile(join(versionPathOfPin, "deno.json")),
    ) as { imports?: Record<string, string> };
    want = fw.imports ?? {};
  } catch {
    return []; // no readable framework config — nothing authoritative to copy
  }
  const appPath = join(appDir, "deno.json");
  let raw: string;
  try {
    raw = await Deno.readTextFile(appPath);
  } catch {
    return [];
  }
  const app = JSON.parse(raw) as { imports?: Record<string, string> };
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
