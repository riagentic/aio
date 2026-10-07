/**
 * app-version.ts — THE app version: `major.minor.build`, derived from the code.
 *
 * ONE fact, ONE decider. `major.minor` is written by hand in deno.json
 * (`"version": "1.2"`); `build` is DERIVED from the app's git history
 * (`git rev-list --count HEAD`), so two builds of the same commit carry the
 * same version and every commit bumps it. Nothing else numbers a build.
 *
 *   clean tree      1.2.345
 *   dirty tree      1.2.345-dirty.9f3ac2b1     hash8 = sha256(dirty paths + contents)
 *   no git repo     1.2.0-nogit.4e1d0c77       hash8 = sha256(project tree)
 *   pinned          1.0.0                      three-part deno.json version, verbatim
 *   staged          1.2.345-beta               deno.json "1.2-beta"
 *
 * `-dirty.*` / `-nogit.*` are SemVer prereleases, so they order BELOW the clean
 * build of the same count — a dirty build is not a release, and an update
 * check never offers one over a clean one. See docs/build/versioning.md.
 *
 * A STAGE (`-alpha`, `-beta`, `-rc` on the declared version) is the same
 * mechanism pointed at the other question: how finished the app says it is.
 * It rides the SAME string, because an app that says `0.1.377-beta` in its
 * status bar and ships `0.1.377` on its download page has two versions, and
 * an update check ordering by build count alone would offer an alpha over the
 * beta that replaced it. Stages rank alpha < beta < rc < (none), and a dirty
 * staged build is `1.2.345-beta.dirty.<hash8>` — one prerelease tail, because
 * two `-` groups would not be SemVer at all.
 *
 * ONE ordering consequence, written down because it is the opposite of what
 * the line above leads you to expect: SemVer ranks a LONGER prerelease higher
 * when the leading identifiers match, so `1.2.345-beta.dirty.9f3ac2b1` ranks
 * ABOVE `1.2.345-beta` — its one exception to "a dirty build ranks below the
 * clean one". It is below every other clean build (a later stage, a later
 * count, the release), and above only the single build it literally is: that
 * commit, plus your uncommitted edits. Nothing can be spelled to avoid this —
 * any tail added to `-beta` outranks `-beta` — and nothing needs to be: what
 * keeps a dirty build out of a channel is `unpublishableReason`, which refuses
 * to publish it at all, not its position in a sort.
 *
 * The build stamps the resolved version into the artifact
 * (`.aio/build-version.json`, embedded by `deno compile`; `versionName` in an
 * APK / Xcode project); the runtime reads the stamp when compiled and DERIVES
 * the same way when running from source, so `<bin> --version`, the boot line,
 * `/__aio/health` and the update check all print one string.
 *
 * Pure over injected facts — `resolveBuildVersion` never touches git or the
 * disk; `readTreeFacts` is the one impure reader, and it is small.
 */

import { join, relative, resolve } from "@std/path";
import { GIT_NO_PROMPT_ENV } from "./git-noninteractive.ts";
import { DENO_JSON_NAMES } from "./deno-json.ts";
import { recordedOutputs } from "./build-outputs.ts";
import { teachableError } from "../diagnostics/error.ts";
import { log } from "../diagnostics/logger-api.ts";

/** The `major.minor` an app has before it writes one. */
export const DEFAULT_BASE = "0.1";

/** Where the build writes the resolved version for the runtime to read. Inside
 *  `.aio/` (gitignored by the scaffold) and EXCLUDED from the dirty set — the
 *  build's own stamp must never dirty the build. */
export const BUILD_STAMP_FILE = ".aio/build-version.json";

/** Set by the fleet build for its per-target children — the version it
 *  resolved once, as JSON. A transport, not a second decider. */
export const BUILD_VERSION_ENV = "AIO_BUILD_VERSION";

export type VersionSource = "derived" | "pinned" | "default" | "nogit";

/** How finished a build says it is. Ordered: alpha < beta < rc < (none).
 *
 *  Only these three, only lower-case, and never a number after them — the
 *  build count already numbers the build, and `alpha2` would be a second
 *  counter disagreeing with the first. */
export type ReleaseStage = "alpha" | "beta" | "rc";

export type BuildVersion = {
  /** The full string — what every artifact name, `--version` and manifest carry. */
  version: string;
  /** `major.minor`. */
  base: string;
  /** The build number: the commit count (0 without git; the patch of a pin). */
  build: number;
  /** Short commit sha, or null (no repo / no commits). */
  commit: string | null;
  dirty: boolean;
  source: VersionSource;
  /** The declared stage, when there is one. ABSENT, not `null`, when the app
   *  declares none: `BuildVersion` is an output type a caller may also build
   *  by hand (the fleet build passes one through `AIO_BUILD_VERSION`), and an
   *  optional field is the only kind that can be added to a frozen surface. */
  stage?: ReleaseStage;
};

export type DeclaredVersion =
  | { kind: "base"; base: string; stage?: ReleaseStage }
  | {
    kind: "pinned";
    version: string;
    base: string;
    build: number;
    stage?: ReleaseStage;
  }
  | { kind: "default"; base: typeof DEFAULT_BASE };

const STAGE = "(?:-(alpha|beta|rc))?";
const BASE_RE = new RegExp(`^(\\d+)\\.(\\d+)${STAGE}$`);
const PINNED_RE = new RegExp(`^(\\d+)\\.(\\d+)\\.(\\d+)${STAGE}$`);

/** Read deno.json's `version` STRICTLY: `M.m` (aio numbers the builds),
 *  `M.m.p` (pinned, verbatim), absent (→ {@link DEFAULT_BASE}). Anything else
 *  is refused by name — a version that is neither is a version nobody decided. */
export function parseDeclaredVersion(declared: unknown): DeclaredVersion {
  if (declared === undefined || declared === null) {
    return { kind: "default", base: DEFAULT_BASE };
  }
  if (typeof declared !== "string") {
    throw new Error(refusal(JSON.stringify(declared)));
  }
  const raw = declared.trim();
  if (!raw) return { kind: "default", base: DEFAULT_BASE };
  const b = BASE_RE.exec(raw);
  if (b) {
    return {
      kind: "base",
      base: `${+b[1]!}.${+b[2]!}`,
      ...stageOf(b[3]),
    };
  }
  const p = PINNED_RE.exec(raw);
  if (p) {
    return {
      kind: "pinned",
      // Normalised, not verbatim: " 01.0.0-rc " declares the same version as
      // "1.0.0-rc", and two spellings of one version is how an update check
      // starts disagreeing with a download page.
      version: `${+p[1]!}.${+p[2]!}.${+p[3]!}${p[4] ? `-${p[4]}` : ""}`,
      base: `${+p[1]!}.${+p[2]!}`,
      build: +p[3]!,
      ...stageOf(p[4]),
    };
  }
  throw new Error(refusal(JSON.stringify(raw)));
}

/** The release stage a version STRING carries, or null — the read-back twin of
 *  the stage {@linkcode resolveBuildVersion} writes.
 *
 *  It reads only the FIRST prerelease identifier, which is where the resolver
 *  puts it: `1.2.345-beta` and `1.2.345-beta.dirty.9f3ac2b1` both answer
 *  "beta", and `1.2.345-dirty.9f3ac2b1` answers null — a dirty mark is about
 *  whether a build is reproducible, never about how finished it is.
 *
 *  Who needs it: an install that is ITSELF on a staged line follows that line
 *  by default (src/server/updates-core.ts). Without this, declaring
 *  `"version": "1.2-beta"` silently switched the app's own updates off — every
 *  later beta is a prerelease, and a release channel does not offer those. */
export function versionStage(version: string): ReleaseStage | null {
  const m = /^\d+\.\d+\.\d+-(alpha|beta|rc)(?:[.+]|$)/.exec(version.trim());
  return m ? m[1] as ReleaseStage : null;
}

/** `{ stage }` or `{}` — never `{ stage: undefined }`, which `assertEquals`
 *  and `JSON.stringify` treat as two different objects from one fact. */
function stageOf(m: string | undefined): { stage?: ReleaseStage } {
  return m ? { stage: m as ReleaseStage } : {};
}

function refusal(shown: string): string {
  return `[version] ✗ deno.json "version" is ${shown} — an app's version ` +
    `is "major.minor" (write "1.2"; aio numbers builds from commits: ` +
    `1.2.<commit count>) or a pinned "major.minor.patch" (used verbatim), ` +
    `either one optionally followed by a release stage: "-alpha", "-beta" ` +
    `or "-rc" (write "1.2-beta" → 1.2.345-beta, which every update check ` +
    `ranks below 1.2.345). Nothing else is a version.`;
}

/** What the resolver needs to know about the working tree — injected, so the
 *  rule is testable without a repository. */
export type TreeFacts = {
  /** Inside a git work tree at all. */
  repo: boolean;
  /** `git rev-list --count HEAD` (0 without a repo or before the first commit). */
  count: number;
  /** Short sha of HEAD, or null. */
  commit: string | null;
  /** The 8-hex content hash of the dirty set; null when the tree is clean.
   *  Without a repo: the hash of the project tree (never null). */
  hash: string | null;
};

/** THE resolver. Pure. */
export function resolveBuildVersion(
  declared: unknown,
  tree: TreeFacts,
): BuildVersion {
  const d = parseDeclaredVersion(declared);
  const dirty = tree.repo && tree.hash !== null;
  const stage = d.kind === "default" ? undefined : d.stage;
  if (d.kind === "pinned") {
    return {
      version: d.version,
      base: d.base,
      build: d.build,
      commit: tree.commit,
      dirty,
      source: "pinned",
      ...stageOf(stage),
    };
  }
  if (!tree.repo) {
    const hash = tree.hash ?? "00000000";
    return {
      version: `${d.base}.0${pre(stage, `nogit.${hash}`)}`,
      base: d.base,
      build: 0,
      commit: null,
      dirty: false,
      source: "nogit",
      ...stageOf(stage),
    };
  }
  const core = `${d.base}.${tree.count}`;
  return {
    version: core + (dirty ? pre(stage, `dirty.${tree.hash}`) : pre(stage)),
    base: d.base,
    build: tree.count,
    commit: tree.commit,
    dirty,
    source: d.kind === "default" ? "default" : "derived",
    ...stageOf(stage),
  };
}

/** The SemVer prerelease tail: the stage, then the unreproducible-build mark,
 *  in that order and separated by dots.
 *
 *    —              · alpha        → `-alpha`
 *    dirty.9f3ac2b1 · —            → `-dirty.9f3ac2b1`
 *    dirty.9f3ac2b1 · alpha        → `-alpha.dirty.9f3ac2b1`
 *
 *  One tail, so the ordering stays the one a human expects all the way down:
 *  a dirty alpha is below a clean alpha, which is below the release, and the
 *  stages rank alpha < beta < rc among themselves. Two separate `-` groups
 *  would not be SemVer at all. */
function pre(stage: ReleaseStage | undefined, mark?: string): string {
  const ids = [stage, mark].filter(Boolean);
  return ids.length ? `-${ids.join(".")}` : "";
}

/** The one-line notes a build prints EXACTLY ONCE for a version that was not
 *  derived the normal way. Pure — the caller prints. */
export function buildVersionNotes(bv: BuildVersion): string[] {
  const notes: string[] = [];
  if (bv.source === "pinned") {
    notes.push(
      `version ${bv.version} is pinned by deno.json — the build number is ` +
        `not derived; write "${bv.base}${
          bv.stage ? `-${bv.stage}` : ""
        }" to let aio number builds from commits`,
    );
  }
  if (bv.source === "default") {
    notes.push(
      `deno.json declares no "version" — building as ${bv.base}.x ` +
        `(add "version": "${bv.base}" to say so)`,
    );
  }
  if (bv.source === "nogit") {
    notes.push(
      `no git repository: the build number cannot be derived — \`git init\`; ` +
        `builds are numbered from commits (this one is ${bv.version})`,
    );
  }
  return notes;
}

/** Is this a version a release may carry? `-dirty.*` and `-nogit.*` are not
 *  reproducible from a commit, so `ship` / `am publish` refuse them unless
 *  told otherwise. Pure. */
export function unpublishableReason(
  version: string,
  /** How THIS caller is told to publish anyway. A CLI names its flag; a
   *  programmatic caller names the option it actually accepts.
   *
   *  It used to hardcode `--allow-dirty`, which is a flag on the `ship` CLI —
   *  so a `shipApp({...})` caller (a two-app repo must call it directly: aio's
   *  fleet builder reads one `entry`) was told to type a flag its own wrapper
   *  did not expose, and the refusal read as a dead end. A message names a
   *  remedy its READER can perform, or it is not a remedy. */
  escape: string = "--allow-dirty",
): string | null {
  // `[-.]`, not `-`: with a release stage the mark is the SECOND prerelease
  // identifier (`1.2.345-alpha.dirty.9f3ac2b1`), and a `-`-only pattern would
  // have made this gate silently unable to fire for every staged app — the
  // exact shape of bug the stage was added to remove.
  const m = /[-.](dirty|nogit)\.[0-9a-f]{8}$/.exec(version);
  if (!m) return null;
  return `version ${version} is a ${
    m[1] === "dirty" ? "dirty-tree" : "no-repository"
  } build — commit first: a published build must be reproducible from a ` +
    `commit (${escape} publishes it anyway, and says so)`;
}

// ── hashing ─────────────────────────────────────────────────────────────────

/** 8 hex chars of sha256 over `path \0 size \0 bytes` for every entry, sorted
 *  by path — the same dirty content twice hashes the same; a different edit
 *  never collides in practice. A deleted file is `path \0 deleted`. */
export async function contentHash8(
  entries: readonly { path: string; bytes: Uint8Array | null }[],
): Promise<string> {
  const sorted = [...entries].sort((a, b) => a.path < b.path ? -1 : 1);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    parts.push(
      enc.encode(
        `${e.path}\0${e.bytes === null ? "deleted" : e.bytes.length}\0`,
      ),
    );
    if (e.bytes) parts.push(e.bytes);
    parts.push(enc.encode("\n"));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return await sha256Hex8(buf);
}

async function sha256Hex8(buf: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The CHEAP identity of a tree too large to read: 8 hex chars of sha256 over
 *  `path \0 size \0 mtime` (or `path \0 deleted`) for every entry, sorted — no
 *  file is opened. Used only past {@linkcode TREE_WALK_MAX_FILES} /
 *  `…_MAX_BYTES`, and when nothing prints the hash at all (a pinned version):
 *  below the caps the identity is {@linkcode contentHash8}, byte for byte what
 *  it always was. The leading tag keeps the two from ever hashing one input. */
function metaHash8(lines: readonly string[]): Promise<string> {
  return sha256Hex8(
    new TextEncoder().encode(
      "aio-tree-meta\n" + JSON.stringify([...lines].sort()),
    ),
  );
}

// ── the impure reader ───────────────────────────────────────────────────────

/** Paths never counted as dirty: the build's own outputs. */
export const TREE_EXCLUDES: readonly string[] = [
  ".aio/",
  // The bundle's own integrity ledger (written to the project root when the
  // framework is resolved remotely). Untracked, so without this it turned the
  // NEXT build `-dirty` — the build's output dirtying the build.
  ".aio-integrity.json",
  "node_modules/",
  "dep/",
  ".git/",
];

/** The caps on a tree read. A version string must never cost an unbounded
 *  read, and it has TWO costs to bound: the bytes it reads, and the paths it
 *  lists.
 *
 *  Why they exist. The non-repo walk runs when the project root is not a git
 *  work tree; the root comes from the nearest `deno.json` ancestor of the
 *  app's main module, so a STRAY one makes an unrelated, enormous directory
 *  look like the project. Measured: a leftover `deno.json` in a home directory
 *  made the whole home the "project", and the walk read and hashed all of it
 *  — ~0.5 GB of RSS per 5 s, four busy GC threads, a boot that never returned,
 *  and (with several at once) whole-machine freezes.
 *
 *  • Up to `TREE_WALK_MAX_FILES` files and `TREE_WALK_MAX_BYTES` bytes the
 *    identity is the CONTENT hash ({@linkcode contentHash8}) — every normal
 *    project, byte for byte what it always was.
 *  • Past either, nothing more is read: the identity is the cheap one
 *    ({@linkcode metaHash8} — path, size, mtime). A project with one large
 *    asset still has a version; it just did not cost a read of the asset. The
 *    size is taken from `stat` BEFORE the read, so the file that would cross
 *    the cap is never opened. A nested `node_modules/` is left out of the
 *    cheap identity and of every bound below.
 *  • Past `TREE_LIST_MAX_FILES` files, `TREE_WALK_MAX_DIRS` directories or
 *    `TREE_WALK_MAX_DEPTH` levels, or when git does not answer inside
 *    `GIT_TIMEOUT_MS` / `GIT_STDOUT_MAX_BYTES`, the identity is REFUSED by
 *    name, never guessed: a hash of part of a tree is the same class of
 *    confident wrong number this module already refuses elsewhere.
 *
 *  The listing bound is what the STRAY `deno.json` pays before it is refused,
 *  on every boot: a `stat` per path, ~10 µs each. Measured on a 206,000-file
 *  tree, refusing at 200,000 took 2.2–2.5 s and 200 MB; at 50,000 it takes
 *  0.65 s and 144 MB. It is far above the content cap, so it changes the
 *  identity of no tree that is read. */
export const TREE_WALK_MAX_FILES = 20_000;
export const TREE_WALK_MAX_BYTES = 128 * 1024 * 1024;
export const TREE_LIST_MAX_FILES = 50_000;
export const TREE_WALK_MAX_DIRS = 50_000;
export const TREE_WALK_MAX_DEPTH = 64;
export const GIT_TIMEOUT_MS = 30_000;
export const GIT_STDOUT_MAX_BYTES = 32 * 1024 * 1024;

/** Override the caps (tests; production uses the consts above). */
export type TreeLimits = {
  /** {@linkcode TREE_WALK_MAX_FILES} */
  files?: number;
  /** {@linkcode TREE_WALK_MAX_BYTES} */
  bytes?: number;
  /** {@linkcode TREE_LIST_MAX_FILES} */
  listed?: number;
  /** {@linkcode TREE_WALK_MAX_DIRS} */
  dirs?: number;
  /** {@linkcode TREE_WALK_MAX_DEPTH} */
  depth?: number;
  /** {@linkcode GIT_TIMEOUT_MS} */
  gitMs?: number;
  /** {@linkcode GIT_STDOUT_MAX_BYTES} */
  gitBytes?: number;
};

/** The disk reads a tree identity makes — injected so a test can prove WHICH
 *  files were opened, rather than infer it from a clock or from RSS. */
export type TreeIo = {
  stat: (
    path: string,
  ) => Promise<{ size: number; mtime: Date | null; isDirectory: boolean }>;
  readFile: (path: string) => Promise<Uint8Array>;
  /** Open and close, reading nothing: rejects exactly when `readFile` would
   *  have been refused the file. */
  probe: (path: string) => Promise<void>;
};

const DENO_IO: TreeIo = {
  stat: (path) => Deno.stat(path),
  readFile: (path) => Deno.readFile(path),
  probe: async (path) => (await Deno.open(path)).close(),
};

/** A refused tree read. `reason` is the ONE short line a version string may
 *  carry — no path, because `--version`, `/__aio/health`, the WS hello and
 *  `meta.json` all print it. The message is the full teachable text, root
 *  included, and belongs in the log. */
export class TreeRefusal extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "TreeRefusal";
  }
}

/** Refuse to identify a tree past its caps — BY NAME, never a partial hash. */
function refuseTree(root: string, reason: string): never {
  throw new TreeRefusal(
    teachableError(
      `[version] refusing to hash ${root}: ${reason}. A version identity ` +
        `must not cost an unbounded read.`,
      `If this directory is not the app's project, point the app at its own ` +
        `deno.json — a stray deno.json in an ancestor directory (such as ` +
        `$HOME) is not the app's project. If it is, keep the bulk out of the ` +
        `tree (.gitignore it in a repository, or move it), or pin the ` +
        `version: a three-part "version" in deno.json needs no tree identity.`,
      "docs/build/versioning.md",
    ).message,
    reason,
  );
}

/** Run git in `root`. Null when git is missing or says no; a {@link
 *  TreeRefusal} when it does not answer inside the caps — `git status
 *  --untracked-files=all` over an enormous work tree is the same unbounded
 *  read as the walk, one process removed. */
async function git(
  root: string,
  args: string[],
  limits?: TreeLimits,
): Promise<string | null> {
  const ms = limits?.gitMs ?? GIT_TIMEOUT_MS;
  const max = limits?.gitBytes ?? GIT_STDOUT_MAX_BYTES;
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("git", {
      args: ["-C", root, ...args],
      stdout: "piped",
      stderr: "null",
      stdin: "null",
      // aio-git-env-inherited: a deploy hook that exports GIT_DIR +
      // GIT_WORK_TREE for the app's checkout means THIS repo — honour it.
      // The update rebuild strips it for its build (updates-rebuild.ts).
      env: GIT_NO_PROMPT_ENV,
    }).spawn();
  } catch {
    return null; // git not installed
  }
  const reader = child.stdout.getReader();
  let over: string | null = null;
  const stop = (why: string) => {
    over ??= why;
    try {
      child.kill("SIGKILL");
    } catch {
      /* aio-ok: it already exited — there is nothing left to stop */
    }
    // The pipe too, not just the process: a grandchild that inherited it
    // would keep the read below waiting for as long as it lives.
    reader.cancel().catch(() => {
      // aio-ok: the read already ended — there is no pipe left to cancel
    });
  };
  const timer = setTimeout(
    () => stop(`\`git ${args[0]}\` did not answer within ${ms} ms`),
    ms,
  );
  const dec = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > max) {
        stop(`\`git ${args[0]}\` listed more than ${max} bytes of paths`);
        break;
      }
      text += dec.decode(value, { stream: true });
    }
    const { code } = await child.status;
    if (over) refuseTree(root, over);
    return code === 0 ? text + dec.decode() : null;
  } finally {
    clearTimeout(timer);
  }
}

function excluded(
  rel: string,
  excludes: readonly string[],
  isOutput?: (rel: string) => boolean,
): boolean {
  if (isOutput?.(rel)) return true;
  const p = rel.replaceAll("\\", "/");
  return excludes.some((x) => p === x.replace(/\/$/, "") || p.startsWith(x));
}

/** A path inside a `node_modules/` at any depth. (The project root's own is
 *  in {@link TREE_EXCLUDES} and never gets this far.) */
const NESTED_NODE_MODULES = /(^|\/)node_modules\//;

/** The identity of a set of files, built one path at a time — the ONE place
 *  both readers (the dirty set, the non-repo walk) decide what is read.
 *
 *  It lists every path from `stat` alone, and reads a file's bytes only while
 *  the set is still inside the content caps. `content: false` never reads. */
function treeIdentity(
  root: string,
  limits: TreeLimits | undefined,
  io: TreeIo,
  content: boolean,
) {
  const maxFiles = limits?.files ?? TREE_WALK_MAX_FILES;
  const maxBytes = limits?.bytes ?? TREE_WALK_MAX_BYTES;
  const maxListed = limits?.listed ?? TREE_LIST_MAX_FILES;
  // Null once the set is past a content cap: from there on nothing is read,
  // and what was read is let go.
  let entries: { path: string; bytes: Uint8Array | null }[] | null = content
    ? []
    : null;
  const meta: string[] = [];
  let bytes = 0;
  let seen = 0;
  const list = (line: string) => {
    if (meta.length >= maxListed) {
      refuseTree(root, `the project tree holds more than ${maxListed} files`);
    }
    meta.push(line);
  };
  return {
    /** How many paths are in the set. */
    seen: () => seen,
    /** Still inside the content caps — files are still being read. */
    content: () => entries !== null,
    /** Leave content mode: nothing more is read. */
    drop() {
      entries = null;
    },
    /** Add one path. `gone` is what a path that cannot be read IS: a
     *  deletion in the dirty set (git listed it), nothing at all in a walk. */
    async add(rel: string, abs: string, gone: "deleted" | "skip") {
      // A NESTED `node_modules/` is part of the content hash — it always was,
      // and dropping it would move the version of every app that has one. It
      // is NOT part of the cheap identity: past the caps it is the bulk that
      // put the tree there, so it is neither listed nor counted, and a
      // project is never refused a version for what `npm install` unpacked.
      const vendored = NESTED_NODE_MODULES.test(rel);
      if (vendored && !entries) {
        seen++; // still a path in the set: a dirty tree stays dirty
        return;
      }
      let st: Awaited<ReturnType<TreeIo["stat"]>> | null = null;
      try {
        st = await io.stat(abs);
      } catch {
        if (gone === "skip") return;
      }
      if (st?.isDirectory) return;
      seen++;
      if (!vendored) {
        list(
          st
            ? `${rel}\0${st.size}\0${st.mtime?.getTime() ?? 0}`
            : `${rel}\0deleted`,
        );
      }
      if (!entries) return;
      // STAT FIRST. The size decides BEFORE a byte is read: checking after
      // `readFile` meant the one file that crossed the cap was read whole —
      // a 1 GB file cost 1 GB of RSS to be refused.
      const overFiles = entries.length >= maxFiles;
      const overBytes = bytes + (st?.size ?? 0) > maxBytes;
      let read: Uint8Array | null = null;
      if (st) {
        try {
          // A file that cannot be read never counted toward a cap — its
          // bytes were never read. So before a cap ends content mode over
          // one, ask (without reading it) whether it would have been read
          // at all: one large unreadable file must not move a tree from its
          // content hash to the cheap one, where `touch` changes the version.
          if (overFiles || overBytes) await io.probe(abs);
          else read = await io.readFile(abs);
        } catch {
          // An unreadable file is not part of a walked tree's identity (the
          // build refuses it elsewhere); in the dirty set it reads as deleted.
          if (gone === "skip") return;
          st = null;
        }
      }
      // A deletion has no bytes, but it is an entry: it counts as a file.
      if (overFiles || (st && overBytes)) {
        entries = null;
        return;
      }
      bytes += read?.length ?? 0;
      // It grew between the stat and the read.
      if (bytes > maxBytes) entries = null;
      else entries.push({ path: rel, bytes: read });
    },
    hash: (): Promise<string> =>
      entries ? contentHash8(entries) : metaHash8(meta),
  };
}

/** Read what the resolver needs from `root`'s repository. `excludes` are
 *  root-relative dir prefixes (with trailing `/`) never counted as dirty —
 *  the build's `out` dir joins {@link TREE_EXCLUDES}. */
export async function readTreeFacts(
  root: string,
  opts: {
    excludes?: readonly string[];
    isOutput?: (rel: string) => boolean;
    limits?: TreeLimits;
    /** `false` when nothing will print the hash (a pinned version): no file is
     *  read, and without a repository no tree is walked at all. `hash` then
     *  only says whether the work tree is dirty. Default `true`. */
    content?: boolean;
    io?: TreeIo;
  } = {},
): Promise<TreeFacts> {
  const excludes = [...TREE_EXCLUDES, ...(opts.excludes ?? [])];
  // Where builds and publishes of this project put their output — written
  // down by the command that did it (`.aio/outputs.json`), never inferred
  // from what a directory looks like.
  const recorded = await recordedOutputs(root);
  const content = opts.content ?? true;
  const io = opts.io ?? DENO_IO;
  const top = (await git(root, ["rev-parse", "--show-toplevel"], opts.limits))
    ?.trim();
  if (!top) {
    return {
      repo: false,
      count: 0,
      commit: null,
      hash: content
        ? await projectTreeHash(
          root,
          // No repository says which files are the project's: every recorded
          // output dir is left out whole.
          [...excludes, ...recorded],
          opts.isOutput,
          opts.limits,
          io,
        )
        : null,
    };
  }
  const countRaw =
    (await git(root, ["rev-list", "--count", "HEAD"], opts.limits))?.trim();
  const count = countRaw && /^\d+$/.test(countRaw) ? +countRaw : 0;
  const commit =
    (await git(root, ["rev-parse", "--short=8", "HEAD"], opts.limits))
      ?.trim() ?? null;
  // Porcelain v1, NUL-separated, every untracked file listed on its own —
  // paths are relative to the repo TOP, restricted to this app's subtree.
  const status = await git(root, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
  ], opts.limits) ?? "";
  const records = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  const untracked = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const code = rec.slice(0, 2);
    const path = rec.slice(3);
    // An UNTRACKED `deno.lock` is the toolchain's, written by the first
    // `deno task` in a fresh checkout — the build itself would dirty the
    // build. Once tracked, a CHANGED lock is a real change (it decides which
    // dependency versions are built) and counts like any other edit.
    if (code === "??" && /(^|\/)deno\.lock$/.test(path)) continue;
    if (code === "??") untracked.add(path);
    // A rename lists the ORIGINAL path as the next record — it is part of the
    // change too (its deletion), so keep both.
    if (code[0] === "R" || code[0] === "C") {
      const orig = records[++i];
      if (orig) paths.push(orig);
    }
    paths.push(path);
  }
  const rootRel = relative(top, resolve(root)).replaceAll("\\", "/");
  // A repo whose work tree is enormous (`--untracked-files=all` lists every
  // one) is the same unbounded read as a non-repo walk — capped the same way.
  const id = treeIdentity(root, opts.limits, io, content);
  for (const p of new Set(paths)) {
    // aio-ok: path-split — git output and `rootRel` are both `/`-separated
    const rel = rootRel && p.startsWith(rootRel + "/")
      ? p.slice(rootRel.length + 1)
      : p;
    if (excluded(rel, excludes, opts.isOutput)) continue;
    // A directory a build or a publish of this project wrote to — while git
    // does not track the path. A tracked file is source wherever it lies.
    if (untracked.has(p) && excluded(rel, recorded)) continue;
    await id.add(rel, join(top, p), "deleted");
  }
  return {
    repo: true,
    count,
    commit,
    hash: id.seen() === 0 ? null : await id.hash(),
  };
}

/** Identity of every file under `root` (minus excludes) — the identity of a
 *  project that has no repository to be identified by. Bounded: see
 *  {@linkcode TREE_WALK_MAX_FILES}. */
async function projectTreeHash(
  root: string,
  excludes: readonly string[],
  isOutput: ((rel: string) => boolean) | undefined,
  limits: TreeLimits | undefined,
  io: TreeIo,
): Promise<string> {
  const maxDirs = limits?.dirs ?? TREE_WALK_MAX_DIRS;
  const maxDepth = limits?.depth ?? TREE_WALK_MAX_DEPTH;
  const id = treeIdentity(root, limits, io, true);
  let dirs = 0;
  let vendoredDirs = 0;
  const walk = async (
    dir: string,
    depth: number,
    vendored: boolean,
  ): Promise<void> => {
    if (vendored) {
      // Inside a nested node_modules the walk only goes on while its files
      // are still being read, and a bound met THERE ends content mode, not
      // the walk — counted apart, so what is vendored can never use up the
      // project's own allowance.
      if (!id.content()) return;
      if (++vendoredDirs > maxDirs || depth > maxDepth) return id.drop();
    } else {
      if (++dirs > maxDirs) {
        refuseTree(root, `the project tree holds more than ${maxDirs} folders`);
      }
      if (depth > maxDepth) {
        refuseTree(root, `the project tree nests more than ${maxDepth} deep`);
      }
    }
    // The guard wraps the ITERATION, not the call: `Deno.readDir` is a lazy
    // async iterator, so it does not throw at assignment — a directory that
    // vanished or cannot be read surfaced from the first `for await` and
    // aborted the whole walk with a raw error instead of being skipped.
    try {
      for await (const e of Deno.readDir(dir)) {
        if (vendored && !id.content()) return;
        const abs = join(dir, e.name);
        const rel = relative(root, abs).replaceAll("\\", "/");
        if (excluded(rel, excludes, isOutput)) continue;
        if (e.isDirectory) {
          await walk(
            abs,
            depth + 1,
            vendored || NESTED_NODE_MODULES.test(rel + "/"),
          );
        } else if (e.isFile) await id.add(rel, abs, "skip");
      }
    } catch (e) {
      if (e instanceof TreeRefusal) throw e;
      return; // a directory that vanished or cannot be read is not tree identity
    }
  };
  await walk(root, 0, false);
  return id.hash();
}

/** `deno.json build.out`, as the root-relative exclude the tree reader wants. */
export function outDirExclude(root: string, out: string | undefined): string {
  const rel = relative(root, resolve(root, out ?? "dist")).replaceAll(
    "\\",
    "/",
  );
  return (rel && !rel.startsWith("..") ? rel : "dist") + "/";
}

/** The root-relative dirs a build of `root` writes into, as tree excludes:
 *  `dist/` ALWAYS — the build stages there whatever `out` is — and the `out`
 *  dir beside it.
 *
 *  It used to be `dist/` OR the out dir. With `--out=release` the staging in
 *  `dist/` was therefore part of the tree: the first build created it, the
 *  second one hashed it, and the version of an untouched project moved from
 *  build to build — in a project without a repository always, in a repository
 *  wherever `dist/` was not ignored. */
export function outputExcludes(
  root: string,
  out: string | undefined,
): string[] {
  return [...new Set(["dist/", outDirExclude(root, out)])];
}

/** Resolve the version for a BUILD of `root`: the fleet's answer when it set
 *  one (one resolution per fleet run), else read the tree now. */
export async function buildVersionFor(
  root: string,
  declared: unknown,
  opts: {
    out?: string;
    env?: string | undefined;
    /** A root-level file that is this app's own build output (never dirty). */
    isOutput?: (rel: string) => boolean;
    limits?: TreeLimits;
  } = {},
): Promise<{ bv: BuildVersion; fromFleet: boolean }> {
  const env = opts.env ?? Deno.env.get(BUILD_VERSION_ENV);
  if (env) {
    const bv = JSON.parse(env) as BuildVersion;
    if (typeof bv?.version !== "string") {
      throw new Error(
        `[version] ✗ ${BUILD_VERSION_ENV} is set but is not a build ` +
          `version: ${env}`,
      );
    }
    return { bv, fromFleet: true };
  }
  // The declaration FIRST: a pinned version prints no hash, so its build must
  // not pay for one — it read the whole tree anyway, and an app pinned at
  // `0.1.0` with one large asset was refused a version it had written down.
  // What a pinned build still records is its commit and whether it is dirty,
  // and neither needs a file opened.
  const read = {
    excludes: outputExcludes(root, opts.out),
    isOutput: opts.isOutput,
    limits: opts.limits,
  };
  let tree: TreeFacts;
  if (parseDeclaredVersion(declared).kind !== "pinned") {
    tree = await readTreeFacts(root, read);
  } else {
    try {
      tree = await readTreeFacts(root, { ...read, content: false });
    } catch (e) {
      if (!(e instanceof TreeRefusal)) throw e;
      log.warn(
        `[version] ${e.reason} — building the pinned version without its ` +
          `commit and dirty facts`,
      );
      tree = NO_TREE;
    }
  }
  return { bv: resolveBuildVersion(declared, tree), fromFleet: false };
}

/** The facts of a tree nobody read. */
const NO_TREE: TreeFacts = { repo: false, count: 0, commit: null, hash: null };

/** What a SOURCE RUN reads from the tree to name its version — and for a
 *  pinned declaration that is NOTHING: the version is written down, so no git
 *  child is spawned and no file is touched. (A refused declaration needs no
 *  tree either: {@linkcode resolveRuntimeVersion} reports it in the refusal's
 *  own words.) */
export function runtimeTreeFacts(
  root: string,
  config: { version?: unknown; build?: unknown },
  read: typeof readTreeFacts = readTreeFacts,
): Promise<TreeFacts> {
  let derived = false;
  try {
    derived = parseDeclaredVersion(config.version).kind !== "pinned";
  } catch {
    /* aio-ok: a malformed version is refused by resolveRuntimeVersion */
  }
  if (!derived) return Promise.resolve(NO_TREE);
  return read(root, {
    excludes: outputExcludes(
      root,
      (config.build as { out?: string } | undefined)?.out,
    ),
  });
}

/** The version of a source run whose tree read was refused: `unknown (…)`
 *  with ONE short line and no path. The refusal's full text — three lines,
 *  with the absolute project root — used to ride this string into `--version`,
 *  `/__aio/health`, the WS hello and `meta.json`; it belongs in the log. */
export function unresolvedTreeVersion(e: unknown): string {
  return `${UNRESOLVED}${
    e instanceof TreeRefusal ? e.reason : "the project tree could not be read"
  } — see the log)`;
}

// ── the stamp ───────────────────────────────────────────────────────────────

export type BuildStamp = BuildVersion & {
  aio: string;
  builtAt: string;
  /** The display name this build resolved (a target's `title`, else
   *  deno.json's) — the name of the Windows one-click install's Start-menu
   *  shortcut, which the app adds where its `.exe` did not
   *  (server/sfx-shortcut.ts). Absent: none was set, or an older build. */
  title?: string;
  /** `false`: deno.json `build.windows.shortcut` said no shortcut. */
  windowsShortcut?: boolean;
};

/** Write the stamp the compiled artifact carries. Returns the path. */
export async function writeBuildStamp(
  root: string,
  bv: BuildVersion,
  aio: string,
  shortcut: Pick<BuildStamp, "title" | "windowsShortcut"> = {},
): Promise<string> {
  const path = join(root, BUILD_STAMP_FILE);
  await Deno.mkdir(join(root, ".aio"), { recursive: true });
  const stamp: BuildStamp = {
    ...bv,
    aio,
    builtAt: new Date().toISOString(),
    ...(shortcut.title ? { title: shortcut.title } : {}),
    ...(shortcut.windowsShortcut === false ? { windowsShortcut: false } : {}),
  };
  await Deno.writeTextFile(path, JSON.stringify(stamp, null, 2) + "\n");
  return path;
}

/** The stamp next to the app's deno.json — `dir` is where deno.json was found
 *  (a `file:` URL into the compile VFS, or a directory on disk). Null when
 *  there is none. */
export function readBuildStamp(dirUrl: URL): BuildStamp | null {
  try {
    const text = Deno.readTextFileSync(new URL(BUILD_STAMP_FILE, dirUrl));
    const s = JSON.parse(text) as BuildStamp;
    return typeof s?.version === "string" ? s : null;
  } catch {
    return null;
  }
}

// ── the runtime twin ────────────────────────────────────────────────────────

/** The version a RUNNING app reports. One rule for every reader (there is no
 *  config override — `aio.run({ appVersion })` is retired; deno.json is THE
 *  place):
 *
 *  1. compiled → the stamp the build embedded (the derived version).
 *  2. from source → derive exactly as the build would (`-dirty` when dirty).
 *  3. compiled without a stamp (hand-compiled, or a pre-versioning build) →
 *     a pinned deno.json version verbatim, else "unknown (…)" — a string the
 *     update check refuses BY NAME rather than compares as 0.0.0.
 *
 *  Pure over its inputs. */
/** Every "could not resolve" answer this module produces starts here. A
 *  version and an explanation of why there isn't one are different facts, and
 *  a `string` that is sometimes one and sometimes the other cannot be rendered
 *  safely — `examples/updates` printed the whole paragraph where its UI says
 *  "Running <version>", and it crossed the wire as `updates.current`. */
const UNRESOLVED = "unknown (";

/** Split a runtime version into "the version, or null" and "why not".
 *
 *  `resolveRuntimeVersion` returns the explanation IN the string on purpose:
 *  the boot report wants exactly that sentence on its `version` line. Anything
 *  that renders the value as a version — or ships it to a client — wants the
 *  two apart. */
export function splitRuntimeVersion(
  v: string,
): { version: string | null; unresolved: string | null } {
  return v.startsWith(UNRESOLVED)
    ? { version: null, unresolved: v.slice(UNRESOLVED.length, -1) }
    : { version: v, unresolved: null };
}

export function resolveRuntimeVersion(opts: {
  declared: unknown;
  compiled: boolean;
  stamp: BuildStamp | null;
  tree: TreeFacts | null;
}): string {
  if (opts.compiled) {
    if (opts.stamp) return opts.stamp.version;
    let d: DeclaredVersion | null = null;
    try {
      d = parseDeclaredVersion(opts.declared);
    } catch {
      /* aio-ok: a malformed version is refused below with the same words */
    }
    if (d?.kind === "pinned") {
      return d.version;
    }
    // NAME THE MISSING INGREDIENT, not just the tool that supplies it.
    //
    // "rebuild it with aio's builder" is one remedy, and it is not available
    // to every app: a repo with two apps compiles its second one with a plain
    // `deno compile` (aio's fleet reads one `entry`). That binary knew neither
    // its version, its title nor its target, and the two flags that fix it are
    // undiscoverable from the failure — a field report found them by reading
    // aio's own build source.
    return "unknown (compiled binary carries no build stamp — rebuild it " +
      "with aio's builder, `deno task build`; a plain `deno compile` needs " +
      `\`--include ${DENO_JSON_NAMES[0]} --include ${BUILD_STAMP_FILE}\`, ` +
      "and `AIO_BUILD_VERSION` hands it a version from a parent build)";
  }
  if (opts.tree) {
    // A refused declaration (the BUILD refuses it outright) must not stop a
    // source run from booting: report it as unknown, in the refusal's own
    // words — a string the update check refuses by name, never compares.
    try {
      return resolveBuildVersion(opts.declared, opts.tree).version;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return `unknown (${why.replace(/^\[version\] . /, "")})`;
    }
  }
  return 'unknown (no "version" could be derived — is this a project?)';
}

// ── artifact naming ─────────────────────────────────────────────────────────

/** The version token as it appears in a FILE NAME: the full string, stage and
 *  dirty / nogit suffix included, so a dirty artifact is visibly dirty and a
 *  beta is visibly a beta.
 *
 *  The stage arm is not decoration. `notes-1.2.345-beta.exe` with a token that
 *  stopped at `1.2.345` still MATCHES (the lookahead is happy with the `-`),
 *  and the splitter would have handed the installer the version `1.2.345` and
 *  the app name `notes-beta` — an app installed under half its name, silently,
 *  for every staged build. A token regex that does not know every shape the
 *  resolver can emit is a parser for a different program. */
export const VERSION_TOKEN_RE = (() => {
  const mark = `(?:dirty|nogit)\\.[0-9a-f]{8}`;
  // After a stage the mark is the second prerelease identifier (`.`); with no
  // stage it opens the prerelease itself (`-`). Exactly those two, so the
  // token never matches a string the resolver cannot produce.
  return new RegExp(
    `\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta|rc)(?:\\.${mark})?|-${mark})?`,
  );
})();

/** The prefix every artifact name starts with: the app's binary name, or the
 *  standalone `aio-client` connect-page AppImage. Null when `name` is neither. */
function artifactPrefix(name: string, binaryName: string): string | null {
  if (name === binaryName || name.startsWith(binaryName)) return binaryName;
  if (name.startsWith("aio-client")) return "aio-client";
  return null;
}

/** `<prefix>-<version><rest>`: the versioned name of an artifact the
 *  single-target builder wrote as `<prefix><rest>`. Pure. Idempotent — a name
 *  already carrying a version keeps it. */
export function versionedArtifactName(
  file: string,
  binaryName: string,
  version: string,
): string {
  const prefix = artifactPrefix(file, binaryName);
  if (prefix === null) return file;
  if (artifactVersion(file, binaryName)?.version) return file;
  return `${prefix}-${version}${file.slice(prefix.length)}`;
}

/** Split an artifact name into the unversioned name the builders use and the
 *  version it carries (null for a legacy, unversioned name). Null when the
 *  file is not this app's artifact at all. Pure. */
export function artifactVersion(
  name: string,
  binaryName: string,
): { unversioned: string; version: string | null } | null {
  const prefix = artifactPrefix(name, binaryName);
  if (prefix === null) return null;
  const rest = name.slice(prefix.length);
  const m = new RegExp(`^-(${VERSION_TOKEN_RE.source})(?=$|[-.])`).exec(rest);
  if (!m) return { unversioned: name, version: null };
  return { unversioned: prefix + rest.slice(m[0].length), version: m[1]! };
}

/** `name` without its version token — the name the builder wrote. For the
 *  readers that know no binary name (an APK on disk, a lab's dist/ listing):
 *  `myapp-1.2.345-client.apk` → `myapp-client.apk`; a legacy name is itself. */
export function stripVersionToken(name: string): string {
  return name.replace(
    new RegExp(`-${VERSION_TOKEN_RE.source}(?=$|[-.])`),
    "",
  );
}

/** The base every artifact of this build is named from. */
export function artifactBaseName(binaryName: string, version: string): string {
  return `${binaryName}-${version}`;
}

/** Arch suffixes the packagers append (`<name>-x86_64.AppImage`). Stripping
 *  "everything after the first hyphen" instead would install `chat-app` as
 *  `chat`; app names contain hyphens far more often than arch strings. */
const ARCH_SUFFIXES: readonly string[] = [
  "x86_64",
  "aarch64",
  "arm64",
  "armhf",
  "i686",
  "amd64",
  "x64",
];

/** Platform tokens the cross builds put in FRONT of the arch. */
const OS_SUFFIXES: readonly string[] = [
  "windows",
  "macos",
  "linux",
  "win",
  "mac",
];

/** THE name a built artifact is INSTALLED as, and the version it carries.
 *
 *  `dist/demo-1.2.345-x86_64.AppImage` → `{ base: "demo", ext: ".AppImage",
 *  version: "1.2.345" }`. The installed FILE keeps the app's name: a
 *  deno-compiled binary derives its identity — and therefore its data
 *  directory — from its own file name, so `demo-1.2.345` would make the app
 *  call itself `demo-1-2-345`, write to `~/.demo-1-2-345/`, and start from
 *  empty state again on the next version. The version goes in the DIRECTORY
 *  (`versions/<version>/<base><ext>`, {@link resolveInstallLayout} in
 *  updates-apply.ts).
 *
 *  One decider: `run.sh` and `run.ps1` ask the build for this
 *  (`--print-install-name=<file>`) rather than parsing names in shell — two
 *  copies of a naming rule is how an installer and `am remove` come to
 *  disagree about where an app lives. Pure. */
export function installArtifactName(
  file: string,
): { base: string; ext: string; version: string | null } {
  // aio-ok: path-split — `\\` normalised to `/` first
  const name = file.replaceAll("\\", "/").split("/").pop() ?? file;
  const m = new RegExp(`-(${VERSION_TOKEN_RE.source})(?=$|[-.])`).exec(name);
  const unversioned = stripVersionToken(name);
  const dot = unversioned.lastIndexOf(".");
  let base = dot > 0 ? unversioned.slice(0, dot) : unversioned;
  const ext = dot > 0 ? unversioned.slice(dot) : "";
  let stripped = false;
  for (const arch of ARCH_SUFFIXES) {
    if (base.endsWith(`-${arch}`)) {
      base = base.slice(0, -arch.length - 1);
      stripped = true;
      break;
    }
  }
  // A cross build names the PLATFORM too (`notes-1.2.345-windows-x64.exe`).
  // Only ever behind an arch that was just stripped: on its own, `-linux` is
  // as likely to be the app's own name as a platform token, and an app
  // installed under half its name is the bug this rule exists to prevent.
  if (stripped) {
    for (const os of OS_SUFFIXES) {
      if (base.endsWith(`-${os}`)) {
        base = base.slice(0, -os.length - 1);
        break;
      }
    }
  }
  return { base: base || name, ext, version: m?.[1] ?? null };
}
