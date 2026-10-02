/**
 * @module
 * Where this project's builds and publishes put their output — a FACT, written
 * down by the command that wrote there, in the project's own `.aio/` state.
 *
 * The version is an identity of the sources, so what a build wrote must not
 * count. `dist/` and the out dir of the build that is running are known by
 * name; the release a build left under ANOTHER `--out` last week, and the
 * directory `am publish` stages into, are not — and each was read as source:
 * the version moved with every build, and the second publish of a clean
 * checkout was refused as a dirty tree. Guessing them from their contents
 * hides any source folder that happens to look like one. So they are recorded.
 *
 * And the record is not believed as written. A directory a build would refuse
 * as its `out` — the project itself, `src/`, an app dir, anything inside or
 * around one — is never an output, whoever wrote it down: one decider
 * (`unsafeOutDir`) answers the build, the publish and the reader of the record.
 */
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { foreignOutEntries, isShipManifestName } from "../build/build-shape.ts";
import { resolveAppDir, resolveEntry } from "../build/config-rules.ts";
import { renameOver } from "../diagnostics/rename-over.ts";
import { isOsFolderLitter } from "./app-dirs.ts";
import { DIST_DIR } from "./app-files.ts";
import { readDenoJson } from "./deno-json.ts";

/** The record, relative to the project root. Inside `.aio/`, which no tree
 *  read counts. */
export const OUTPUTS_FILE = ".aio/outputs.json";

/** `dir` as a record entry — root-relative, `/`-separated, with a trailing
 *  `/` — or null when it is not a directory INSIDE the project (the root
 *  itself, a path outside it): nothing there is in the tree. Pure. */
export function outputEntry(root: string, dir: string): string | null {
  const rel = relative(resolve(root), resolve(root, dir)).replaceAll("\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    return null;
  }
  return /^[A-Za-z]:/.test(rel) ? null : `${rel}/`;
}

/** Strip a trailing separator so `/proj/apps/` and `/proj/apps` compare equal.
 *  (`/` itself keeps its single separator.) */
function trimSep(p: string): string {
  return p.length > 1 && p.endsWith(SEPARATOR) ? p.slice(0, -1) : p;
}

/** True when `a` IS `b` or lives inside it, compared by PATH SEGMENTS.
 *  Never `a.startsWith(b)`: that makes `/proj/appsX` "inside" `/proj/apps`, so
 *  a sibling with a near-miss name would be refused (or, in the other
 *  direction, a real containment missed). */
function within(a: string, b: string): boolean {
  const x = trimSep(a), y = trimSep(b);
  return x === y || x.startsWith(y.endsWith(SEPARATOR) ? y : y + SEPARATOR);
}

/** True if `outDir` is unsafe to wipe+recreate: the `out` dir is assembled by
 *  removing it RECURSIVELY, so it must be a dedicated subdir of the project
 *  that CONTAINS no protected directory and lives INSIDE none — never the root,
 *  an ancestor (`out: ".."`), `.aio` (our staging parent), `.git`, or a source
 *  dir. `out: ""` / `"."` resolve to the root and are caught here.
 *
 *  Containment, in BOTH directions, is the whole guard. Exact-set membership
 *  (what this used to test) let `out: "apps"` past while the app lived in
 *  `apps/web/` — the build then deleted the user's source tree, printed
 *  `✓ 1/1 build(s)` and exited 0. The descendant direction is just as fatal:
 *  `out: "src/ui"` under an app dir of `src/` wipes half the app.
 *
 *  `appDirs` are THE app-dir decider's answers (`BuildConfig.appDir`), one per
 *  target. `src/` is hardcoded only because it is the scaffold's convention; an
 *  app whose entry lives at `apps/web/main.ts` keeps its sources somewhere this
 *  list cannot guess.
 *
 *  It is a LIST, not one dir, because per-target entries mean one repo can hold
 *  two apps: guarding only the first target's dir would leave the second app's
 *  sources deletable — the exact hole the guard exists to close. Pass every
 *  target's dir; duplicates are fine. An app dir that IS the root (a flat
 *  layout, entry `app.ts`) is dropped: the root is already refused above, and
 *  keeping it would make every possible out dir "inside a protected dir" and
 *  leave a flat-layout app with nowhere to build.
 *
 *  @internal alpha70 — a build/tooling internal reachable for tests via
 *  src/testing/internal.ts; not app-facing API. */
export function unsafeOutDir(
  outDir: string,
  root: string,
  appDirs: readonly string[] = [],
): boolean {
  // What each path IS, not how it was spelled: `--out=srclink` (a link to
  // `src`) and `--dir='src '` named the app's sources and compared unequal to
  // them.
  const out = realDir(outDir);
  const rootDir = realDir(root);
  // Must be a STRICT subdirectory of the project (this also catches the root
  // itself, `/`, and anything outside the project). Unfolded: folding may
  // only ever refuse more, and a folded name could pull an outside directory
  // in.
  if (out === rootDir || !within(out, rootDir)) return true;
  const protectedDirs = [
    join(rootDir, ".aio"),
    join(rootDir, "src"),
    join(rootDir, ".git"),
    ...appDirs.map(realDir),
  ].filter((d) => d !== rootDir);
  // dist/ is the per-target builds' own scratch: every child wipes it
  // recursively before bundling, so an out dir INSIDE it is deleted mid-run by
  // a sibling target — after the first one reported success. `out: "dist"`
  // ITSELF stays legal, and is the default: the fleet moves the previous dist/
  // aside before any child runs, which is what makes the exact case safe and
  // the nested case fatal. The single-target builder refused `--out=dist/x`
  // for the same reason; since alpha73 routes every build through the fleet,
  // the rule has to live where the decision now is.
  // Both directions: `out` may not sit inside a protected dir, and may not
  // swallow one. Compared FOLDED, the way the strictest file system reads a
  // name: on a case-insensitive one (the macOS and Windows defaults)
  // `--out=Src` IS `src/`, and on Windows so are `src.` and `src ` — each
  // passed a byte-exact check, and the out-dir wipe deleted the app's source.
  // Folding everywhere costs a Linux user only such names for a build folder.
  const lo = foldPath;
  // dist/ is per-target scratch, folded like everything else: `--out=DIST` is
  // dist/ on macOS/Windows, and the byte-exact check let it (and `Dist/x`)
  // through while `--out=Src` was rightly refused.
  const distDir = join(rootDir, DIST_DIR);
  if (lo(out) !== lo(distDir) && within(lo(out), lo(distDir))) return true;
  return protectedDirs.some((d) =>
    within(lo(out), lo(d)) || within(lo(d), lo(out))
  );
}

/** `path` as the directory it is: absolute, with every symlink on the way
 *  resolved — the real path of the nearest ancestor that exists, plus the
 *  segments below it that do not exist yet. */
export function realDir(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return trimSep(join(Deno.realPathSync(head), ...rest));
    } catch {
      // aio-ok: not there (yet) — its parent decides, and the name is kept
      const up = dirname(head);
      if (up === head) return trimSep(join(head, ...rest));
      rest.unshift(basename(head));
      head = up;
    }
  }
}

/** `path` with every segment spelled the way the strictest file system reads
 *  it: lower case, and without the trailing dots and spaces Windows drops
 *  (`src.` and `src ` are `src` there). For comparing only. Pure. */
export function foldPath(path: string): string {
  return path.split(SEPARATOR).map((seg) =>
    seg.toLowerCase().replace(/[. ]+$/, "") || seg
  ).join(SEPARATOR);
}

/** Is `dir` apart from the project at `root` — neither inside it nor around
 *  it, as the directories they are? Nothing of the project is there. */
export function apartFrom(root: string, dir: string): boolean {
  const a = realDir(dir), b = realDir(root);
  return !within(a, b) && !within(b, a);
}

/** The app dirs of the project — the default entry's and every target's own
 *  (`build.targets.<name>.entry`): what an output dir may never be, hold or
 *  sit inside. Pure. */
export function appDirsOf(
  root: string,
  config: Record<string, unknown>,
): string[] {
  const targets = (config.build as { targets?: unknown } | undefined)?.targets;
  const entries = targets && typeof targets === "object"
    ? Object.values(targets).map((t) =>
      (t as { entry?: unknown } | null)?.entry
    )
    : [];
  return [
    ...new Set(
      [undefined, ...entries].map((e) =>
        resolveAppDir(
          root,
          resolveEntry(
            config,
            typeof e === "string" ? e.trim() || undefined : undefined,
          ),
        )
      ),
    ),
  ];
}

/** What the directory `outDir` holds, as {@linkcode foreignOutEntries} takes
 *  it: its entries, the parsed `manifest.json` of the release in it (or null),
 *  and each DIRECTORY entry's own entries (a nested directory as `name/`). A
 *  directory that is not there holds nothing. */
export async function outDirListing(
  outDir: string,
): Promise<[string[], unknown, Record<string, string[]>]> {
  const entries: string[] = [];
  // A directory's own entries — a publish channel dir (see
  // foreignOutEntries) is aio's only when everything in it is.
  const dirs: Record<string, string[]> = {};
  try {
    for await (const e of Deno.readDir(outDir)) {
      entries.push(e.name);
      if (!e.isDirectory) continue;
      const inside: string[] = [];
      for await (const f of Deno.readDir(join(outDir, e.name))) {
        // A nested directory is never publish output: listed as itself, it
        // matches no rule and keeps the directory foreign.
        inside.push(f.isDirectory ? `${f.name}/` : f.name);
      }
      dirs[e.name] = inside;
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  let previous: unknown = null;
  try {
    previous = JSON.parse(
      await Deno.readTextFile(join(outDir, "manifest.json")),
    );
  } catch {
    // aio-ok: no previous release here — every entry is foreign, which is
    // the refusing answer, so nothing is swallowed
  }
  return [entries, previous, dirs];
}

/** Does the directory at `at` carry what a build or a publish put there —
 *  the proof a record needs before the directory is left out of the version?
 *
 *  - a build's out dir: nothing in it but a release, by the rule the build
 *    itself refuses an out dir by ({@linkcode foreignOutEntries});
 *  - a publish channel dir: the update manifest publish writes
 *    (`<os>-<arch>.json`) — older artifacts stay beside it, listed nowhere;
 *  - a publish dir: nothing in it but such channel dirs.
 *
 *  A directory that is not there, or is empty, has nothing to leave out. One
 *  that holds anything else — an out dir reused for source, a folder somebody
 *  wrote into the record — is not an output, whatever the record says. */
async function carriesOutput(at: string): Promise<boolean> {
  let listing: Awaited<ReturnType<typeof outDirListing>>;
  try {
    listing = await outDirListing(at);
  } catch {
    // aio-ok: a file, or a directory that cannot be read — no proof, it counts
    return false;
  }
  const [entries, previous, dirs] = listing;
  if (foreignOutEntries(...listing).length === 0) return true;
  // A release's manifest makes it a build's out dir, and that rule the only
  // one: a ship manifest beside the binary does not excuse a stray file.
  if (Array.isArray((previous as { targets?: unknown } | null)?.targets)) {
    return false;
  }
  if (entries.some((e) => !Object.hasOwn(dirs, e) && isShipManifestName(e))) {
    return true;
  }
  // A file the desktop dropped there is nobody's: no proof, and no objection.
  return entries.filter((e) => !isOsFolderLitter(e)).every((e) =>
    Object.hasOwn(dirs, e) && dirs[e]!.some(isShipManifestName)
  );
}

/** The entries of `entries` that CAN be output dirs of the project: each a
 *  plain `<rel>/` exactly as {@linkcode outputEntry} spells it, which the
 *  out-dir guard accepts. What it refuses can never become one. */
async function guarded(
  root: string,
  entries: readonly unknown[],
): Promise<string[]> {
  let appDirs: string[];
  try {
    appDirs = appDirsOf(root, (await readDenoJson(root))?.config ?? {});
  } catch {
    // aio-ok: a deno.json that does not parse names no app dir to protect, so
    // nothing is left out — the directories count, which shows
    return [];
  }
  const dir = resolve(root);
  return entries.filter((e): e is string =>
    typeof e === "string" && outputEntry(dir, e) === e &&
    !unsafeOutDir(resolve(dir, e), dir, appDirs)
  );
}

/** The record as written: whatever JSON array is there, else nothing. */
async function recordAsWritten(root: string): Promise<unknown[]> {
  try {
    const parsed = JSON.parse(
      await Deno.readTextFile(join(root, OUTPUTS_FILE)),
    );
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // aio-ok: no record (or not JSON) records nothing — the visible answer
    return [];
  }
}

/** The recorded output dirs of the project at `root` (each `<rel>/`): the
 *  entries the out-dir guard accepts, and of those the ones that on disk carry
 *  an output and nothing else ({@linkcode carriesOutput}) — asked at every
 *  read, so a directory counts while a stray file lies in it and is an output
 *  again once the file is gone. A missing or unreadable record is an empty
 *  one. Whatever is not returned COUNTS, which moves the version where
 *  everyone can see it — never the reverse. */
export async function recordedOutputs(root: string): Promise<string[]> {
  const dir = resolve(root);
  const out: string[] = [];
  for (const e of await guarded(root, await recordAsWritten(root))) {
    if (await carriesOutput(resolve(dir, e))) out.push(e);
  }
  return out;
}

/** Write down that `dir` is where a build or publish of `root` puts output.
 *  Nothing is recorded for a directory outside the project, or for one the
 *  out-dir guard refuses — and such entries already in the record are dropped
 *  with this write. A name stays recorded while its directory is gone, or
 *  holds something no build put there: it is asked again at every read. */
export async function recordOutput(root: string, dir: string): Promise<void> {
  const entry = await guarded(root, [outputEntry(root, dir)]);
  if (!entry.length) return;
  const all = new Set([
    ...await guarded(root, await recordAsWritten(root)),
    ...entry,
  ]);
  const next = JSON.stringify([...all].sort(), null, 2) + "\n";
  const file = join(root, OUTPUTS_FILE);
  if (await Deno.readTextFile(file).catch(() => null) === next) return; // aio-ok: absent is the answer
  await Deno.mkdir(join(root, ".aio"), { recursive: true });
  // Whole or not at all: a build and a publish may both be writing it.
  const tmp = `${file}.${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, next);
  await renameOver(tmp, file);
}
