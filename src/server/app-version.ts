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
 *
 * `-dirty.*` / `-nogit.*` are SemVer prereleases, so they order BELOW the clean
 * build of the same count — a dirty build is not a release, and an update
 * check never offers one over a clean one. See docs/build/versioning.md.
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
};

export type DeclaredVersion =
  | { kind: "base"; base: string }
  | { kind: "pinned"; version: string; base: string; build: number }
  | { kind: "default"; base: typeof DEFAULT_BASE };

const BASE_RE = /^(\d+)\.(\d+)$/;
const PINNED_RE = /^(\d+)\.(\d+)\.(\d+)$/;

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
  if (b) return { kind: "base", base: `${+b[1]!}.${+b[2]!}` };
  const p = PINNED_RE.exec(raw);
  if (p) {
    return {
      kind: "pinned",
      version: raw,
      base: `${+p[1]!}.${+p[2]!}`,
      build: +p[3]!,
    };
  }
  throw new Error(refusal(JSON.stringify(raw)));
}

function refusal(shown: string): string {
  return `[version] ✗ deno.json "version" is ${shown} — an app's version ` +
    `is "major.minor" (write "1.2"; aio numbers builds from commits: ` +
    `1.2.<commit count>) or a pinned "major.minor.patch" (used verbatim). ` +
    `Nothing else is a version.`;
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
  if (d.kind === "pinned") {
    return {
      version: d.version,
      base: d.base,
      build: d.build,
      commit: tree.commit,
      dirty,
      source: "pinned",
    };
  }
  if (!tree.repo) {
    const hash = tree.hash ?? "00000000";
    return {
      version: `${d.base}.0-nogit.${hash}`,
      base: d.base,
      build: 0,
      commit: null,
      dirty: false,
      source: "nogit",
    };
  }
  const core = `${d.base}.${tree.count}`;
  return {
    version: dirty ? `${core}-dirty.${tree.hash}` : core,
    base: d.base,
    build: tree.count,
    commit: tree.commit,
    dirty,
    source: d.kind === "default" ? "default" : "derived",
  };
}

/** The one-line notes a build prints EXACTLY ONCE for a version that was not
 *  derived the normal way. Pure — the caller prints. */
export function buildVersionNotes(bv: BuildVersion): string[] {
  const notes: string[] = [];
  if (bv.source === "pinned") {
    notes.push(
      `version ${bv.version} is pinned by deno.json — the build number is ` +
        `not derived; write "${bv.base}" to let aio number builds from commits`,
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
  const m = /-(dirty|nogit)\.[0-9a-f]{8}$/.exec(version);
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
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── the impure reader ───────────────────────────────────────────────────────

/** Paths never counted as dirty: the build's own outputs. */
export const TREE_EXCLUDES: readonly string[] = [
  ".aio/",
  "node_modules/",
  "dep/",
  ".git/",
];

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const r = await new Deno.Command("git", {
      args: ["-C", root, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (r.code !== 0) return null;
    return new TextDecoder().decode(r.stdout);
  } catch {
    return null; // git not installed
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

/** Read what the resolver needs from `root`'s repository. `excludes` are
 *  root-relative dir prefixes (with trailing `/`) never counted as dirty —
 *  the build's `out` dir joins {@link TREE_EXCLUDES}. */
export async function readTreeFacts(
  root: string,
  opts: { excludes?: readonly string[]; isOutput?: (rel: string) => boolean } =
    {},
): Promise<TreeFacts> {
  const excludes = [...TREE_EXCLUDES, ...(opts.excludes ?? [])];
  const top = (await git(root, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) {
    return {
      repo: false,
      count: 0,
      commit: null,
      hash: await projectTreeHash(root, excludes, opts.isOutput),
    };
  }
  const countRaw = (await git(root, ["rev-list", "--count", "HEAD"]))?.trim();
  const count = countRaw && /^\d+$/.test(countRaw) ? +countRaw : 0;
  const commit = (await git(root, ["rev-parse", "--short=8", "HEAD"]))
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
  ]) ?? "";
  const records = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const code = rec.slice(0, 2);
    const path = rec.slice(3);
    // An UNTRACKED `deno.lock` is the toolchain's, written by the first
    // `deno task` in a fresh checkout — the build itself would dirty the
    // build. Once tracked, a CHANGED lock is a real change (it decides which
    // dependency versions are built) and counts like any other edit.
    if (code === "??" && /(^|\/)deno\.lock$/.test(path)) continue;
    // A rename lists the ORIGINAL path as the next record — it is part of the
    // change too (its deletion), so keep both.
    if (code[0] === "R" || code[0] === "C") {
      const orig = records[++i];
      if (orig) paths.push(orig);
    }
    paths.push(path);
  }
  const rootRel = relative(top, resolve(root)).replaceAll("\\", "/");
  const entries: { path: string; bytes: Uint8Array | null }[] = [];
  for (const p of new Set(paths)) {
    const rel = rootRel && p.startsWith(rootRel + "/")
      ? p.slice(rootRel.length + 1)
      : p;
    if (excluded(rel, excludes, opts.isOutput)) continue;
    let bytes: Uint8Array | null = null;
    try {
      const st = await Deno.stat(join(top, p));
      if (st.isDirectory) continue;
      bytes = await Deno.readFile(join(top, p));
    } catch {
      bytes = null; // deleted
    }
    entries.push({ path: rel, bytes });
  }
  return {
    repo: true,
    count,
    commit,
    hash: entries.length === 0 ? null : await contentHash8(entries),
  };
}

/** Hash of every file under `root` (minus excludes) — the identity of a
 *  project that has no repository to be identified by. */
async function projectTreeHash(
  root: string,
  excludes: readonly string[],
  isOutput?: (rel: string) => boolean,
): Promise<string> {
  const entries: { path: string; bytes: Uint8Array | null }[] = [];
  const walk = async (dir: string): Promise<void> => {
    let it: AsyncIterable<Deno.DirEntry>;
    try {
      it = Deno.readDir(dir);
    } catch {
      return;
    }
    for await (const e of it) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).replaceAll("\\", "/");
      if (excluded(rel, excludes, isOutput)) continue;
      if (e.isDirectory) await walk(abs);
      else if (e.isFile) {
        try {
          entries.push({ path: rel, bytes: await Deno.readFile(abs) });
        } catch {
          /* aio-ok: an unreadable file is not part of the tree identity — the build refuses it elsewhere */
        }
      }
    }
  };
  await walk(root);
  return contentHash8(entries);
}

/** `deno.json build.out`, as the root-relative exclude the tree reader wants. */
export function outDirExclude(root: string, out: string | undefined): string {
  const rel = relative(root, resolve(root, out ?? "dist")).replaceAll(
    "\\",
    "/",
  );
  return (rel && !rel.startsWith("..") ? rel : "dist") + "/";
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
  const tree = await readTreeFacts(root, {
    excludes: [outDirExclude(root, opts.out)],
    isOutput: opts.isOutput,
  });
  return { bv: resolveBuildVersion(declared, tree), fromFleet: false };
}

// ── the stamp ───────────────────────────────────────────────────────────────

export type BuildStamp = BuildVersion & { aio: string; builtAt: string };

/** Write the stamp the compiled artifact carries. Returns the path. */
export async function writeBuildStamp(
  root: string,
  bv: BuildVersion,
  aio: string,
): Promise<string> {
  const path = join(root, BUILD_STAMP_FILE);
  await Deno.mkdir(join(root, ".aio"), { recursive: true });
  const stamp: BuildStamp = { ...bv, aio, builtAt: new Date().toISOString() };
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
    return "unknown (compiled binary carries no build stamp — rebuild it with " +
      "aio's builder, `deno task build`)";
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

/** The version token as it appears in a FILE NAME: the full string, dirty /
 *  nogit suffix included, so a dirty artifact is visibly dirty. */
export const VERSION_TOKEN_RE =
  /\d+\.\d+\.\d+(?:-(?:dirty|nogit)\.[0-9a-f]{8})?/;

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
