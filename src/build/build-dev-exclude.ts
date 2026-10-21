/**
 * @module
 * Dev-only exclusion — what keeps build/dev/test-only npm packages out of a
 * compiled binary: the npm graph walk, the file trim, the moved-aside symlinks
 * and their crash journals. Split out of build-compile.ts, which re-exports
 * every name here, so no importer changes.
 */

import { readDenoJson } from "../server/deno-json.ts";
import {
  _lockTiming,
  foreignLockAlive,
  foreignNs,
  holderAlive,
  keepFresh,
  lockOwner,
  ownIdTail,
  type ProcId,
  readOrNull,
  releasePidLock,
  touchedRecently,
  tryPidLock,
  withTag,
} from "../server/pid-lock.ts";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import { normalize as posixNormalize } from "@std/path/posix";
import {
  hostPlatform,
  type NpmSystem,
  npmSystemOf,
  PLATFORMS,
  runsOn,
} from "./platforms.ts";
import { LINK_JOURNAL_RE, TRIM_JOURNAL_RE } from "./build-journals.ts";
import { HEY, NO } from "../diagnostics/fmt.ts";
import { INSTALL_BIN_DIR, INSTALL_STATE_FILES } from "./artifact-audit.ts";

/** npm packages the FRAMEWORK only ever needs at BUILD / DEV / TEST time.
 *  None of them is reachable from a compiled binary:
 *   - `esbuild`    — the dev transpiler and the bundler; prod serves `dist/app.js`.
 *   - `electron`   — the npm package is the INSTALLER. A compiled desktop app
 *                    fetches its own Electron runtime (`build/electron-runtime.ts`).
 *   - `happy-dom`  — `testUI` and the headless `am surface` route, and
 *                    `server.ts` only wires that route up when `!prod`.
 *   - `typescript` — the compiler. An aio app is AUTHORED in TypeScript and the
 *                    build transpiles it ahead of time (esbuild + Deno); the
 *                    shipped binary never runs `tsc`. Left in, the whole
 *                    compiler rides along: `tsc`/`tsc.exe` copies (~23 MB each),
 *                    `typescript.js` and hundreds of `lib.*.d.ts` — ~152 MB of
 *                    VFS on a real desktop host (a field
 *                    report). An app that genuinely `import`s typescript
 *                    at RUNTIME is the rare exception and opts back in with
 *                    `build.keepPackages` (see {@link keepPackagesDeclared}).
 *
 *  Their TRANSITIVE closure goes too, and that closure is where the weight is:
 *  happy-dom 13 MB, @electron-internal/extract-zip 7 MB, @types/node 2.4 MB,
 *  undici 1.6 MB — 25 MB in a hello-world binary. A name-prefix list could
 *  never have caught them (`@electron-internal+…` does not start with
 *  `@electron+`, and `undici` looks like nobody's dependency), which is why
 *  this is a graph walk over the layout deno already wrote. */
const DEV_ONLY_PACKAGES = ["electron", "esbuild", "happy-dom", "typescript"];

/** Is a package NAME build-only by aio's own classification? Beyond
 *  {@link DEV_ONLY_PACKAGES} themselves this covers the platform packages they
 *  pull in (`@typescript/typescript-*`, `@esbuild/*`), which a compiled app
 *  never loads. It is keyed by NAME, not the tree, because a real app reached
 *  `typescript`/`tsc` only as a PEER of its other deps — no top-level
 *  `node_modules/typescript` symlink existed, so the tree walk missed it and
 *  152 MB of compiler shipped (a field report). `build.keepPackages`
 *  still wins. Pure. */
export function devOnlyPackageByName(pkg: string): boolean {
  return DEV_ONLY_PACKAGES.includes(pkg) ||
    pkg.startsWith("@typescript/") ||
    pkg.startsWith("@esbuild/");
}

/** True when `pkg` is covered by a `build.keepPackages` name — itself, or the
 *  family it belongs to: `@typescript/*` and `@esbuild/*` are the platform
 *  packages OF `typescript`/`esbuild`, and keeping the tool without its native
 *  binary would ship a tool that cannot run. Pure. */
export function keptByFamily(pkg: string, keep: ReadonlySet<string>): boolean {
  if (keep.has(pkg)) return true;
  if (pkg.startsWith("@typescript/") && keep.has("typescript")) return true;
  if (pkg.startsWith("@esbuild/") && keep.has("esbuild")) return true;
  return false;
}

/** The package NAME of an npm id, dropping a peer suffix and the version:
 *  `@scope/pkg@1.2.3_peer@4.5.6` → `@scope/pkg`, `esbuild@0.24.2` → `esbuild`.
 *  Pure. */
export function packageNameOfNpmId(id: string): string | null {
  // The FIRST `@` past a scope's own: a name may hold `_` (`string_decoder`)
  // and a peer suffix holds more `@` (`…_typescript@6.0.3`), so neither a
  // split on `_` nor the LAST `@` finds where the name ends.
  const at = id.indexOf("@", 1);
  return at <= 0 ? null : id.slice(0, at);
}

type SavedLink = { path: string; target: string; isDir: boolean };

/** A `node_modules/.deno` entry name → its package name
 *  (`@electron+get@5.1.0` → `@electron/get`, `immer@10.2.0` → `immer`).
 *  `null` for anything that is not `<pkg>@<version>` — notably the flat
 *  `.deno/node_modules` fallback dir, which is not a package. */
export function denoNmPackageName(dir: string): string | null {
  // First `@` past a scope's own — a peer-suffixed entry
  // (`@scope+tool@1.0.0_typescript@6.0.3`) carries a second one.
  const at = dir.indexOf("@", 1);
  if (at <= 0) return null;
  return dir.slice(0, at).replace("+", "/");
}

/** Which `.deno` entries are reachable ONLY through a dev-only package — i.e.
 *  the set that is safe to leave out of the binary.
 *
 *  Pure over the edge map so the rule is unit-testable without a node_modules
 *  tree. Anything a REAL dependency can also reach is kept, so widening
 *  {@link DEV_ONLY_PACKAGES} can only ever shrink the binary, never break it. */
export function devOnlyClosure(
  graph: Map<string, Set<string>>,
  devRoots: readonly string[],
  keepRoots: readonly string[],
): string[] {
  const reach = (roots: readonly string[]) => {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const n = queue.pop()!;
      if (!graph.has(n) || seen.has(n)) continue;
      seen.add(n);
      for (const d of graph.get(n)!) if (!seen.has(d)) queue.push(d);
    }
    return seen;
  };
  const keep = reach(keepRoots);
  return [...reach(devRoots)].filter((d) => !keep.has(d)).sort();
}

/** The `.deno` entry a path RELATIVE to `.deno` lies in
 *  (`typescript@5.6.3/node_modules/typescript` → `typescript@5.6.3`), or null
 *  when its first segment is not a package entry. The path is the host's own
 *  (`relative()`), so on Windows it arrives with backslashes. Pure. */
export function denoEntryOfRel(rel: string): string | null {
  const first = rel.split(/[\\/]/)[0]!;
  return denoNmPackageName(first) ? first : null;
}

/** Resolve one symlink to the `.deno` entry it lands in, or null. */
async function _denoEntryOf(
  denoDir: string,
  linkPath: string,
): Promise<string | null> {
  try {
    const target = await Deno.readLink(linkPath);
    const abs = isAbsolute(target) ? target : join(dirname(linkPath), target);
    const rel = relative(denoDir, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return denoEntryOfRel(rel);
  } catch {
    return null; // not a symlink, or it dangles
  }
}

/** Every symlink directly under `dir`, one scope level deep
 *  (`@scope/pkg` lives in a real `@scope/` directory). */
async function _linksIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isSymlink) out.push(p);
      else if (e.isDirectory && e.name.startsWith("@")) {
        try {
          for await (const i of Deno.readDir(p)) {
            if (i.isSymlink) out.push(join(p, i.name));
          }
        } catch { /* raced away */ }
      }
    }
  } catch { /* no such dir */ }
  return out;
}

/** The dependency edges deno's `.deno` layout already records: every package
 *  dir carries its OWN `node_modules/`, whose symlinks point at the sibling
 *  `.deno` entries that package may resolve. */
export async function readDenoNmGraph(
  denoDir: string,
): Promise<Map<string, Set<string>>> {
  const graph = new Map<string, Set<string>>();
  const entries: string[] = [];
  try {
    for await (const e of Deno.readDir(denoDir)) {
      if (e.isDirectory && denoNmPackageName(e.name)) entries.push(e.name);
    }
  } catch {
    return graph; // no .deno — nothing to exclude
  }
  for (const name of entries) {
    const deps = new Set<string>();
    for (const link of await _linksIn(join(denoDir, name, "node_modules"))) {
      const dep = await _denoEntryOf(denoDir, link);
      if (dep && dep !== name) deps.add(dep);
    }
    graph.set(name, deps);
  }
  return graph;
}

/** The slice of `deno info --json` this build reads. */
export type DenoInfoGraph = {
  modules?: Array<{
    kind?: string;
    npmPackage?: string;
    specifier?: string;
    /** The file on disk — absent for an npm package (one entry per package). */
    local?: string;
    dependencies?: Array<{
      specifier?: string;
      type?: string;
      /** The specifier as written, before import-map resolution — a bare
       *  `typescript` here while `specifier` is the resolved URL. */
      code?: { specifier?: string };
      /** An `import()` — absent for a static import. */
      isDynamic?: boolean;
    }>;
  }>;
  npmPackages?: Record<
    string,
    {
      dependencies?: string[];
      /** Deno's OWN id → directory mapping for this package (see
       *  {@link denoEntryFromLocalPath}). Absent on older deno shapes, where
       *  the legacy `.deno` name derivation is used instead. */
      localPath?: string;
    }
  >;
};

/** True when `pkgName` is imported by a module that is NOT part of aio's own
 *  build tooling (`buildDirHref`). aio's build modules are themselves embedded
 *  in the app graph and dynamically import esbuild, so without this filter the
 *  "build-only package is reachable" warning fires on every app that merely
 *  DECLARES esbuild (every scaffold) — a warning nobody can act on is noise
 *  that trains people to ignore the one that matters. The app's own code
 *  importing the package is the signal that a runtime load is real. Pure. */
export function reachedOutsideBuildTooling(
  graphs: readonly DenoInfoGraph[],
  pkgName: string,
  buildDirHref: string,
): boolean {
  const want = `npm:${pkgName}`;
  const wantSlash = `npm:/${pkgName}`;
  const isPkg = (s: string) =>
    s === want || s.startsWith(`${want}@`) || s.startsWith(`${want}/`) ||
    s === wantSlash || s.startsWith(`${wantSlash}@`) ||
    s.startsWith(`${wantSlash}/`);
  for (const g of graphs) {
    for (const m of g.modules ?? []) {
      if ((m.specifier ?? "").startsWith(buildDirHref)) continue;
      for (const d of m.dependencies ?? []) {
        if (isPkg(d.code?.specifier ?? "") || isPkg(d.specifier ?? "")) {
          return true;
        }
      }
    }
  }
  return false;
}

/** The packages the app's own modules IMPORT that are built for another
 *  system than the target (`foreign`: their `.deno` entries) — each with
 *  whether some module imports it statically.
 *
 *  Such a package is left out of the binary, rightly: its native code cannot
 *  run there. But the import stays, and the build said nothing — a Windows exe
 *  with `import "@x/thing-linux-x64-gnu"` in its entry was built green and
 *  could not start. A package only a DEPENDENCY reaches (the per-system
 *  natives a wrapper lists as optional) is not named: the wrapper picks the
 *  one that is there. One kept by its exact name is shipped, so not named
 *  either. Pure. */
export function importedForeign(
  graphs: readonly DenoInfoGraph[],
  foreign: ReadonlySet<string>,
  keep: ReadonlySet<string>,
): Array<{ pkg: string; static: boolean }> {
  const out = new Map<string, boolean>();
  for (const g of graphs) {
    // A module of kind "npm" is a package some non-npm module names.
    for (const m of g.modules ?? []) {
      if (m.kind !== "npm" || !m.npmPackage) continue;
      const pkg = packageNameOfNpmId(m.npmPackage);
      const entry = denoEntryNameOf(
        m.npmPackage,
        g.npmPackages?.[m.npmPackage]?.localPath,
      );
      if (!pkg || keep.has(pkg) || !foreign.has(entry)) continue;
      const names = (s = "") =>
        [`npm:${pkg}`, `npm:/${pkg}`].some((p) =>
          s === p || s.startsWith(`${p}@`) || s.startsWith(`${p}/`)
        );
      const statically = (g.modules ?? []).some((from) =>
        from.kind !== "npm" &&
        (from.dependencies ?? []).some((d) =>
          !d.isDynamic && (names(d.code?.specifier) || names(d.specifier))
        )
      );
      out.set(pkg, (out.get(pkg) ?? false) || statically);
    }
  }
  return [...out].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([pkg, statically]) => ({ pkg, static: statically }));
}

/** The npm package ids (`pkg@version`) the graphs reach — the union over every
 *  root, closed over their declared dependencies. Pure. */
export function reachedNpmPackages(
  graphs: readonly DenoInfoGraph[],
): Set<string> {
  const all = new Map<string, string[]>();
  for (const g of graphs) {
    for (const [id, p] of Object.entries(g.npmPackages ?? {})) {
      all.set(id, p.dependencies ?? []);
    }
  }
  const reached = new Set<string>();
  const queue = graphs.flatMap((g) =>
    (g.modules ?? []).flatMap((m) =>
      m.kind === "npm" && m.npmPackage ? [m.npmPackage] : []
    )
  );
  while (queue.length) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(...(all.get(id) ?? []));
  }
  return reached;
}

/** The `.deno` directory name inside a deno `localPath`
 *  (`…/node_modules/.deno/@scope+pkg@1.2.3/node_modules/@scope/pkg` →
 *  `@scope+pkg@1.2.3`), or null when the path carries no `.deno` segment.
 *  Windows separators are normalised. Pure. */
export function denoEntryFromLocalPath(localPath?: string): string | null {
  if (!localPath) return null;
  const lp = localPath.replaceAll("\\", "/");
  const marker = "/.deno/";
  const i = lp.lastIndexOf(marker);
  if (i < 0) return null;
  // aio-ok: path-split — `\\` normalised to `/` above
  return lp.slice(i + marker.length).split("/")[0]!;
}

/** The `.deno` directory name for an npm id. `localPath` is deno's OWN
 *  id → directory mapping and is authoritative: it already resolves a
 *  peer-suffixed id (`@scope/pkg@1.2.3_peer@4.5.6`) to the unsuffixed
 *  directory, and it names a directory that simply does not exist for an
 *  optional/platform variant that is not installed. Only when deno gave no
 *  path (older shapes, fixtures) does the legacy derivation apply. Pure. */
export function denoEntryNameOf(id: string, localPath?: string): string {
  return denoEntryFromLocalPath(localPath) ?? id.replaceAll("/", "+");
}

/** The `.deno` entry names (`@scope+pkg@1.2.3`) that NO module of the
 *  binary's graph can reach — safe to leave out, measured rather than listed.
 *
 *  `deno compile` with a `node_modules` dir embeds the whole tree, whatever
 *  the server imports. A 3D app shipped three.js (27 MB) and its typings
 *  inside a server that never loads them — the browser bundle already carries
 *  what the page needs — and every cross-compiled Windows exe gained esbuild's
 *  Windows binary (10 MB), because deno links it DURING the compile, after a
 *  list built from the tree on disk was already made (field report,
 *  2026-09-17). The lockfile knows every package, and the graph knows which
 *  ones are imported: this is the difference, plus every `@types/*` (type
 *  information only, never loaded).
 *
 *  The mapping from an id to its `.deno` name uses `localPath` (deno's own
 *  answer), not `id.replaceAll("/", "+")`: a peer-resolved id carries a suffix
 *  the directory does not (`@scope/pkg@5.5.1_typescript@6.0.3` lives in
 *  `@scope+pkg@5.5.1`), and `deno info` lists optional/platform variants
 *  (`@esbuild/aix-ppc64`, `@typescript/typescript-win32-x64`) that are simply
 *  not installed. Without `localPath`, 486 reached ids met 474 `.deno` entries
 *  and the old code bailed to "embed everything" on every real graph
 *  (a field report).
 *
 *  `graphs` is one `deno info --json` per root (the entry, the DB worker, each
 *  embedded server module). Returns null when a reachable package has NEITHER
 *  a `localPath` NOR a `.deno` entry under the legacy name — a layout this
 *  cannot map is a reason to exclude nothing, never a guess. Pure. */
export function unreachableNpmEntries(
  graphs: readonly DenoInfoGraph[],
  denoEntries: ReadonlySet<string>,
): string[] | null {
  const all = new Map<
    string,
    { dependencies?: string[]; localPath?: string }
  >();
  for (const g of graphs) {
    for (const [id, p] of Object.entries(g.npmPackages ?? {})) all.set(id, p);
  }
  const reached = reachedNpmPackages(graphs);
  const entryOf = (id: string, p?: { localPath?: string }): string =>
    denoEntryNameOf(id, p?.localPath);
  for (const id of reached) {
    if (id.startsWith("@types/") || id.startsWith("@typescript/")) continue;
    const p = all.get(id);
    if (!p?.localPath && !denoEntries.has(entryOf(id, p))) return null;
  }
  const out = new Set<string>();
  for (const [id, p] of all) {
    if (
      reached.has(id) && !id.startsWith("@types/") &&
      !id.startsWith("@typescript/")
    ) continue;
    out.add(entryOf(id, p));
  }
  return [...out].sort();
}

/** `deno info --json` for each module root, or null if any cannot be read.
 *  A root an earlier root's graph already loads is not asked again: its
 *  whole graph is in that one (an included directory is one root per file). */
export async function denoInfoGraphs(
  cwd: string,
  roots: readonly string[],
): Promise<DenoInfoGraph[] | null> {
  const out: DenoInfoGraph[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    if (seen.has(resolve(cwd, r))) continue;
    try {
      const p = await new Deno.Command("deno", {
        args: ["info", "--json", r],
        cwd,
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!p.success) return null;
      const g = JSON.parse(new TextDecoder().decode(p.stdout)) as DenoInfoGraph;
      out.push(g);
      for (const m of g.modules ?? []) if (m.local) seen.add(m.local);
    } catch {
      return null;
    }
  }
  return out;
}

export const MODULE_FILE_RE = /\.(m?[jt]sx?)$/;

/** The module files a compile embeds as ROOTS: the entry, every `--include`
 *  that is itself a module (the DB worker, `.server.ts` assets), and
 *  `dirModules` — the modules under an included directory
 *  ({@link includeDirModules}). Pure. */
export function compileModuleRoots(
  entry: string,
  includeArgs: readonly string[],
  dirModules: readonly string[] = [],
): string[] {
  const roots = [entry];
  includeArgs.forEach((a, i) => {
    const v = includeArgs[i + 1];
    if (a === "--include" && v && MODULE_FILE_RE.test(v)) roots.push(v);
  });
  return [...new Set([...roots, ...dirModules])];
}

/** The module files under each DIRECTORY deno.json `compile.include` names,
 *  root-relative. `deno compile` makes every one of them a module root, so
 *  the build must too: read as data only, a package one of them imports was
 *  "unreachable", left out of the binary, and missing when the app loaded
 *  that module (`build.keepPackages` was the only way to say it). Not the
 *  `assets` mounts — those are served to a browser, never loaded here. A
 *  nested `node_modules` and a symlink are not walked. A deno.json that does
 *  not parse, or a bad entry, is `assetIncludes`' to report (it runs first). */
export async function includeDirModules(root: string): Promise<string[]> {
  let decl: unknown;
  try {
    decl = ((await readDenoJson(root))?.config as
      | { compile?: { include?: unknown } }
      | undefined)?.compile?.include;
  } catch {
    return []; // aio-ok: said by assetIncludes' compile.include read
  }
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return; // aio-ok: a file (a root by its own name already) or not there — deno compile refuses a missing include itself
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory) {
        if (e.name !== "node_modules") await walk(p);
      } else if (e.isFile && MODULE_FILE_RE.test(e.name)) {
        out.push(relative(root, p).split("\\").join("/"));
      }
    }
  };
  for (const p of Array.isArray(decl) ? decl : []) {
    if (typeof p === "string" && p.trim()) await walk(join(root, p.trim()));
  }
  return out.sort();
}

/** `build.keepPackages` — npm package names the app needs at RUNTIME even
 *  though aio classifies them dev-only ({@link DEV_ONLY_PACKAGES}). The escape
 *  hatch for the rare app that really does `import "typescript"` (or esbuild)
 *  while running. A name here is never excluded by the dev-closure walk, and
 *  never dropped as "unreachable" — the app asked for it by name.
 *
 *  Validated like every other option: an array of non-empty strings, refused
 *  by name otherwise (a typo'd `"typescript"` string instead of an array would
 *  otherwise silently keep excluding it). Missing `build` block → `[]`. */
export async function keepPackagesDeclared(root: string): Promise<string[]> {
  let cfg: { build?: { keepPackages?: unknown } } | undefined;
  try {
    cfg = (await readDenoJson(root))?.config as
      | { build?: { keepPackages?: unknown } }
      | undefined;
  } catch (e) {
    console.warn(
      `${HEY} deno.json could not be read (${
        e instanceof Error ? e.message : e
      }) — no build.keepPackages applied`,
    );
    return [];
  }
  const v = cfg?.build?.keepPackages;
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new Error(
      `${NO} deno.json build.keepPackages is ${
        JSON.stringify(v)
      } — it must be an array of npm package names (e.g. ["typescript"]).`,
    );
  }
  return v.map((p, i) => {
    if (typeof p !== "string" || p.trim() === "") {
      throw new Error(
        `${NO} deno.json build.keepPackages[${i}] is ${
          JSON.stringify(p)
        } — expected a non-empty package name.`,
      );
    }
    return p.trim();
  });
}

/** Temporarily remove dev symlinks, run compile callback, restore symlinks. Returns callback result. */
export async function withDevExcluded(
  nmDir: string,
  fn: (excludes: string[]) => Promise<boolean>,
  /** The binary's module roots (see {@link compileModuleRoots}); when given,
   *  every npm package none of them reaches is left out too — unless
   *  `keepUnreached`, which reads the graph for its warnings and name rules
   *  only (the `cli` targets, whose package set this never narrowed). */
  graph?: {
    cwd: string;
    roots: readonly string[];
    keepUnreached?: boolean;
    /** The roots a cross build INSTALLS for (default: `roots`). The modules
     *  under an included directory are read for what they reach, never
     *  installed for: `deno install --entrypoint` refuses a file whose import
     *  does not resolve, and such a file under `compile.include` is data the
     *  compile itself accepts. */
    installRoots?: readonly string[];
  },
  /** Package names to KEEP even when {@link DEV_ONLY_PACKAGES} lists them
   *  (deno.json `build.keepPackages`). `keepRoots` still wins for everything
   *  reachable from a non-dev root. */
  keepPackages: readonly string[] = [],
  /** The platform the binary is FOR (a `PLATFORMS` name; default: the host).
   *  Native packages of every other system are left out, and for a cross
   *  build the target's own are installed before anything is decided. */
  platform: string = hostPlatform(),
): Promise<boolean> {
  // ONE build at a time may hold the project's dev symlinks aside.
  //
  // This removes `node_modules/electron`, `node_modules/esbuild` and their
  // scope dirs, then restores them in `finally`. Two builds overlapping in the
  // same project — `build-all` runs each target as a subprocess, and nothing
  // stopped a second `deno task compile` in another terminal — meant one
  // observing the other's half-removed state, and a restore racing a removal
  // leaves a project whose `node_modules/electron` is simply gone (the restore
  // failure is a `console.warn`, so the next `deno task dev` is the one that
  // finds out). A lock file makes the window unreachable rather than unlikely.
  const lock = join(nmDir, ".aio-build-lock");
  //
  // The lock and its `.id` stamp change ONLY under the lock's mutex (take,
  // take over, release), so a compare-and-remove never acts on half of one: a
  // new lock beside the dead holder's stamp read as "pid recycled" and a
  // waiter deleted the LIVE lock whenever the two pids matched.
  let held = false;
  let owner: ProcId | null = null;
  // ~60 s, then build beside it. Another pid namespace's lock counts as dead
  // only once THIS process watched it untouched for `staleMs` (pid-lock.ts),
  // so wait that long too — else a restarted container's dead lock is never
  // taken over and every build waits, then builds beside it.
  const polls = () =>
    600 + (owner && foreignNs(owner) ? _lockTiming.staleMs / 100 + 50 : 0);
  let i = 0;
  for (; i < polls() && !held; i++) {
    try {
      await Deno.mkdir(nmDir, { recursive: true });
    } catch { /* aio-ok: unwritable node_modules — waited out like a holder */ }
    // Someone else is excluding right now: wait rather than interleave. A
    // holder that died without cleaning up is taken over (see pid-lock.ts).
    const r = tryPidLock(lock);
    held = r.held;
    owner = r.owner;
    if (held || r.retry) continue;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!held) {
    const where = owner
      ? ` (pid ${owner.pid}${
        foreignNs(owner)
          ? " in another pid namespace — a container sharing node_modules"
          : ""
      })`
      : "";
    console.warn(
      `${HEY} ${lock} is still held after ${
        Math.round(i / 10)
      } s${where} — building beside ` +
        `it. If no other build is running, delete ${lock}.`,
    );
  }
  const release = () => {
    if (!held) return;
    held = false;
    try {
      releasePidLock(lock);
    } catch (e) {
      console.warn(
        `${HEY} could not release ${lock} (${e}) — a later build takes ` +
          `it over once this process exits.`,
      );
    }
  };
  try {
    const seen = new Set<string>();
    const run = () =>
      _withDevExcluded(nmDir, fn, graph, keepPackages, release, platform, seen);
    if (!await run()) return false;
    // What the compile ITSELF installed. `deno compile` resolves more than the
    // entry reaches — a linked framework's own pinned dependencies among them
    // — and those arrive after the exclude list and the trim were decided:
    // measured, an app on `happy-dom@^20` (20.14.6 that day) built against
    // aio's pinned 20.14.5 carried the whole of it, and its dependencies
    // through its links, in the FIRST binary and in no later one. So the
    // later one is built now: once more, with everything on disk.
    if (seen.size === 0) return true;
    const late = [...(await readDenoNmGraph(join(nmDir, ".deno"))).keys()]
      .filter((e) => !seen.has(e)).sort();
    if (late.length === 0) return true;
    console.log(
      `${late.length} package(s) were installed by the compile itself (${
        late.slice(0, 3).join(", ")
      }${late.length > 3 ? ", …" : ""}) — after what stays out of the ` +
        `binary was decided. Compiling once more, now that they are on disk.`,
    );
    return await run();
  } finally {
    release();
  }
}

/** Files that are never loaded at runtime, so they only bloat a compiled
 *  binary's VFS: source maps and docs. `.d.ts` is deliberately NOT here — the
 *  compile type-checks with them (trimming them needs the
 *  `--no-check` variant, a separate decision). A license or notice is not
 *  docs: the binary REDISTRIBUTES the package, and its terms travel with it
 *  (`LICENSE.md`, `NOTICE.md`, …). Pure over a file name. */
export function isTrimmedFile(name: string): boolean {
  return /\.(?:map|md|markdown)$/i.test(name) &&
    !/^(licen[sc]e|notice|copying|authors|patents)/i.test(name);
}

/** Directory names that hold only test fixtures (`proving_key.bin`,
 *  `test-vectors.json`, …) — WHERE {@link isTrimmedDir} allows. Pure. */
export const TRIM_DIRS: readonly string[] = ["test", "tests", "__tests__"];

/** Is `rel` a package's own directory — `…/node_modules/<pkg>` or
 *  `…/node_modules/@scope/<pkg>`? Pure. */
function isPackageRoot(rel: string): boolean {
  // aio-ok: path-split — a `.deno`-relative path this module builds with `/` (packageFiles walk)
  const s = rel.split("/");
  const n = s.length;
  return n >= 2 &&
    (s[n - 2] === "node_modules"
      ? !s[n - 1]!.startsWith("@")
      : s[n - 2]!.startsWith("@") && s[n - 3] === "node_modules");
}

/** Is the directory at `rel` (relative to `node_modules/.deno`, `/`-separated)
 *  a test-fixture directory to hold aside? The NAME alone is not evidence: a
 *  package is called `test` (`@playwright/test`), and a library keeps runtime
 *  code in `_esm/actions/test/` — held aside, the binary booted and then died
 *  `ERR_MODULE_NOT_FOUND` on first use (a field report). So: never a package
 *  root; `test`/`tests` only directly under one, where a package keeps its
 *  own suite; `__tests__` (a name nobody ships runtime code under) at any
 *  depth. Pure. */
export function isTrimmedDir(rel: string): boolean {
  // aio-ok: path-split — a `.deno`-relative path this module builds with `/` (packageFiles walk)
  const cut = rel.lastIndexOf("/");
  const name = rel.slice(cut + 1);
  if (!TRIM_DIRS.includes(name) || isPackageRoot(rel)) return false;
  return name === "__tests__" || isPackageRoot(rel.slice(0, cut));
}

/** The `node_modules/.deno`-relative paths of the modules the binary's graph
 *  loads from there: a module's `local` file, and — an npm package being ONE
 *  entry, with no file — the file an import names INSIDE one
 *  (`npm:/x@1.0.0/test/run.js`, laid over the package's `localPath`; with an
 *  `exports` map that is a key, not a file — {@link packageOwnRefs} reads the
 *  map). What a package loads from itself the graph never shows.
 *  {@link collectTrim} holds none of them aside. Pure. */
export function reachedDenoRels(
  graphs: readonly DenoInfoGraph[],
  denoDir: string,
): string[] {
  const out: string[] = [];
  for (const g of graphs) {
    for (const m of g.modules ?? []) {
      const sub = m.kind === "npm"
        ? m.specifier?.replace(/^npm:\/?(?:@[^/]+\/)?[^/]+/, "")
        : "";
      const pkg = sub && g.npmPackages?.[m.npmPackage ?? ""]?.localPath;
      const file = m.local ?? (pkg ? join(pkg, sub!) : undefined);
      if (!file) continue;
      const rel = relative(denoDir, file);
      if (!rel.startsWith("..") && !isAbsolute(rel)) {
        out.push(rel.split("\\").join("/"));
      }
    }
  }
  return out;
}

// The trim mirror MUST live OUTSIDE node_modules: deno embeds node_modules
// whole, so a mirror inside it merely relocated the maps into the binary
// (measured — the size did not move). `.aio/` beside the project is never an
// import root and never `--include`d, and sits on the same filesystem, so the
// renames stay cheap.
//
// One mirror + journal PER BUILD (`id`: the link journal's `<pid>-<nonce>`):
// two overlapping builds sharing one journal overwrote each other's list, and
// the first to finish put the other's files back mid-compile. `id` "" names
// the single pair an older aio wrote, still recovered.
type TrimPaths = { mirror: string; journal: string };
function trimPaths(nmDir: string, id: string): TrimPaths {
  const aio = join(dirname(nmDir), ".aio");
  return {
    mirror: join(aio, id ? `trim.${id}` : "trim"),
    journal: join(aio, id ? `trim-journal.${id}.json` : "trim-journal.json"),
  };
}

async function pathExists(p: string): Promise<boolean> {
  return await Deno.lstat(p).then(() => true).catch(() => false);
}

/** temp + rename: a kill mid-write leaves the previous journal whole. */
async function writeTrimJournal(
  journal: string,
  rels: readonly string[],
): Promise<void> {
  await Deno.writeTextFile(`${journal}.tmp`, JSON.stringify(rels));
  await Deno.rename(`${journal}.tmp`, journal);
}

/** `rel`'s innermost package directory — `…/node_modules/<pkg>` or
 *  `…/node_modules/@scope/<pkg>`. Pure. */
function packageDirOf(rel: string): string | null {
  // aio-ok: path-split — a `.deno`-relative path this module builds with `/` (collectTrim walk)
  const s = rel.split("/");
  const i = s.lastIndexOf("node_modules");
  const n = i + (s[i + 1]?.startsWith("@") ? 3 : 2);
  return i < 0 || s.length < n ? null : s.slice(0, n).join("/");
}

/** A relative specifier written as a literal: `require("./test/x")`,
 *  `import … from "../tests/y.js"`, `import("./__tests__/z")`, a template
 *  whose head is literal (`./test/${name}` names the directory). */
const LOCAL_SPEC_RE =
  /(?:\brequire\s*\(|\bimport\s*\(|\bfrom|\bimport)\s*["'`](\.\.?\/[^"'`\n]+)["'`]/g;

/** The `.deno`-relative paths the package at `pkg` names IN ITSELF: every
 *  literal relative specifier ({@link LOCAL_SPEC_RE}) in its own `.js` /
 *  `.cjs` / `.mjs` outside its trim directories, and every path its
 *  `package.json` `main` / `exports` / `imports` hand out. The module graph
 *  shows none of this (one entry per npm package), and a test directory held
 *  aside that the package `require`s is `Cannot find module` at that call in
 *  the user's hands — or nothing at all, where the package guards the call
 *  (measured). null: the package could not be read, so nothing is known.
 *
 *  What this cannot see is a path COMPUTED at run time (`require(dir + name)`,
 *  `fs.readFileSync(join(__dirname, "test", …))`) and a file named from
 *  ANOTHER package: `build.keepPackages` keeps such a package whole. */
async function packageOwnRefs(
  denoDir: string,
  pkg: string,
): Promise<string[] | null> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for await (const e of Deno.readDir(join(denoDir, rel))) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory) {
        if (e.name !== "node_modules" && !isTrimmedDir(child)) {
          await walk(child);
        }
      } else if (e.isFile && /\.[cm]?js$/.test(e.name)) {
        const text = await Deno.readTextFile(join(denoDir, child));
        for (const m of text.matchAll(LOCAL_SPEC_RE)) {
          out.push(posixNormalize(`${rel}/${m[1]}`));
        }
      } else if (e.isFile && child === `${pkg}/package.json`) {
        const j = JSON.parse(await Deno.readTextFile(join(denoDir, child)));
        const paths = (v: unknown): string[] =>
          typeof v === "string"
            ? [v]
            : v && typeof v === "object"
            ? Object.values(v).flatMap(paths)
            : [];
        for (const v of paths([j?.main, j?.exports, j?.imports])) {
          out.push(posixNormalize(`${pkg}/${v}`));
        }
      }
    }
  };
  try {
    await walk(pkg);
  } catch {
    return null; // aio-ok: the caller holds nothing of an unreadable package's directories aside
  }
  return out;
}

/** Every path under `denoDir` to hold aside — source maps, docs, and test
 *  fixture directories ({@link isTrimmedDir}) — relative to `denoDir`.
 *  Top-level entries named in `skipTop` (the packages already `--exclude`d,
 *  and the `build.keepPackages` ones) are not walked, and nothing in `reached`
 *  ({@link reachedDenoRels}) is taken: a module the graph loads is runtime
 *  code whatever its name. Nor is a directory its own package names
 *  ({@link packageOwnRefs}, read once per package into `own`). Symlinks are
 *  never followed. Exported for tests.
 *  @internal */
export async function collectTrim(
  dir: string,
  out: string[],
  rel = "",
  skipTop?: ReadonlySet<string>,
  reached: readonly string[] = [],
  own = new Map<string, Promise<string[] | null>>(),
  denoDir = dir,
): Promise<string[]> {
  const named = async (childRel: string): Promise<boolean> => {
    const pkg = packageDirOf(childRel);
    if (!pkg) return false;
    if (!own.has(pkg)) own.set(pkg, packageOwnRefs(denoDir, pkg));
    const refs = await own.get(pkg)!;
    return !refs ||
      refs.some((r) => r === childRel || r.startsWith(`${childRel}/`));
  };
  try {
    // `Deno.readDir` is lazy: a missing/unreadable dir throws on the FIRST
    // `for await` step, not at the call — so the try must wrap the loop.
    for await (const e of Deno.readDir(dir)) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (rel === "" && skipTop?.has(e.name)) continue;
        if (
          isTrimmedDir(childRel) &&
          !reached.some((r) =>
            r === childRel || r.startsWith(`${childRel}/`)
          ) &&
          !(await named(childRel))
        ) {
          out.push(childRel);
          continue;
        }
        await collectTrim(
          join(dir, e.name),
          out,
          childRel,
          skipTop,
          reached,
          own,
          denoDir,
        );
      } else if (
        e.isFile && isTrimmedFile(e.name) && !reached.includes(childRel)
      ) {
        out.push(childRel);
      }
    }
  } catch {
    // aio-ok: a vanished or unreadable dir contributes nothing to trim; the
    // compile proceeds, only without trimming that subtree.
  }
  return out;
}

/** Move `rels` (relative to `denoDir`) into this build's mirror beside
 *  node_modules, writing the journal FIRST so a killed build can restore
 *  them. Returns how many were really moved. */
async function holdAsideTrim(
  t: TrimPaths,
  denoDir: string,
  rels: readonly string[],
  /** True once the build is being interrupted: move nothing more. */
  stop: () => boolean,
): Promise<number> {
  if (!rels.length || stop()) return 0;
  try {
    await Deno.mkdir(t.mirror, { recursive: true });
    await writeTrimJournal(t.journal, rels);
  } catch (e) {
    // The trim is an optimization: with no journal nothing may move (a killed
    // build could not put it back), so the build goes on untrimmed.
    console.warn(
      `${HEY} could not write the trim journal ${t.journal} (${e}) — ` +
        `source maps, docs and test fixtures stay in the binary`,
    );
    return 0;
  }
  let moved = 0;
  for (const rel of rels) {
    if (stop()) break;
    try {
      const to = join(t.mirror, rel);
      await Deno.mkdir(dirname(to), { recursive: true });
      await Deno.rename(join(denoDir, rel), to);
      moved++;
    } catch (e) {
      // A file that cannot be moved stays in the binary rather than failing
      // the build. `restoreTrim` skips a mirror entry that was never created.
      if ((e as { code?: string }).code === "EXDEV") {
        // Another filesystem (a mounted / linked node_modules): every later
        // rename fails the same way — say it once and stop.
        console.warn(
          `${HEY} ${t.mirror} is on another filesystem than ${denoDir} — ` +
            `source maps, docs and test fixtures stay in the binary`,
        );
        break;
      }
      console.warn(
        `${HEY} could not hold ${rel} aside (${e}) — it stays in the binary`,
      );
    }
  }
  return moved;
}

/** Move `from` (in a trim mirror) back to `to`. A destination that already
 *  exists was re-created while the file was aside (`node_modules` reinstalled
 *  after a killed build): a directory takes only the children it lacks, and a
 *  file there already is the package's own — the mirror copy is dropped.
 *  Throws when it cannot (the caller keeps the mirror copy). */
async function putBack(from: string, to: string): Promise<void> {
  const dest = await Deno.lstat(to).catch(() => null);
  if (!dest) return await Deno.rename(from, to);
  if ((await Deno.lstat(from)).isDirectory) {
    if (!dest.isDirectory) throw new Error(`${to} is no longer a directory`);
    for await (const e of Deno.readDir(from)) {
      await putBack(join(from, e.name), join(to, e.name));
    }
  }
  await Deno.remove(from); // a file the tree has again, or a dir now empty
}

/** Remove `dir` and the directories under it — only while they hold no file.
 *  Never recursive: whatever is still in a mirror is somebody's only copy. */
async function removeEmptyDirs(dir: string): Promise<void> {
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) await removeEmptyDirs(join(dir, e.name));
    }
    await Deno.remove(dir);
  } catch {
    // aio-ok: not empty (kept on purpose) or already gone
  }
}

/** Put back everything a trim journal lists — this build's on the normal
 *  path, a dead build's from {@link recoverInterruptedLinks}. Idempotent, and
 *  never throws. What could not go back stays in the mirror AND in the
 *  journal, so the next build retries exactly that. */
async function restoreTrim(t: TrimPaths, denoDir: string): Promise<void> {
  let rels: unknown;
  try {
    rels = JSON.parse(await Deno.readTextFile(t.journal));
  } catch {
    return; // aio-ok: no (readable) journal means no trim window is open
  }
  // A journal that is not the array we wrote lists nothing to restore.
  const left: string[] = [];
  let why: unknown;
  for (const rel of Array.isArray(rels) ? rels as string[] : []) {
    const from = join(t.mirror, rel);
    if (!(await pathExists(from))) continue; // never moved, or already back
    const to = join(denoDir, rel);
    try {
      await Deno.mkdir(dirname(to), { recursive: true });
      await putBack(from, to);
    } catch (e) {
      left.push(rel);
      why ??= e;
    }
  }
  try {
    if (left.length) {
      await writeTrimJournal(t.journal, left);
      console.warn(
        `${HEY} could not put back ${left.length} path(s) the build held ` +
          `aside (${left[0]}: ${why}) — kept under ${t.mirror}, retried by ` +
          `the next build. If it repeats: remove node_modules, run \`deno ` +
          `install\`, and build again (that clears it).`,
      );
      return;
    }
    await removeEmptyDirs(t.mirror);
    await Deno.remove(t.journal);
  } catch (e) {
    console.warn(`${HEY} could not close the trim journal ${t.journal}: ${e}`);
  }
}

/** Restore the trim mirrors builds that DIED left open (the caller has
 *  established no live build holds the lock). A live build's own `finally`
 *  restores its own, as with the link journals. */
async function recoverTrim(nmDir: string): Promise<void> {
  const aio = join(dirname(nmDir), ".aio");
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(aio)) names.push(e.name);
  } catch {
    return; // aio-ok: no .aio — nothing was held aside
  }
  for (const name of names) {
    const m = TRIM_JOURNAL_RE.exec(name);
    if (!m) continue;
    const path = join(aio, name);
    const owner = m[2] ? withTag(Number(m[2]), m[3]!.slice(8)) : null;
    if (journalOwnerAlive(path, name.replace(/\.tmp$/, ""), owner)) continue;
    if (name.endsWith(".tmp")) {
      // Killed before its rename: the journal it would have replaced lists
      // everything that moved (the moves follow the rename). A FIRST journal
      // killed there leaves the mirror it was about to fill — empty, so it
      // goes too (a mirror holding a file is never removed).
      await Deno.remove(path).catch(() => {
        // aio-ok: a concurrent recovery removed it
      });
      await removeEmptyDirs(trimPaths(nmDir, m[1] ?? "").mirror);
      continue;
    }
    await restoreTrim(trimPaths(nmDir, m[1] ?? ""), join(nmDir, ".deno"));
  }
}

/** Which `.deno` entries stay OUT of the binary. Pure over the on-disk edge
 *  map (`nmGraph`), the top-level links split into dev-only and real roots,
 *  the `build.keepPackages` names, and — when the build read them — the
 *  `deno info` graphs (`null`: asked for and unreadable). `unmapped` is the
 *  one case the caller must say out loud: the graphs could not be laid over
 *  node_modules, so every reachable-or-not package is embedded. */
export function excludedEntries(o: {
  nmGraph: Map<string, Set<string>>;
  devRoots: readonly string[];
  keepRoots: readonly string[];
  keep: ReadonlySet<string>;
  graphs?: readonly DenoInfoGraph[] | null;
  /** Leave the packages no root reaches IN (see `withDevExcluded`'s `graph`). */
  keepUnreached?: boolean;
  /** Entries whose own metadata says they are for another system than the
   *  target ({@link foreignEntries}). */
  foreign?: ReadonlySet<string>;
}): { excluded: Set<string>; unmapped: boolean; needed: Set<string> } {
  const { nmGraph, keep, graphs } = o;
  const buildOnly = (pkg: string | null) => !!pkg && devOnlyPackageByName(pkg);
  const excluded = new Set(devOnlyClosure(nmGraph, o.devRoots, o.keepRoots));
  // Dev-only packages reached only as PEER/transitive deps have no top-level
  // symlink, so `devOnlyClosure` (which keys off the tree) misses them — a real
  // app shipped `tsc`/`tsc.exe` because `typescript` was only a peer of a
  // real dependency (a field report). Drop them by NAME from the on-disk
  // graph, `@typescript/*` platform packages included.
  for (const e of nmGraph.keys()) {
    if (buildOnly(denoNmPackageName(e))) excluded.add(e);
  }
  const unreached = graphs && !o.keepUnreached
    ? unreachableNpmEntries(graphs, new Set(nmGraph.keys()))
    : null;
  for (const e of unreached ?? []) excluded.add(e);
  // §6 — a dev-only package deno NAMES in the graph but has not linked to
  // disk yet. A cross target's platform binary (`@typescript/typescript-
  // darwin-arm64`, `@esbuild/*`) is linked DURING the compile, after an
  // exclude list built from the tree on disk was already made, so it slipped
  // through per cross target. `localPath` names the directory even when it is
  // absent, so the exclude arrives before the name does. Runs even when the
  // reachability map bailed, because this is a name rule, not a graph one.
  for (const g of graphs ?? []) {
    for (const [id, p] of Object.entries(g.npmPackages ?? {})) {
      if (buildOnly(packageNameOfNpmId(id))) {
        excluded.add(denoEntryNameOf(id, p.localPath));
      }
    }
  }
  // build.keepPackages wins — applied HERE, once, over everything gathered
  // above, so a rule added there cannot forget it (the dev-only walk did: a
  // named package that only a dev-only one links to was left out, silently).
  // The app asked for the package by name; the graph may not show a
  // runtime-only load (`import(path)`, a subprocess, a `.d.ts` read). And it
  // asked for a package that RUNS: every package its on-disk links lead to
  // (dependencies, peers, the optional ones deno installed), all the way
  // down — `tsx` kept without its `get-tsconfig` cannot load. A build tool
  // on the way stays out unless named too, as everywhere (and is warned
  // about — `droppedDependencies`); what only IT needs goes with it. So
  // does a `@types/*` package: nothing loads one at run time.
  const kept = (e: string) => {
    const pkg = denoNmPackageName(e);
    return !!pkg && keptByFamily(pkg, keep);
  };
  const needed = new Set<string>();
  const queue = [...nmGraph.keys()].filter(kept);
  while (queue.length) {
    const e = queue.pop()!;
    if (needed.has(e)) continue;
    const pkg = denoNmPackageName(e);
    if (!kept(e) && (buildOnly(pkg) || pkg?.startsWith("@types/"))) continue;
    needed.add(e);
    queue.push(...nmGraph.get(e) ?? []);
  }
  for (const e of [...excluded]) {
    if (kept(e) || needed.has(e)) excluded.delete(e);
  }
  // Another system's native package cannot run in this binary, whoever needs
  // it: `esbuild` kept on a Windows build needs `@esbuild/win32-x64`, and the
  // host's `@esbuild/linux-x64` beside it is 10 MB of nothing. So this rule
  // comes AFTER the keep — and yields only to the package's own exact name,
  // which is the app saying it wants that file whatever it is for.
  for (const e of o.foreign ?? []) {
    if (!keep.has(denoNmPackageName(e) ?? "")) excluded.add(e);
  }
  return {
    excluded,
    unmapped: graphs !== undefined && !unreached && !o.keepUnreached,
    needed,
  };
}

/** The `.deno` entries whose package does not install on `sys`, by its own
 *  `package.json` ({@link runsOn}). An entry with no readable `package.json`
 *  states nothing and is left alone. */
export async function foreignEntries(
  denoDir: string,
  entries: Iterable<string>,
  sys: NpmSystem,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const e of entries) {
    const pkg = denoNmPackageName(e);
    if (!pkg) continue;
    try {
      const json = JSON.parse(
        await Deno.readTextFile(
          join(denoDir, e, "node_modules", pkg, "package.json"),
        ),
      );
      if (!runsOn(json, sys)) out.add(e);
    } catch {
      // aio-ok: no readable package.json — nothing says it is another system's
    }
  }
  return out;
}

/** The lock flags for a `deno install` that must not write the project's
 *  lock: `--lock=<a copy in dir>`, so what it resolves is still checked
 *  against the project's pins and anything it would add lands in the copy.
 *  `"lock": false` in the config stays "no lock". Pure but for the copy. */
export async function installLockArgs(
  root: string,
  dir: string,
): Promise<string[]> {
  const cfg = await readDenoJson(root);
  const lock = cfg?.config.lock;
  if (lock === false) return ["--no-lock"];
  const declared = typeof lock === "string"
    ? lock
    : (lock as { path?: unknown } | undefined)?.path;
  const copy = join(dir, "deno.lock");
  try {
    await Deno.copyFile(
      resolve(root, typeof declared === "string" ? declared : "deno.lock"),
      copy,
    );
  } catch (e) {
    // No lock yet: deno starts one — in the copy's place, not the project's.
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return [`--lock=${copy}`];
}

/** Install the packages `roots` need on `sys` into the project's
 *  `node_modules`. The failure (deno's own first error line), or null.
 *
 *  ADDS, never removes: with `--entrypoint`, deno installs what those modules
 *  reach for that system and leaves every other package where it is — what
 *  `deno compile --target` does by itself, only earlier. So the host's
 *  packages are there at every moment of the build, however it ends, and
 *  nothing has to be put back. A plain `deno install --os …` is the opposite
 *  on both counts: it removes the host's packages, and it resolves every
 *  dependency the config declares (the framework's own included) into the
 *  project's lock. The lock is a copy: this cannot write the project's. */
async function installFor(
  root: string,
  sys: NpmSystem,
  roots: readonly string[],
): Promise<string | null> {
  const tmp = await Deno.makeTempDir({ prefix: "aio-target-install-" });
  try {
    const r = await new Deno.Command("deno", {
      args: [
        "install",
        "--entrypoint",
        ...roots,
        "--os",
        sys.os,
        "--arch",
        sys.cpu,
        ...await installLockArgs(root, tmp),
      ],
      cwd: root,
      stdout: "null",
      stderr: "piped",
      // Its words are quoted in one line of ours.
      env: { NO_COLOR: "1" },
    }).output();
    if (r.success) return null;
    // deno's error, and under it the cause chain: the last line is the root.
    const lines = new TextDecoder().decode(r.stderr).trim().split("\n")
      .map((l) => l.trim());
    const at = lines.findIndex((l) => /^error\b/i.test(l));
    const cause = lines.at(-1)?.replace(/^\d+:\s*/, "");
    if (at < 0) return cause || `exit ${r.code}`;
    return lines[at] + (at < lines.length - 1 ? ` (${cause})` : "");
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {
      // aio-ok: a temp dir of one lock copy; the OS sweeps what is left
    });
  }
}

/** The scope directories (`…/@scope`, `.deno`-relative) in which EVERY entry
 *  on disk is in `left` — to be excluded themselves. Each entry left out
 *  alone, the compile still embedded the directory they were in: an empty
 *  `node_modules/@esbuild/` in every binary whose esbuild packages were all
 *  left out. A scope with one entry that stays is not touched. */
export async function emptiedScopeDirs(
  denoDir: string,
  left: readonly string[],
): Promise<string[]> {
  const out = new Set(left);
  const scopes = new Set(
    // aio-ok: path-split — `.deno` entries spelled with `/` by this module (lateLinkExcludes)
    left.map((e) => e.slice(0, e.lastIndexOf("/")))
      // aio-ok: path-split — `.deno` entries spelled with `/` by this module
      .filter((d) => d.slice(d.lastIndexOf("/") + 1).startsWith("@")),
  );
  const emptied: string[] = [];
  for (const scope of [...scopes].sort()) {
    try {
      const names = [];
      for await (const e of Deno.readDir(join(denoDir, scope))) {
        names.push(e.name);
      }
      if (names.every((n) => out.has(`${scope}/${n}`))) emptied.push(scope);
    } catch (e) {
      // Not on disk: nothing of it is embedded unless the compile adds it,
      // and what it adds there is not known to be left out.
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  return emptied;
}

/** A KEPT package's own link to an excluded one (`.deno`-relative,
 *  `<dependent>/node_modules/<pkg>`), to be `--exclude`d like the flat link
 *  ({@link lateLinkExcludes}) and for the same reason: held aside, it is
 *  written again by any `deno` call that installs for the system the excluded
 *  package belongs to, and then followed.
 *
 *  With `onDisk` (the entries installed right now), a link to an entry that
 *  is NOT there goes too: `deno install` removes another system's package
 *  and leaves the links to it, and each dangling one was embedded — a
 *  Windows exe listed `crc32-darwin-x64` after a macOS build. Pure. */
export function siblingLinkExcludes(
  excluded: ReadonlySet<string>,
  nmGraph: ReadonlyMap<string, ReadonlySet<string>>,
  onDisk?: ReadonlySet<string>,
): string[] {
  return [...nmGraph].flatMap(([entry, deps]) =>
    excluded.has(entry) ? [] : [...deps].flatMap((d) => {
      const pkg = (excluded.has(d) || onDisk?.has(d) === false) &&
        denoNmPackageName(d);
      return pkg ? [`${entry}/node_modules/${pkg}`] : [];
    })
  ).sort();
}

/** The flat-fallback links (`.deno`-relative, `node_modules/<pkg>`) deno
 *  writes DURING the compile for the excluded packages — to be `--exclude`d
 *  themselves.
 *
 *  A cross target's platform package (`@esbuild/win32-x64` on a Linux host)
 *  is linked by `deno compile` itself, after the hold-aside pass: its
 *  directory is excluded ahead of time, but deno then links it into
 *  `.deno/node_modules/`, FOLLOWS that link and embeds the package anyway
 *  (10 MB of esbuild.exe in every Windows build made on Linux). The link's own
 *  path, excluded, is not followed. On disk or not makes no difference: the
 *  first cross build leaves the package installed, and the next one's compile
 *  writes the held-aside link again — so every excluded entry is named, not
 *  only the absent ones. Skipped when a KEPT version of the same package is
 *  installed: the link may be that one's. Pure. */
export function lateLinkExcludes(
  excluded: ReadonlySet<string>,
  nmGraph: ReadonlyMap<string, unknown>,
): string[] {
  const kept = new Set(
    [...nmGraph.keys()].filter((e) => !excluded.has(e)).map(denoNmPackageName),
  );
  return [
    ...new Set([...excluded].flatMap((e) => {
      const pkg = denoNmPackageName(e);
      return pkg && !kept.has(pkg) ? [`node_modules/${pkg}`] : [];
    })),
  ].sort();
}

/** The `.deno` entry names of the npm packages the graphs reach. Pure. */
function reachedDenoEntries(graphs: readonly DenoInfoGraph[]): Set<string> {
  const paths = new Map<string, string | undefined>();
  for (const g of graphs) {
    for (const [id, p] of Object.entries(g.npmPackages ?? {})) {
      paths.set(id, p.localPath);
    }
  }
  return new Set(
    [...reachedNpmPackages(graphs)].map((id) =>
      denoEntryNameOf(id, paths.get(id))
    ),
  );
}

type Dropped = Map<string, { hard: string[]; peer: string[] }>;

/** The dropped-by-name packages a KEPT package needs: dropped package → the
 *  packages that list it under `dependencies` (`hard`) or as a required peer
 *  (`peer`). An optional peer / optional dependency is not evidence of a
 *  runtime load. With `reached` (the entries the binary's graph reaches), a
 *  dependent outside it is not asked: a `cli` build embeds packages the
 *  binary never loads, and what THEY need is nobody's problem. The caller
 *  counts a `build.keepPackages` package and what it needs as reached: that
 *  is the app saying it loads the package where the graph cannot see.
 *  Exported for tests. @internal */
export async function droppedDependencies(
  denoDir: string,
  nmGraph: Map<string, Set<string>>,
  excluded: ReadonlySet<string>,
  reached?: ReadonlySet<string>,
): Promise<Dropped> {
  const out: Dropped = new Map();
  for (const [entry, deps] of [...nmGraph].sort()) {
    if (excluded.has(entry) || (reached && !reached.has(entry))) continue;
    const dropped = [...deps].map((d) =>
      excluded.has(d) && denoNmPackageName(d)
    )
      .filter((p): p is string => !!p && devOnlyPackageByName(p));
    if (!dropped.length) continue;
    const by = denoNmPackageName(entry)!;
    let pj: {
      dependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    try {
      pj = JSON.parse(
        await Deno.readTextFile(
          join(denoDir, entry, "node_modules", by, "package.json"),
        ),
      );
    } catch {
      continue; // aio-ok: no readable package.json — nothing declared
    }
    for (const d of dropped) {
      const kind = Object.hasOwn(pj.dependencies ?? {}, d)
        ? "hard"
        : Object.hasOwn(pj.peerDependencies ?? {}, d) &&
            !pj.peerDependenciesMeta?.[d]?.optional
        ? "peer"
        : null;
      if (!kind) continue;
      if (!out.has(d)) out.set(d, { hard: [], peer: [] });
      out.get(d)![kind].push(by);
    }
  }
  return out;
}

/** What the build says about the build-only packages it leaves out — one
 *  warning per package, each with the `build.keepPackages` line that keeps
 *  it. A dev-only package the binary DOES reach is dropped anyway (that is
 *  the size win), and a load of it at runtime then fails inside the shipped
 *  binary: said here, with the fix, instead of surfacing as a crash on a
 *  user's machine. Pure. */
export function droppedWarnings(o: {
  graphs?: readonly DenoInfoGraph[] | null;
  devRoots: readonly string[];
  keep: ReadonlySet<string>;
  dropped: Dropped;
  /** aio's own build modules — see {@link reachedOutsideBuildTooling}. */
  buildDirHref: string;
}): string[] {
  const out: string[] = [];
  const warned = new Set<string>();
  const keepLine = (pkg: string) =>
    `deno.json "build": { "keepPackages": ["${pkg}"] }`;
  if (o.graphs) {
    const reached = reachedNpmPackages(o.graphs);
    for (const entry of o.devRoots) {
      const pkg = denoNmPackageName(entry);
      if (!pkg || o.keep.has(pkg) || !reached.has(entry)) continue;
      if (!reachedOutsideBuildTooling(o.graphs, pkg, o.buildDirHref)) continue;
      warned.add(pkg);
      out.push(
        `${HEY} ${pkg} is reachable from the binary's graph but aio leaves ` +
          `it out of the artifact (it is build-only by default) — if the ` +
          `app loads it at runtime, add it to ${keepLine(pkg)} and rebuild.`,
      );
    }
  }
  // The same word for a package the APP never names: one a kept dependency
  // needs. It has no top-level link and no import in the app's own modules,
  // so the loop above cannot see it — only the dependent's package.json can.
  for (const [pkg, by] of o.dropped) {
    if (warned.has(pkg)) continue;
    if (by.hard.length) {
      out.push(
        `${HEY} ${by.hard.join(", ")} depend${by.hard.length > 1 ? "" : "s"} ` +
          `on ${pkg}, which aio leaves out of the artifact (it is ` +
          `build-only by default) — if the app runs code that loads it, add ` +
          `it to ${keepLine(pkg)} and rebuild.`,
      );
    } else {
      // A required peer is usually wanted for its types only — but the build
      // cannot tell, and a library that loads it dies at first use.
      out.push(
        `${HEY} ${pkg} is a required peer of ${by.peer.join(", ")}, and aio ` +
          `leaves it out of the artifact (it is build-only by default). ` +
          `Nothing to do if ${by.peer.join(", ")} only read${
            by.peer.length > 1 ? "" : "s"
          } its types; if ${pkg} is loaded at runtime, that fails in the ` +
          `binary at first use — add it to ${keepLine(pkg)} and rebuild.`,
      );
    }
  }
  return out;
}

async function _withDevExcluded(
  nmDir: string,
  fn: (excludes: string[]) => Promise<boolean>,
  graphRoots?: {
    cwd: string;
    roots: readonly string[];
    keepUnreached?: boolean;
    installRoots?: readonly string[];
  },
  keepPackages: readonly string[] = [],
  /** Release the build lock — for the one exit that skips the caller's
   *  `finally` (a signal). */
  release: () => void = () => {},
  platform: string = hostPlatform(),
  /** Filled with every `.deno` entry the exclude list was decided over. */
  seen?: Set<string>,
): Promise<boolean> {
  // A killed build may have left links aside and its trim mirror open; put
  // both back first.
  await recoverInterruptedLinks(nmDir);
  const journal = _linkJournal(nmDir);
  const trim = trimPaths(nmDir, journal.id);

  const denoDir = join(nmDir, ".deno");

  // Which `.deno` entries only a dev-only package can reach. The ROOTS are the
  // project's own direct dependencies — the top-level `node_modules/<pkg>`
  // symlinks deno writes for the import map — split into dev-only and real.
  // Reading the roots from the tree (rather than assuming DEV_ONLY_PACKAGES is
  // the whole story) is what makes the walk safe for an app whose own deps
  // happen to share a package with electron or happy-dom.
  let graph = await readDenoNmGraph(denoDir);
  // Native packages are per system, and what is on disk is the HOST's — plus
  // whatever earlier builds for other platforms left. Which of them are not
  // the target's is read from each package's own metadata.
  const sys = npmSystemOf(PLATFORMS[platform] ?? PLATFORMS[hostPlatform()]!);
  // A cross build: the TARGET's packages are installed now, so the exclude
  // list and the trim below see them like any other. Left to the compile,
  // they arrived after both — a first build shipped their docs and maps, and
  // only a later one, finding them on disk, did not.
  if (
    platform !== hostPlatform() && graph.size > 0 && graphRoots?.roots.length
  ) {
    const failed = await installFor(
      graphRoots.cwd,
      sys,
      graphRoots.installRoots ?? graphRoots.roots,
    );
    if (failed) {
      // The build stops here: a binary compiled without them would be the
      // target's app with another system's native code, or none.
      console.error(
        `${NO} the ${platform} build needs that platform's npm packages, ` +
          `and they could not be installed: ${failed}\n` +
          `       Nothing was built, and node_modules still holds everything ` +
          `it held. deno fetches a package once and keeps it — build again ` +
          `with the network up.`,
      );
      return false;
    }
    graph = await readDenoNmGraph(denoDir);
  }
  const foreign = await foreignEntries(denoDir, graph.keys(), sys);
  // What is installed: a kept package's link to an entry that is not there
  // (a tree pruned for one system by hand) is excluded too.
  const onDisk = new Set(graph.keys());
  if (seen) { for (const e of onDisk) seen.add(e); }
  const keep = new Set(keepPackages);
  const devRoots: string[] = [];
  const keepRoots: string[] = [];
  for (const link of await _linksIn(nmDir)) {
    const entry = await _denoEntryOf(denoDir, link);
    if (!entry) continue;
    const pkg = denoNmPackageName(entry)!;
    (DEV_ONLY_PACKAGES.includes(pkg) && !keep.has(pkg) ? devRoots : keepRoots)
      .push(entry);
  }
  const graphs = graphRoots &&
    await denoInfoGraphs(graphRoots.cwd, graphRoots.roots);
  const { excluded, unmapped, needed } = excludedEntries({
    nmGraph: graph,
    devRoots,
    keepRoots,
    keep,
    graphs,
    keepUnreached: graphRoots?.keepUnreached,
    foreign,
  });
  // A name nothing answers to keeps nothing — a typo, said. Only where there
  // is a tree to look in: with no `.deno` nothing is left out either.
  const installed = new Set([
    ...[...graph.keys()].map(denoNmPackageName),
    ...(graphs ?? []).flatMap((g) =>
      Object.keys(g.npmPackages ?? {}).map(packageNameOfNpmId)
    ),
  ]);
  for (const name of graph.size ? keep : []) {
    if (installed.has(name)) continue;
    console.warn(
      `${HEY} deno.json build.keepPackages names "${name}", and no ` +
        `installed npm package has that name — nothing is kept for it ` +
        `(check the spelling).`,
    );
  }
  if (unmapped) {
    console.warn(
      `${HEY} could not map the binary's npm graph onto node_modules — ` +
        `embedding every package (the binary is larger, not broken)`,
    );
  }
  const warnings = droppedWarnings({
    graphs,
    devRoots,
    keep,
    dropped: await droppedDependencies(
      denoDir,
      graph,
      excluded,
      // An unmapped graph cannot say which entries it reaches.
      graphs && !unmapped
        ? new Set([...reachedDenoEntries(graphs), ...needed])
        : undefined,
    ),
    buildDirHref: new URL("./", import.meta.url).href,
  });
  for (const w of warnings) console.warn(w);
  // A cross-built binary is never run here, so this is the only place its
  // missing import can be said before a user's machine says it.
  for (const f of importedForeign(graphs ?? [], foreign, keep)) {
    console.warn(
      `${HEY} the app imports ${f.pkg}, which is built for another system ` +
        `than ${platform} — it is left out of this binary, and ` +
        (f.static
          ? `the import is static: the binary will fail to load the module ` +
            `that names it.`
          : `the binary fails where it imports it.`) +
        ` Import it only on the system it runs on (a dynamic import behind ` +
        `a check of Deno.build.os).`,
    );
  }
  // §5 — aio's own tool cache under node_modules is not app content, and deno
  // embeds it whole: a stale bare `appimagetool` (14 MB) shipped because it sat
  // in `node_modules/.cache` (a field report). Exclude the cache dir, and
  // remove the legacy bare-name copy aio cached before it moved under the
  // per-user cache.
  const extraExcludes: string[] = [];
  const toolCache = join(nmDir, ".cache");
  if (await pathExists(toolCache)) {
    extraExcludes.push(toolCache);
    await Deno.remove(join(toolCache, "appimagetool")).catch(() => {
      // aio-ok: the legacy file is aio's own stale artifact; absent is fine.
    });
  }
  // The build's own bookkeeping sits in node_modules for the compile window,
  // and deno embedded it in every binary: the lock, its stamp, this build's
  // link journal.
  const lock = join(nmDir, ".aio-build-lock");
  extraExcludes.push(lock, `${lock}.id`, journal.path);
  // deno's own install state. A binary never reads it, and `.bin` is how the
  // excluded packages' launch scripts got back in: the compile writes those
  // links again and follows them (see INSTALL_BIN_DIR in artifact-audit.ts).
  extraExcludes.push(
    join(dirname(nmDir), INSTALL_BIN_DIR),
    ...INSTALL_STATE_FILES.map((f) => join(denoDir, f)),
  );
  const left = [
    ...excluded,
    ...lateLinkExcludes(excluded, graph),
    ...siblingLinkExcludes(excluded, graph, onDisk),
  ];
  const excludes = [...left, ...await emptiedScopeDirs(denoDir, left)]
    .map((e) => join(denoDir, e)).concat(extraExcludes);

  const saved: SavedLink[] = [];
  // A signal arrived: hold nothing more aside (see `holding` below).
  let closing = false;
  // Journal paths are node_modules-relative (a project moved after a killed
  // build is still repaired). The file is THIS build's alone: a build that
  // took the lock over after the wait runs beside a live holder, and a shared
  // file's read-modify-write lost whichever entries the other wrote between.
  const _journal = () => journal.write(saved);
  async function _rm(path: string): Promise<void> {
    if (closing) return;
    try {
      const t = journalTarget(nmDir, path, await Deno.readLink(path));
      saved.push({ path: relative(nmDir, path), target: t, isDir: false });
      await _journal();
      await Deno.remove(path);
    } catch { /* symlink missing */ }
  }
  async function _rmDir(path: string): Promise<void> {
    if (closing) return;
    try {
      const inner: Array<{ name: string; target: string }> = [];
      for await (const e of Deno.readDir(path)) {
        try {
          inner.push({
            name: e.name,
            target: journalTarget(
              nmDir,
              join(path, e.name),
              await Deno.readLink(join(path, e.name)),
            ),
          });
        } catch { /* not a symlink */ }
      }
      saved.push({
        path: relative(nmDir, path),
        target: JSON.stringify(inner),
        isDir: true,
      });
      await _journal();
      await Deno.remove(path, { recursive: true });
    } catch { /* dir missing */ }
  }

  // Everything this build moved, put back — ONCE, whoever asks first (the
  // `finally` below, or a signal). Each step stands alone: a trim restore that
  // throws must not cost the project its `node_modules/<pkg>` links.
  let stopFresh: (() => void) | undefined;
  let restoring: Promise<void> | undefined;
  const restore = () =>
    restoring ??= (async () => {
      stopFresh?.();
      for (
        const step of [
          () => restoreTrim(trim, denoDir),
          () => restoreLinks(nmDir, saved),
          () => journal.remove(),
        ]
      ) {
        try {
          await step();
        } catch (e) {
          console.warn(`${HEY} build cleanup step failed: ${e}`);
        }
      }
      liveJournals.delete(basename(trim.journal));
    })();
  // Ctrl-C / a CI timeout's SIGTERM used to kill the build with the tree still
  // trimmed and unlinked until the NEXT compile (`deno task dev` in between
  // ran on a tree with files missing). Put it back, then go — but only once
  // the hold-aside pass (`holding`) has stopped: a restore running beside it
  // would put a link back and then watch the pass remove it.
  let holding: Promise<void> = Promise.resolve();
  const signals = ([["SIGINT", 130], ["SIGTERM", 143]] as const).flatMap(
    ([sig, code]) => {
      const on = () => {
        closing = true;
        holding.catch(() => {
          // aio-ok: the trim's own failure is reported by its caller; the restore runs either way
        }).then(restore).finally(() => {
          release();
          Deno.exit(code);
        });
      };
      try {
        Deno.addSignalListener(sig, on);
        return [{ sig, on }];
      } catch {
        return []; // aio-ok: a signal this platform cannot listen for (Windows SIGTERM)
      }
    },
  );

  const holdAside = async (): Promise<void> => {
    // `--exclude` prunes a directory, but deno FOLLOWS a symlink that points
    // into it and re-embeds the target anyway — that is why `.bin/electron`
    // and `.bin/esbuild` alone kept dragging their packages back in. So every
    // link into an excluded dir is held aside for the duration of the compile:
    // the project's own `node_modules/<pkg>`, the flat `.deno/node_modules`
    // fallback, `.bin/*` — and each KEPT package's own
    // `.deno/<dependent>/node_modules/<pkg>` sibling link, the one a peer
    // dependency leaves: through it deno re-embedded the whole compiler while
    // the build reported it excluded (a field report). Restored in `finally`,
    // whatever happens.
    const dependents = [...graph].flatMap(([entry, deps]) =>
      !excluded.has(entry) && [...deps].some((d) => excluded.has(d))
        ? [join(denoDir, entry, "node_modules")]
        : []
    );
    for (
      const dir of [
        nmDir,
        join(denoDir, "node_modules"),
        join(nmDir, ".bin"),
        ...dependents,
      ]
    ) {
      for (const link of await _linksIn(dir)) {
        const entry = await _denoEntryOf(denoDir, link);
        if (entry && excluded.has(entry)) await _rm(link);
      }
    }
    // Scope dirs left empty by the pass above (`@electron/`, `@esbuild/`) are
    // removed whole so the VFS carries no empty husks.
    for (const dir of [nmDir, join(denoDir, "node_modules")]) {
      try {
        for await (const e of Deno.readDir(dir)) {
          if (!e.isDirectory || !e.name.startsWith("@")) continue;
          const scope = join(dir, e.name);
          let empty = true;
          for await (const _ of Deno.readDir(scope)) empty = false;
          if (empty) await _rmDir(scope); // saved, so `finally` puts it back
        }
      } catch { /* dir gone */ }
    }

    console.log(
      `excluding ${excluded.size} dev dirs, removed ${saved.length} symlinks`,
    );

    // §4 — hold aside source maps, docs and test fixtures for the compile
    // window. They are 124+ MB of the payload and no runtime path reads them;
    // `--exclude` cannot take thousands of individual files (argv limits), so
    // they are moved out and put back in `finally` (crash-recovered by the
    // journal written before the first move). Not walked: the excluded
    // packages (already out), and the `build.keepPackages` ones — the app
    // asked for those whole.
    if (Deno.env.get("AIO_SKIP_TRIM") !== "1") {
      const skipTop = new Set(excluded);
      for (const e of graph.keys()) {
        const pkg = denoNmPackageName(e);
        if (pkg && keptByFamily(pkg, keep)) skipTop.add(e);
      }
      const trimRels = await collectTrim(
        denoDir,
        [],
        "",
        skipTop,
        // real to real: `deno info` reports resolved paths
        reachedDenoRels(
          graphs ?? [],
          await Deno.realPath(denoDir).catch(() => denoDir),
        ),
      );
      liveJournals.add(basename(trim.journal));
      const moved = await holdAsideTrim(
        trim,
        denoDir,
        trimRels,
        () => closing,
      );
      // Heartbeat, as the link journal's: another pid namespace judges this
      // journal by its mtime.
      stopFresh = keepFresh(trim.journal);
      if (moved) console.log(`held aside ${moved} non-runtime file(s)/dir(s)`);
    }
  };

  let ok = false;
  try {
    // AIO-226: removal inside try so finally always restores on error.
    holding = holdAside();
    await holding;
    if (!closing) ok = await fn(excludes);
  } finally {
    await restore();
    for (const { sig, on } of signals) Deno.removeSignalListener(sig, on);
    if (saved.length) console.log(`restored ${saved.length} symlinks`);
  }
  return ok;
}

/** The journal names THIS process holds right now (see pid-lock.ts: our own
 *  pid on one is otherwise a previous run's). */
const liveJournals = new Set<string>();

/** This build's own journal file. Exported for tests. @internal */
export function _linkJournal(nmDir: string): {
  /** `<pid>-<nonce8><tag>` — this build's trim mirror + journal carry it too. */
  id: string;
  path: string;
  write: (saved: readonly SavedLink[]) => Promise<void>;
  remove: () => Promise<void>;
} {
  const id = `${Deno.pid}-${crypto.randomUUID().slice(0, 8)}${ownIdTail()}`;
  const name = `.aio-build-links.${id}.json`;
  const path = join(nmDir, name);
  liveJournals.add(name);
  // Heartbeat: another pid namespace judges this journal by its mtime.
  let stop: (() => void) | undefined;
  return {
    id,
    path,
    // temp + rename: a kill mid-write leaves the previous journal whole.
    write: async (saved) => {
      await Deno.writeTextFile(`${path}.tmp`, JSON.stringify(saved) + "\n");
      await Deno.rename(`${path}.tmp`, path);
      stop ??= keepFresh(path);
    },
    remove: async () => {
      stop?.();
      liveJournals.delete(name);
      await Deno.remove(path).catch(() => {
        // aio-ok: already gone — nothing left to journal either way
      });
    },
  };
}

/** Is the build that wrote the journal at `path` (file `name`, no `.tmp`)
 *  still running? No owner (an older aio's un-stamped journal): no. Another
 *  pid namespace: judged by the journal's mtime — its build heartbeats it. */
function journalOwnerAlive(
  path: string,
  name: string,
  owner: ProcId | null,
): boolean {
  return !!owner &&
    (foreignNs(owner)
      ? touchedRecently(path)
      : holderAlive(owner, liveJournals.has(name)));
}

/** Put back the `node_modules` links a build that DIED left aside — and the
 *  files its trim mirror still holds ({@link recoverTrim}).
 *
 *  A build killed mid-compile (Ctrl-C, a CI timeout, a crash: `finally` never
 *  ran) left the project without them — and deno never re-creates a top-level
 *  `node_modules/<pkg>` link it believes it already wrote (`deno install`
 *  included), so every later bundle failed `Could not resolve "<pkg>"` until
 *  someone deleted node_modules. The journal is written BEFORE each removal;
 *  every build runs this first — and every start from source, when a journal
 *  is there (`recoverInterruptedBuild`) — and leaves a LIVE build's journal alone (its
 *  own `finally` restores those links): all of them while another live
 *  process holds the lock, and any whose own pid is alive. */
export async function recoverInterruptedLinks(nmDir: string): Promise<void> {
  const journals: { name: string; owner: ProcId | null }[] = [];
  try {
    for await (const e of Deno.readDir(nmDir)) {
      const m = LINK_JOURNAL_RE.exec(e.name);
      if (m) {
        journals.push({
          name: e.name,
          // hex after the 8-char nonce: the owner's start tag, if any
          owner: m[1] ? withTag(Number(m[1]), m[2]!.slice(8)) : null,
        });
      }
    }
  } catch { /* aio-ok: no node_modules — nothing was held aside */ }
  const lock = join(nmDir, ".aio-build-lock");
  const raw = readOrNull(lock);
  const holder = raw === null ? null : lockOwner(raw, readOrNull(`${lock}.id`));
  // Our own pid (same namespace): we hold it (recovery runs inside the lock)
  // or it is stale. Anyone else live — or unjudgeable — holds the links.
  // Another namespace's lock judged dead (see foreignLockAlive: a one-shot
  // call from build.ts has never watched it) is a dead build's: it no longer
  // keeps any journal (our own namespace's included) unrecovered.
  if (
    holder &&
    (foreignNs(holder) ? foreignLockAlive(lock) : holderAlive(holder, false))
  ) return;
  // So no live build holds the lock. A foreign journal is judged by its mtime
  // on our wall clock (a one-shot read cannot watch it): wrong only after a
  // suspend or across skewed hosts, and even then it can only name a build
  // that runs WITHOUT the lock (one that built beside it, or lost it while
  // frozen) — whose own `finally` puts the same links back.
  let restored = 0;
  for (const { name, owner } of journals) {
    const temp = name.endsWith(".tmp");
    // A live build's own `finally` restores its links.
    const journal = temp ? name.slice(0, -4) : name;
    const path = join(nmDir, name);
    if (journalOwnerAlive(path, journal, owner)) {
      if (foreignNs(owner!) && !temp) {
        console.warn(
          `${HEY} build link journal ${path} belongs to a build in another ` +
            `pid namespace (a container sharing this node_modules) that ` +
            `touched it in the last 2 min — left alone; recovered once it ` +
            `goes untouched that long.`,
        );
      }
      continue;
    }
    if (temp) {
      // Killed before its rename: the journal it would have replaced still
      // lists every link actually removed (removal follows the rename).
      await Deno.remove(path).catch(() => {
        // aio-ok: a concurrent recovery removed it
      });
      continue;
    }
    const left = await readLinkJournal(path);
    if (!left) {
      console.warn(
        `${HEY} build link journal ${path} is unreadable (a build was ` +
          `killed while writing it) — kept, NOT recovered. To fix: delete ` +
          `${path}; if a bundle then fails \`Could not resolve "<pkg>"\`, ` +
          `a link it listed is still missing: remove ${nmDir} and run ` +
          `\`deno install\`.`,
      );
      continue;
    }
    await restoreLinks(nmDir, left);
    await Deno.remove(path).catch(() => {
      // aio-ok: a concurrent recovery removed it — the links are back either way
    });
    restored += left.length;
  }
  if (restored) {
    console.warn(
      `${HEY} restored ${restored} node_modules link(s) an interrupted ` +
        `build left aside`,
    );
  }
  await recoverTrim(nmDir);
}

/** The journal's links: [] when it is gone (a concurrent recovery took it),
 *  null when it cannot be read or parsed. */
async function readLinkJournal(path: string): Promise<SavedLink[] | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    return e instanceof Deno.errors.NotFound ? [] : null;
  }
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch {
    return null; // aio-ok: torn or foreign — the caller warns and keeps it
  }
}

/** A held-aside link's target, as the journal keeps it. deno writes these
 *  links relative on POSIX and as junctions — ABSOLUTE — on Windows, so there
 *  a target inside `nmDir` is journaled relative to its link: the journal
 *  survives the project being moved on every OS, not only where the link was
 *  relative to begin with. Pure. */
function journalTarget(nmDir: string, link: string, target: string): string {
  if (Deno.build.os !== "windows" || !isAbsolute(target)) return target;
  const inside = relative(nmDir, target);
  return inside.startsWith("..") || isAbsolute(inside)
    ? target
    : relative(dirname(link), target);
}

/** Re-create one of deno's `node_modules` links — each points at a package
 *  DIRECTORY. On Windows that is a junction, as deno itself writes it: with
 *  no `type` Deno made a directory symlink, which needs
 *  `SeCreateSymbolicLinkPrivilege` — on a stock box every restore failed
 *  `PermissionDenied` and the build left the project without its dev links
 *  (same reason as `dirLinkType` in am-utils.ts). A junction's target is
 *  absolute, so a relative one is resolved against the link's folder. */
async function linkPackage(target: string, link: string): Promise<void> {
  await (Deno.build.os === "windows"
    ? Deno.symlink(resolve(dirname(link), target), link, { type: "junction" })
    : Deno.symlink(target, link));
}

/** `path` is node_modules-relative (an absolute one, from an older journal,
 *  is used as is). */
async function restoreLinks(
  nmDir: string,
  saved: readonly SavedLink[],
): Promise<void> {
  for (const { path: rel, target, isDir } of saved) {
    const path = resolve(nmDir, rel);
    try {
      if (isDir) {
        await Deno.mkdir(path, { recursive: true });
        for (
          const { name, target: t } of JSON.parse(target) as Array<
            { name: string; target: string }
          >
        ) {
          await Deno.remove(join(path, name)).catch(() => {
            // aio-ok: nothing there to replace — the symlink below is the point
          });
          await linkPackage(t, join(path, name));
        }
      } else {
        await Deno.mkdir(dirname(path), { recursive: true });
        try {
          await Deno.remove(path);
        } catch { /* already gone */ }
        await linkPackage(target, path);
      }
    } catch (e) {
      console.warn(`${HEY} failed to restore symlink ${path}: ${e}`);
    }
  }
}
