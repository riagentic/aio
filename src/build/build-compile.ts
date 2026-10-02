/**
 * @module
 * Build compile — withDevExcluded symlink manager + deno compile step + systemd service file.
 */
import { APP_STYLE, BUNDLE_JS } from "../server/app-files.ts";
import {
  DENO_JSON_NAMES,
  readDenoJson,
  readDenoJsonSync,
} from "../server/deno-json.ts";
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
import { resolveEntryPath } from "../server/paths.ts";
import {
  basename,
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import {
  artifactName,
  hostPlatform,
  type NpmSystem,
  npmSystemOf,
  PLATFORMS,
  runsOn,
} from "./platforms.ts";
import { BUILD_STAMP_FILE } from "./build-version.ts";
import { BUILD_VERSION_ENV } from "../server/app-version.ts";
import { DEFAULT_PORT_ENV } from "../server/aio-cli.ts";
import {
  compiledMaxHeapMB,
  declaredMaxHeapOf,
  physicalMemoryBytes,
} from "../server/heap-policy.ts";
import type { BuildConfig } from "./build-config.ts";
import { HEY, NO } from "../diagnostics/fmt.ts";
import { compiled } from "./build-say.ts";
import { electronStagingDir, freshElectronStaging } from "./build-electron.ts";
import { writeWindowsIcon } from "./build-helpers.ts";
import { warnMachineBoundImports } from "./machine-bound-imports.ts";
import { minifyDeclared, runCompile } from "./minify-server.ts";
import {
  INSTALL_BIN_DIR,
  INSTALL_STATE_FILES,
  warnBuildToolsIn,
} from "./artifact-audit.ts";

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

/** `deno info --json` for each module root, or null if any cannot be read. */
async function denoInfoGraphs(
  cwd: string,
  roots: readonly string[],
): Promise<DenoInfoGraph[] | null> {
  const out: DenoInfoGraph[] = [];
  for (const r of roots) {
    try {
      const p = await new Deno.Command("deno", {
        args: ["info", "--json", r],
        cwd,
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!p.success) return null;
      out.push(JSON.parse(new TextDecoder().decode(p.stdout)));
    } catch {
      return null;
    }
  }
  return out;
}

/** The module files a compile embeds as ROOTS: the entry and every
 *  `--include` that is itself a module (the DB worker, `.server.ts` assets).
 *  Pure. */
export function compileModuleRoots(
  entry: string,
  includeArgs: readonly string[],
): string[] {
  const roots = [entry];
  includeArgs.forEach((a, i) => {
    const v = includeArgs[i + 1];
    if (a === "--include" && v && /\.(m?[jt]sx?)$/.test(v)) roots.push(v);
  });
  return roots;
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
  graph?: { cwd: string; roots: readonly string[]; keepUnreached?: boolean },
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
    return await _withDevExcluded(
      nmDir,
      fn,
      graph,
      keepPackages,
      release,
      platform,
    );
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
 *  loads from there (`deno info` lists a `local` file for everything but an
 *  npm package's internals). {@link collectTrim} holds none of them aside. Pure. */
export function reachedDenoRels(
  graphs: readonly DenoInfoGraph[],
  denoDir: string,
): string[] {
  const out: string[] = [];
  for (const g of graphs) {
    for (const m of g.modules ?? []) {
      if (!m.local) continue;
      const rel = relative(denoDir, m.local);
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
const TRIM_JOURNAL_RE =
  /^trim-journal(?:\.((\d+)-([0-9a-f]+)))?\.json(?:\.tmp)?$/;

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

/** Every path under `denoDir` to hold aside — source maps, docs, and test
 *  fixture directories ({@link isTrimmedDir}) — relative to `denoDir`.
 *  Top-level entries named in `skipTop` (the packages already `--exclude`d,
 *  and the `build.keepPackages` ones) are not walked, and nothing in `reached`
 *  ({@link reachedDenoRels}) is taken: a module the graph loads is runtime
 *  code whatever its name. Symlinks are never followed. Exported for tests.
 *  @internal */
export async function collectTrim(
  dir: string,
  out: string[],
  rel = "",
  skipTop?: ReadonlySet<string>,
  reached: readonly string[] = [],
): Promise<string[]> {
  try {
    // `Deno.readDir` is lazy: a missing/unreadable dir throws on the FIRST
    // `for await` step, not at the call — so the try must wrap the loop.
    for await (const e of Deno.readDir(dir)) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (rel === "" && skipTop?.has(e.name)) continue;
        if (
          isTrimmedDir(childRel) &&
          !reached.some((r) => r.startsWith(`${childRel}/`))
        ) {
          out.push(childRel);
          continue;
        }
        await collectTrim(join(dir, e.name), out, childRel, skipTop, reached);
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
  },
  keepPackages: readonly string[] = [],
  /** Release the build lock — for the one exit that skips the caller's
   *  `finally` (a signal). */
  release: () => void = () => {},
  platform: string = hostPlatform(),
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
    const failed = await installFor(graphRoots.cwd, sys, graphRoots.roots);
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
      const t = await Deno.readLink(path);
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
            target: await Deno.readLink(join(path, e.name)),
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

/** The links a running build holds aside, written before each removal: ONE
 *  file per build (`.aio-build-links.<pid>-<nonce8><tag>.json`), so two
 *  builds never share a read-modify-write. The name is one an OLDER aio's
 *  pattern (`.<pid>-<hex>`) still reads as its pid's journal; the owner's
 *  start stamp rides in the hex tail. An older build's `.aio-build-links.json`
 *  is still recovered. `<journal>.tmp` is a write killed before its rename. */
const LINK_JOURNAL_RE =
  /^\.aio-build-links(?:\.(\d+)-([0-9a-f]+))?\.json(?:\.tmp)?$/;

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
 *  every build runs this first, and leaves a LIVE build's journal alone (its
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
          await Deno.symlink(t, join(path, name));
        }
      } else {
        await Deno.mkdir(dirname(path), { recursive: true });
        try {
          await Deno.remove(path);
        } catch { /* already gone */ }
        await Deno.symlink(target, path);
      }
    } catch (e) {
      console.warn(`${HEY} failed to restore symlink ${path}: ${e}`);
    }
  }
}

/** `--include` args for the workers `deno compile` cannot trace. Each is
 *  started from a `new URL(…, import.meta.url)` handed to a Worker
 *  constructor, which is invisible to the module graph, so without an explicit include the binary
 *  builds green and dies in the user's hands with "Module not found" the first
 *  time that worker starts — on the build box it passes, because the VFS falls
 *  through to the real file still sitting at the same absolute path.
 *
 *   - `db/db-worker.ts`      — EVERY binary needs it since B4a (persistence
 *                              always opens the worker-thread DB for aio_kv).
 *   - `state/blocking-worker.ts` — the `blocking()` pool (public, mod.ts).
 *
 *  `tests/worker-includes.test.ts` enumerates every `new Worker(new URL(…))`
 *  in `src/` and asserts each one is listed here, so a THIRD worker cannot be
 *  added without this list learning about it. */
export function dbWorkerInclude(): string[] {
  const workers = [
    new URL("../db/db-worker.ts", import.meta.url),
    new URL("../state/blocking-worker.ts", import.meta.url),
  ];
  // fromFileUrl, not .pathname: pathname keeps percent-encoding (a space in
  // the path becomes %20) and on Windows yields "/C:/…" — either way deno
  // compile cannot find the worker and every build ships without it.
  return workers.flatMap((u) =>
    u.protocol === "file:" ? ["--include", fromFileUrl(u)] : []
  );
}

/** aio's server-only module convention: `x.server.ts` / `x.server.tsx`.
 *  ONE spelling of the rule for the compile include — the graph validator and
 *  `aiol` recognise the same suffix, and a second spelling here is how the two
 *  drift. */
export function isServerModule(name: string): boolean {
  return name.endsWith(".server.ts") || name.endsWith(".server.tsx");
}

// Dirs never scanned for app assets (deps / build output / VCS / vendored fw).
const ASSET_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dep",
  "target", // Rust/Cargo build output (rust/target/…)
  ".git",
  ".aio",
  ".cache",
]);

/** URL-path extensions worth checking. Deliberately narrow: an extension-less
 *  path is a ROUTE, and a route is the app's business. */
const ASSET_URL_EXT =
  /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|pdf|json|txt|csv|xml|wasm|glb|gltf|md)$/i;

/** Every absolute asset URL a bundle asks a browser to fetch — `src="/x.svg"`,
 *  `url(/fonts/y.woff2)`, a fetch of a literal path. String-literal scan, not a
 *  parser: the bundle is minified JS plus CSS, and the only thing that matters
 *  is which paths it names. */
/** Absolute paths that are FILESYSTEM examples, not URLs an app serves.
 *
 *  The scan below reduces every quoted `/…` in the bundle to "a URL the page
 *  might fetch", and a bundle is full of strings that merely look like one. A
 *  field report (report 5 §6) had `placeholder="/home/you/documents/cv.pdf"` —
 *  help text in a file picker — reported as an asset that would 404.
 *
 *  These prefixes are the roots of an operating system, not of a web server.
 *  No aio app routes `/home` or `/Users`, and a build warning that cries wolf
 *  is one people learn to scroll past — which costs more than the warning was
 *  ever worth, because the REAL finding (an asset that works in dev and 404s in
 *  the artifact) is the one that then goes unread. */
const FS_ROOT_RE =
  /^\/(?:home|Users|root|tmp|var|etc|opt|usr|proc|sys|dev|mnt|media|Library|Applications|System|Volumes)\//;

export function assetUrlsIn(bundle: string): string[] {
  const out = new Set<string>();
  // Quoted string literals and css url(…) — both reduce to "a / path".
  for (
    const m of bundle.matchAll(
      /(?:"|'|`|url\(\s*"?'?)(\/[A-Za-z0-9._~\-/]+)(?:"|'|`|"?'?\s*\))/g,
    )
  ) {
    const p = m[1]!;
    if (p.startsWith("//")) continue; // protocol-relative URL, not a path
    if (p.startsWith("/__aio/")) continue; // the framework's own routes
    if (FS_ROOT_RE.test(p)) continue; // an OS path in prose, not a URL
    if (!ASSET_URL_EXT.test(p)) continue;
    out.add(p);
  }
  return [...out].sort();
}

/** Asset URLs the bundle references that the ARTIFACT will not be able to
 *  serve — the check the gates were missing.
 *
 *  Every gate aio had read the SOURCE TREE, and the source tree is not what
 *  ships: `<img src="/assets/logo.svg">` is a real URL in dev (the dev server
 *  serves the app dir, and the file really is in the repo) and a broken-image
 *  glyph in the compiled binary, because nothing embedded the file. Typecheck,
 *  lint and a full suite all pass; the first person to see it is a user, on a
 *  first-run screen.
 *
 *  Pure — every input injected — so the RULE is unit-testable without running
 *  a build. Reports two distinct mistakes and never conflates them:
 *   - `missing`: the file is not in the app dir at all (broken in dev too);
 *   - `unembedded`: the file EXISTS and nothing will put it in the binary,
 *     which is the dev/prod divergence this exists to catch.
 *
 *  `dist/` counts as embedded: the build stages it and `deno compile` takes it
 *  wholesale, so an asset the bundler copied there ships already. */
export function unservableAssetRefs(opts: {
  /** Absolute URL paths the bundle references — see `assetUrlsIn`. */
  urls: string[];
  /** Root-relative include paths (files or dirs) the compile will embed. */
  included: string[];
  /** The app dir a URL path resolves against at runtime — THE app-dir decider
   *  (`baseDirCandidates`), root-relative. */
  appDir: string;
  /** Is `dist/` being embedded? */
  hasDist: boolean;
  /** Does this root-relative path exist on disk? Injected, so the rule is pure. */
  exists: (rel: string) => boolean;
}): Array<{ url: string; rel: string; why: "missing" | "unembedded" }> {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const covered = [
    ...(opts.hasDist ? ["dist"] : []),
    ...opts.included.map(norm),
  ];
  const out: Array<
    { url: string; rel: string; why: "missing" | "unembedded" }
  > = [];
  for (const url of opts.urls) {
    const rel = norm(join(opts.appDir, url.slice(1)));
    // Served straight out of dist/ (the bundler's own output, e.g. /app.js).
    if (opts.hasDist && opts.exists(norm(join("dist", url.slice(1))))) continue;
    if (!opts.exists(rel)) {
      out.push({ url, rel, why: "missing" });
      continue;
    }
    // aio-ok: path-split — both normalised to `/` by `norm`
    const embedded = covered.some((c) => rel === c || rel.startsWith(c + "/"));
    if (!embedded) out.push({ url, rel, why: "unembedded" });
  }
  return out;
}

/** Which `*.server.ts` a binary compiled from `entry` embeds. Pure.
 *
 *  Field report (a remote-desktop app, §4): every binary embedded EVERY `*.server.ts` in the
 *  repo, so a public relay shipped the agent's input-injection and capture
 *  code and each desktop app shipped the relay's. A server module ships when
 *  the entry can load it:
 *   1. it is in the entry's module graph (static or analysable dynamic
 *      import — `deno info` lists both);
 *   2. it lives under the entry's own directory (the app's dir — a registry
 *      there may load it through an opaque specifier the graph cannot see);
 *   3. it sits in the same directory as a module the graph reaches (a shared
 *      loader beside its plugins, same reason).
 *  Everything else is `skipped` — the caller prints it, so an opaque load from
 *  elsewhere is one `compile.include` line away and never a silent mystery.
 *  `graph` null (unreadable) ⇒ embed all: a bigger binary beats a broken one.
 *
 *  `siblingEntries` (optional — additive): the OTHER build targets' entries.
 *  A candidate whose nearest enclosing target directory is a SIBLING's — not
 *  this entry's — ships only when this entry's graph reaches it. Without it,
 *  rule 2 handed the `am create` shape (web `src/app.ts`, agent
 *  `src/agent/app.ts`) the agent's server code: `src/agent/` is "under" the
 *  web entry's `src/`. A sibling at the project root owns nothing (its dir is
 *  every target's), and a sibling sharing this entry's dir changes nothing.
 *  All paths root-relative, `/`-separated. */
export function serverModulePlan(opts: {
  candidates: readonly string[];
  graph: readonly string[] | null;
  entry: string;
  siblingEntries?: readonly string[];
}): { embed: string[]; skipped: string[] } {
  const norm = (p: string) => p.split("\\").join("/").replace(/^\.\//, "");
  if (!opts.graph) return { embed: [...opts.candidates], skipped: [] };
  const dirOf = (p: string) => {
    // aio-ok: path-split — callers pass `norm(…)` — `\\` already `/`
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  };
  const reached = new Set(opts.graph.map(norm));
  const graphDirs = new Set([...reached].map(dirOf));
  const appDir = dirOf(norm(opts.entry));
  // aio-ok: path-split — normalised to `/` by `norm`
  const under = (p: string) => appDir === "" || p.startsWith(appDir + "/");
  // aio-ok: path-split — normalised to `/` by `norm`
  const inDir = (p: string, d: string) => p.startsWith(d + "/");
  // aio-ok: path-split — normalised to `/` by `norm`
  const depth = (d: string) => d === "" ? 0 : d.split("/").length;
  const siblingDirs = (opts.siblingEntries ?? []).map((e) => dirOf(norm(e)))
    .filter((d) => d !== "" && d !== appDir);
  /** The nearest target dir holding `c` is a sibling's, not this entry's. */
  const siblingOwns = (c: string) => {
    const own = under(c) ? depth(appDir) : -1;
    return siblingDirs.some((d) => inDir(c, d) && depth(d) > own);
  };
  const embed: string[] = [];
  const skipped: string[] = [];
  for (const c of opts.candidates.map(norm)) {
    if (siblingOwns(c)) {
      (reached.has(c) ? embed : skipped).push(c);
      continue;
    }
    (reached.has(c) || under(c) || graphDirs.has(dirOf(c)) ? embed : skipped)
      .push(c);
  }
  return { embed, skipped };
}

/** The entries of the project's OTHER build targets (deno.json
 *  `build.targets`, object form — a target without its own `entry` compiles
 *  the project's), root-relative. Read here rather than handed down by the
 *  fleet so a single-target build (`--targets=web`) scopes exactly as the
 *  fleet does. A deno.json that does not parse is reported by
 *  `assetIncludes`' own `compile.include` read, so this answers `[]`. */
async function siblingTargetEntries(
  root: string,
  entry: string,
): Promise<string[]> {
  let cfg: Record<string, unknown>;
  try {
    cfg = (await readDenoJson(root))?.config ?? {};
  } catch {
    return []; // aio-ok: said by assetIncludes' compile.include read below
  }
  const targets = (cfg.build as { targets?: unknown } | undefined)?.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    return [];
  }
  const norm = (p: string) => p.split("\\").join("/").replace(/^\.\//, "");
  const own = norm(entry);
  const out = new Set<string>();
  for (const t of Object.values(targets as Record<string, unknown>)) {
    const override = (t as { entry?: unknown } | null)?.entry;
    const e = norm(
      resolveEntryPath(
        cfg,
        typeof override === "string" ? override : undefined,
      ),
    );
    if (e !== own) out.add(e);
  }
  return [...out];
}

/** Root-relative local files in `entry`'s module graph (`deno info`, which
 *  lists analysable dynamic imports too), or null when it cannot be read. */
export async function localModuleGraph(
  root: string,
  entry: string,
): Promise<string[] | null> {
  try {
    const p = await new Deno.Command("deno", {
      args: ["info", "--json", entry],
      cwd: root,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!p.success) return null;
    const j = JSON.parse(new TextDecoder().decode(p.stdout)) as {
      modules?: Array<{ local?: string }>;
    };
    // `deno info` reports each module's REAL path. A root reached through a
    // symlink (a linked checkout, `~/apps/x -> /srv/x`) made every one of
    // them `../<real>/…` against the link, so the whole graph read as outside
    // the project and a sibling `*.server.ts` the entry imports was left out
    // of the binary — which then dies at the import. Compare real to real.
    const base = await Deno.realPath(root);
    return (j.modules ?? []).flatMap((m) => {
      if (!m.local) return [];
      const rel = relative(base, m.local);
      return rel.startsWith("..") || isAbsolute(rel)
        ? []
        : [rel.split("\\").join("/")];
    });
  } catch {
    return null;
  }
}

/** `--include` args for the app's runtime DATA ASSETS that `deno compile` can't
 *  trace — anything loaded via `Deno.readFile(new URL("./x", import.meta.url))`
 *  is invisible to the module graph, so it's missing from the binary/AppImage
 *  unless explicitly embedded. WITHOUT this a WASM app compiles fine but shows
 *  "wasm not available" at runtime (the #1 report). Covers:
 *   1. every `.wasm` in the project (zero-config — WASM is a first-class case);
 *   2. every `*.server.ts` / `*.server.tsx` (zero-config — see below);
 *   3. any extra paths the app declares in deno.json `compile.include`
 *      (files or dirs, relative to the project root — for data files, models…).
 *  Returns flat `["--include", "&lt;relpath&gt;", …]` args (deduped, root-relative).
 *
 *  `entry` (root-relative, optional — additive): the module this binary is
 *  compiled from. Given one, only the `*.server.ts` that entry can REACH ship —
 *  see {@link serverModulePlan}. Without it every `*.server.ts` in the tree is
 *  embedded, as before. */
export async function assetIncludes(
  root: string,
  entry?: string,
): Promise<string[]> {
  const rels: string[] = [];
  const serverMods: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    const norm = rel.split("\\").join("/");
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      rels.push(norm);
    }
  };

  // 1) auto-discover every .wasm (bounded walk, skipping deps/build/VCS dirs).
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 10) return;
    // The guard wraps the ITERATION: `Deno.readDir` is lazy, so an unreadable
    // directory surfaced from the first `for await`, not the assignment, and
    // the `catch` below was dead — a vanished subdir crashed the walk.
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) {
        if (ASSET_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile && e.name.endsWith(".wasm")) {
        add(relative(root, join(dir, e.name)));
      } else if (isServerModule(e.name)) {
        // A `*.server.ts` module is aio's documented escape hatch: a cell
        // method reaches it with `await import(…)`, which keeps it out of the
        // browser bundle by construction. Whether `deno compile` can follow
        // that import depends on the SPECIFIER, and the difference is invisible
        // in dev, where the dev server transpiles on demand and every shape
        // works. MEASURED on Deno 2.9, running the binary from a foreign cwd
        // with the sources deleted (they otherwise fall through to disk and
        // every shape appears to pass):
        //
        //   await import("./io.server.ts")        analysable  → embedded
        //   await import(`./${name}.server.ts`)   analysable  → embedded
        //   const s = new URL(…).href; import(s)  OPAQUE      → NOT embedded,
        //                                         and the binary dies with a
        //                                         module error at the call.
        //
        // The opaque form is what a registry or a plugin loader writes, and it
        // is the shape two field reports hit. The answer was a comment telling
        // people to hand-register each module in app.ts — a rule enforced by
        // nothing, whose violation is invisible until a user runs the binary.
        //
        // Dev == prod is load-bearing, so this is discovered rather than
        // declared: the naming convention IS the registration. Same treatment
        // `.wasm` gets above, for the same reason, and the cost of including a
        // module the graph already had is a duplicate the VFS de-dupes.
        //
        // …but only for the binary that can load it. A repo with several
        // targets (relay + agent + control) must not ship the agent's input
        // injection inside the public relay — `serverModulePlan` decides.
        serverMods.push(
          relative(root, join(dir, e.name)).split("\\").join("/"),
        );
      }
    }
  };
  await walk(root, 0);
  if (entry === undefined) serverMods.forEach(add);
  else {
    entry = relative(root, isAbsolute(entry) ? entry : join(root, entry));
    const graph = await localModuleGraph(root, entry);
    if (!graph) {
      console.warn(
        `${HEY} could not read ${entry}'s module graph — embedding every ` +
          `*.server.ts in the project (the binary may carry other targets' ` +
          `server code)`,
      );
    }
    const plan = serverModulePlan({
      candidates: serverMods,
      graph,
      entry,
      siblingEntries: await siblingTargetEntries(root, entry),
    });
    plan.embed.forEach(add);
    if (plan.skipped.length) {
      // A warning, not a progress line: a module left out here that the app
      // DOES load (opaquely) is a binary that dies at runtime, and the fix is
      // one config line — so it must not scroll past with the build output.
      console.warn(
        `${HEY} not embedding ${plan.skipped.length} *.server.ts ${entry} cannot ` +
          `reach: ${plan.skipped.join(", ")} — if it loads one through an ` +
          `opaque specifier, add it to deno.json "compile": { "include": [] }`,
      );
    }
  }

  // 2) declarative deno.json `compile.include` — files/dirs the app wants
  //    embedded (any asset kind). Kept inside the project (no traversal out),
  //    and a path that breaks that rule is REFUSED, never dropped: a silently
  //    skipped entry ships a binary without the asset it was told to carry,
  //    and the failure surfaces in the user's hands as a missing model/data
  //    file. (A path that does not exist, or a glob, already makes
  //    `deno compile` fail hard — this closes the one silent case.)
  let decl: unknown;
  try {
    const cfg = (await readDenoJson(root))?.config ?? {};
    decl = (cfg as { compile?: { include?: unknown } })?.compile?.include;
  } catch (e) {
    // "nothing declared" is only true when there is no deno.json. One that
    // cannot be PARSED has to say so, or every asset it declares is dropped.
    if (!(e instanceof Deno.errors.NotFound)) {
      console.warn(
        `${HEY} deno.json could not be read (${e}) — no compile.include applied`,
      );
    }
  }
  if (Array.isArray(decl)) {
    for (const [i, p] of decl.entries()) {
      if (typeof p !== "string" || !p.trim()) {
        throw new Error(
          `${NO} deno.json compile.include[${i}] is ${
            JSON.stringify(p)
          } — every entry must be a non-empty path relative to the project root.`,
        );
      }
      const entry = p.trim();
      const rel = relative(root, join(root, entry));
      // An ABSOLUTE entry is silently reinterpreted by `join` as a
      // root-relative one (`/etc/passwd` → `<root>/etc/passwd`), so it would
      // embed a DIFFERENT file than the one declared — refuse both that and a
      // `../` escape, and say which of the two it is.
      const absolute = isAbsolute(entry);
      if (absolute || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
          `${NO} deno.json compile.include[${i}] ("${p}") is ` +
            (absolute
              ? `absolute; paths are relative to the project root, and this ` +
                `one would silently embed ${join(root, entry)} instead`
              : `outside the project (${join(root, entry)})`) +
            `. deno compile embeds paths relative to the project root — copy ` +
            `the asset into the project and reference it from there.`,
        );
      }
      add(rel);
    }
  }

  // 2b) the directories the app SERVES (`assets` in deno.json). `deno compile`
  //     cannot trace a directory nobody imports, so an asset mount declared
  //     only in code serves perfectly in dev and 404s from the binary — the
  //     "build products go stale in silence" shape, discovered by a user.
  //     Declared in deno.json it is embedded with nothing to keep in sync:
  //     ONE fact, read by the server that serves it and the build that ships
  //     it.
  //
  //     Same containment rule as `compile.include`, and REFUSED the same way
  //     rather than dropped: a silently skipped mount ships a binary without
  //     the data it was told to carry.
  let cfg: unknown;
  try {
    cfg = (await readDenoJson(root))?.config;
  } catch {
    // aio-ok: the parse failure is already reported by the compile.include
    // read above, which runs first and says so once.
  }
  for (const m of assetMounts(cfg, root)) add(m.rel);

  // 3) the app's config itself — its IDENTITY (version, title, client). The
  //    runtime reads it relative to the entry module, so a binary knows its own
  //    version instead of falling back to "0.0.0" or, worse, adopting the
  //    version of whatever project it happens to be launched from.
  //
  //    BOTH names: `DENO_JSON_NAMES` is the decider and every reader honours
  //    `.jsonc`, so embedding the literal "deno.json" shipped a `.jsonc` app
  //    with no identity at all — title "AIO App", version 0.0.0, `"client":
  //    "browser"` ignored so the shell silently defaulted to Electron, and an
  //    appId taken from the binary's FILE NAME (which moves the data dir on
  //    every renamed install).
  for (const name of DENO_JSON_NAMES) {
    try {
      await Deno.stat(join(root, name));
      add(name);
      break; // deno reads the FIRST match — embed exactly that one
    } catch { /* not this name — try the next */ }
  }

  return rels.flatMap((r) => ["--include", r]);
}

/** `--v8-flags` for the binary, from deno.json `compile.v8Flags`.
 *
 *  V8 options are fixed at isolate creation, so a COMPILED binary cannot pick
 *  them up the way `deno run` does: it ignores `DENO_V8_FLAGS` entirely, and
 *  the only way in is `deno compile --v8-flags=`. Without this an app that
 *  raises its heap in the `dev` task silently reverts to V8's ~4 GB default
 *  once packaged — dev and prod get different memory ceilings, and the app
 *  finds out under load, in the user's hands.
 *
 *  Declared per app because the right value is a property of the workload
 *  (an app whose peak memory scales with its input needs it; most do not):
 *
 *    "build": { "v8Flags": ["--max-old-space-size=16384"] }
 *
 *  It lives under aio's own `build` block, NOT under `compile`: `compile` is
 *  Deno's, and `deno compile` rejects the whole config on an unknown key there
 *  with "Failed to parse compile configuration" — so that spelling is detected
 *  and redirected rather than left to fail cryptically at build time.
 *
 *  Returns `["--v8-flags=a,b"]`, or `[]` when nothing is declared. */
/** deno.json `assets` — `{ "/prefix": "./dir" }` — as `{ prefix, rel }` with
 *  `rel` relative to `root`. THE one reading, for the binary that embeds the
 *  mounts and the standalone APK that packages them. A value that is not a
 *  non-empty path inside the project is REFUSED, never dropped: a skipped
 *  mount ships an artifact without the data it was told to carry. */
export function assetMounts(
  config: unknown,
  root: string,
): { prefix: string; rel: string }[] {
  const mounts = (config as { assets?: unknown } | undefined)?.assets;
  if (!mounts || typeof mounts !== "object" || Array.isArray(mounts)) {
    return [];
  }
  return Object.entries(mounts).map(([prefix, dir]) => {
    if (typeof dir !== "string" || !dir.trim()) {
      throw new Error(
        `${NO} deno.json assets["${prefix}"] is ${JSON.stringify(dir)} — ` +
          `every value must be a non-empty directory path relative to the ` +
          `project root.`,
      );
    }
    const entry = dir.trim();
    const rel = relative(root, join(root, entry));
    if (isAbsolute(entry) || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `${NO} deno.json assets["${prefix}"] ("${dir}") is outside the ` +
          `project. An artifact carries paths relative to the project root, ` +
          `so this directory could not travel with it — move it inside the ` +
          `project and point the mount at the copy.`,
      );
    }
    return { prefix, rel };
  });
}

/** The `--v8-flags=…` argument for `deno compile`: deno.json `build.v8Flags`
 *  under `root` (validated; a `compile.v8Flags` spelling is refused by name)
 *  plus a travelling `memory.maxHeap` ceiling, unless a flag already sets one;
 *  `[]` when there is nothing to pass. */
export async function v8FlagsArg(root: string): Promise<string[]> {
  let decl: unknown;
  let misplaced = false;
  try {
    const cfg = ((await readDenoJson(root))?.config ?? {}) as {
      build?: { v8Flags?: unknown };
      compile?: { v8Flags?: unknown };
    };
    decl = cfg?.build?.v8Flags;
    misplaced = decl === undefined && cfg?.compile?.v8Flags !== undefined;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.warn(
        `${HEY} deno.json could not be read (${e}) — no build.v8Flags applied`,
      );
    }
  }
  // `compile` is Deno's own block and it validates strictly, so this spelling
  // never reaches us as a working build — it makes `deno compile` abort with
  // "Failed to parse compile configuration", which names neither the key nor
  // the fix. Say both here instead.
  if (misplaced) {
    throw new Error(
      `${NO} deno.json has compile.v8Flags — it belongs under aio's ` +
        `"build" block, not "compile" (which is Deno's own, and rejects ` +
        `unknown keys). Move it: "build": { "v8Flags": [...] }`,
    );
  }
  // NOT an early return: an app that declares no v8Flags at all is the common
  // case, and it is exactly the one that needs the heap ceiling added below.
  if (decl !== undefined && !Array.isArray(decl)) {
    throw new Error(
      `${NO} deno.json build.v8Flags is ${
        JSON.stringify(decl)
      } — it must be an ARRAY of flags, e.g. ["--max-old-space-size=16384"].`,
    );
  }
  const flags: string[] = [];
  for (const [i, f] of (Array.isArray(decl) ? decl : []).entries()) {
    if (typeof f !== "string" || !f.trim()) {
      throw new Error(
        `${NO} deno.json build.v8Flags[${i}] is ${
          JSON.stringify(f)
        } — every entry must be a non-empty V8 flag string.`,
      );
    }
    const flag = f.trim();
    // Refused rather than repaired: a flag without `--` is silently ignored by
    // V8, so the binary would ship with the default it was meant to change.
    if (!flag.startsWith("--")) {
      throw new Error(
        `${NO} deno.json build.v8Flags[${i}] ("${f}") must start ` +
          `with "--" — V8 ignores anything else, so the binary would keep the ` +
          `default this was meant to raise.`,
      );
    }
    // The list is comma-joined, so an embedded comma would split one flag into
    // two — both wrong, and neither reported by V8.
    if (flag.includes(",")) {
      throw new Error(
        `${NO} deno.json build.v8Flags[${i}] ("${f}") contains a ` +
          `comma. Pass one flag per array entry — the list is comma-joined.`,
      );
    }
    flags.push(flag);
  }
  // The heap ceiling, unless the app already set one by hand. V8 freezes it at
  // isolate creation and a COMPILED binary ignores DENO_V8_FLAGS entirely
  // (measured), so `deno compile --v8-flags=` is the ONLY channel — and
  // whatever goes in here is the ceiling on every machine the artifact ever
  // reaches.
  //
  // Which is why it is NOT the build machine's 25% share any more. It was: a
  // binary cross-compiled on a 187 GB host booted in an 8 GB Windows VM and
  // announced `heap 46.7 GB max of 8.0 GB RAM` — six times the box's memory,
  // taken from a machine its user has never seen. `compiledMaxHeapMB` bakes
  // only what travels (see it for the whole rule): an absolute
  // `memory.maxHeap`, a percentage with a build-log line saying whose
  // percentage it is, and otherwise nothing at all — V8's own ~4 GB default,
  // which is the policy FLOOR and identical on every machine. An app that
  // wants more than the floor in a shipped binary says so in one config line,
  // and the boot report names that line when the machine allows more.
  if (!flags.some((f) => f.startsWith("--max-old-space-size"))) {
    const { mb, note } = compiledMaxHeapMB(
      declaredMaxHeap(root),
      physicalMemoryBytes(),
    );
    if (note) console.warn(`${HEY} ${note}`);
    if (mb !== null) flags.push(`--max-old-space-size=${mb}`);
  }
  return flags.length ? [`--v8-flags=${flags.join(",")}`] : [];
}

/** `memory.maxHeap` from deno.json, when the app states one.
 *
 *  Reads it through `declaredMaxHeapOf`, which is THE reader — this used to be
 *  a third private copy of "where the key lives", beside the boot path and the
 *  launcher. Three readers of one key is the shape that let the key mean
 *  different things in different places for a whole release line: the compiled
 *  artifact honoured it, the server and `am start` did not, and nothing
 *  disagreed out loud. The local copy also took `maxHeap` at any type, so a
 *  `{ maxHeap: {} }` reached the parser as an object. */
function declaredMaxHeap(root: string): string | number | undefined {
  try {
    return declaredMaxHeapOf(readDenoJsonSync(root)?.config ?? {});
  } catch {
    return undefined; // no deno.json — the rule's default applies
  }
}

/** The exact `deno compile` argv for a target — pure, so the WIRING is testable.
 *  Every include here is a runtime dependency that `deno compile` cannot trace
 *  on its own (the embedded `dist/`, the SQLite worker, the app's data assets);
 *  if one silently stops being passed, the binary still builds and only fails
 *  in the user's hands. Assembling the argv separately lets a unit test assert
 *  each one is present without running a real compile. */
export function compileArgs(opts: {
  hasDist: boolean;
  workerInclude: string[];
  /** `--v8-flags=…` from {@link v8FlagsArg}; `[]` when the app declares none. */
  v8Flags?: string[];
  assets: string[];
  excludes: string[];
  /** The app-version stamp (`.aio/build-version.json`), root-relative — the
   *  runtime reads it to report the version the build resolved. Absent only
   *  when there is none to embed (a caller compiling without the pipeline). */
  stamp?: string;
  out: string;
  entry: string;
  /** Cross-compilation triple; omitted when building for the host so deno
   *  uses its own default (and needs no extra runtime download). */
  target?: string;
}): string[] {
  // The public signature is FROZEN (`check:api`) — the two extras the BUILD
  // adds (the baked runtime args, the Windows GUI pair) live on the private
  // entry below, so an app that calls this helper sees exactly what it always
  // did.
  return _compileArgv(opts);
}

/** The build's own `deno compile` argv: {@link compileArgs} plus the switches
 *  only the packaging pipeline sets. NOT exported from `aio/build` — widening
 *  the public signature is a breaking change by the surface rule, and neither
 *  extra belongs to a caller compiling its own entry. `@internal`, reachable
 *  from tests through the module path (the repo's seam convention).
 *
 *   - `runtimeArgs` — baked AFTER the entry, so `deno compile` hands them to
 *     the program ahead of the user's own argv (the CLI parser keeps the last
 *     value). See {@link bakedClientArgs}.
 *   - `windowsGui` — a Windows desktop exe: no console window
 *     (`--no-terminal`), and the app's `.ico` as its file icon. A GUI exe
 *     double-clicked has no console, so an inherited stdout handle is invalid
 *     (see `electron-spawn.ts`). */
export function _compileArgv(opts: {
  hasDist: boolean;
  workerInclude: string[];
  v8Flags?: string[];
  assets: string[];
  excludes: string[];
  stamp?: string;
  out: string;
  entry: string;
  target?: string;
  runtimeArgs?: string[];
  windowsGui?: { icon: string };
}): string[] {
  return [
    "compile",
    // `-q`: deno compile prints an "Embedded Files" TREE of every module it
    // bundled — several hundred lines for an app that has three of its own.
    // The build already reports the artifact and its size on one line; the
    // tree buried that under a page of scrollback. Diagnostics are not
    // suppressed by `-q`, so a compile that FAILS still says why.
    "-q",
    "-A",
    ...(opts.target ? ["--target", opts.target] : []),
    ...(opts.windowsGui
      ? ["--no-terminal", "--icon", opts.windowsGui.icon]
      : []),
    ...(opts.v8Flags ?? []),
    ...(opts.hasDist ? ["--include", "dist/"] : []),
    ...opts.workerInclude,
    ...opts.assets,
    ...(opts.stamp ? ["--include", opts.stamp] : []),
    ...opts.excludes.flatMap((e) => ["--exclude", e]),
    "-o",
    opts.out,
    opts.entry,
    ...(opts.runtimeArgs ?? []),
  ];
}

/** The client a compiled binary boots in, baked in as `--client=…` so the
 *  TARGET decides — not the app's deno.json `"client"`, and not
 *  `aio.run({ client })` (a flag outranks both).
 *
 *  Nothing was baked before, except into a systemd unit. A binary asked
 *  `defaultClientFor`, which reads the app's own `"client"` — so the `browser`
 *  target of an Electron app booted as ELECTRON, found no runtime beside it,
 *  and started a silent ~100 MB download on a user's first double-click (real
 *  Windows 11, 2026-09-17); the `server-app` binary started by hand opened a
 *  desktop window. The build flags already say what the artifact is:
 *
 *   - `--electron` → the desktop package
 *   - `--headless`, or `--remote` (an exposed server that also serves its
 *     page) → `server-only`, which still serves the page
 *   - `--cli` → `cli`; `--cli --remote` compiles the app's OWN client program
 *     (not `aio.run()`), so nothing is baked into it
 *   - any other compile → the browser app
 *
 *  A `cli` binary whose embedded deno.json ALREADY declares `"client": "cli"`
 *  (what `am create --template=cli` writes) gets nothing baked: the flag would
 *  change no decision, and `deno compile` puts baked args IN FRONT of the
 *  user's, so the app's own program saw `Deno.args[0] === "--client=cli"` —
 *  the scaffolded `todo serve` fell through to "no todo server running".
 *
 *  Pure. */
export function bakedClientArgs(
  opts: {
    doElectron: boolean;
    doHeadless: boolean;
    doCli: boolean;
    doRemote: boolean;
    /** The app's deno.json `client` (or the retired `target`) — the rung the
     *  binary falls back to when nothing is baked. */
    declaredClient?: unknown;
  },
): string[] {
  if (opts.doCli) {
    return opts.doRemote || opts.declaredClient === "cli"
      ? []
      : ["--client=cli"];
  }
  const client = opts.doElectron
    ? "electron"
    : opts.doHeadless || opts.doRemote
    ? "server-only"
    : "browser";
  return [`--client=${client}`];
}

/** Run deno compile. Returns true on success. */
export async function runDenoCompile(
  cfg: BuildConfig,
  /** `out`: compile to this path instead of the target's usual place — the
   *  self-contained Windows exe is a second compile of the same app. */
  opts: { out?: string } = {},
): Promise<boolean> {
  const { root, dist, binaryName, configEntry, doElectron } = cfg;
  const nmDir = join(root, "node_modules");

  // Cross builds carry the platform in the name (and .exe on Windows) so a
  // dist/ holding every platform is unambiguous; the host keeps the bare name
  // every existing task and test expects. Electron compiles into the staging
  // dir its package is assembled in (build-electron.ts).
  const outName = doElectron
    ? binaryName
    : artifactName(binaryName, cfg.platform);
  // `--out=` (else the project root) is THE artifact destination — dist/ is
  // staging that every build wipes and embeds wholesale, so it is never where
  // a release lands. Orchestrating several single-target builds needs one
  // directory per app; without this, callers staged into dist/ and the next
  // build deleted it (R-4).
  const outDir = cfg.outDir ?? root;
  const compileTarget = opts.out ??
    (doElectron
      ? join(electronStagingDir(root), binaryName)
      : join(outDir, outName));
  if (!doElectron || opts.out) {
    await Deno.mkdir(dirname(compileTarget), { recursive: true });
  }
  if (cfg.targetTriple) {
    console.log(
      `cross-compiling for ${cfg.platform} (${cfg.targetTriple})`,
    );
  }
  if (doElectron && !opts.out) await freshElectronStaging(root);
  // A Windows desktop exe is a GUI program: no console window behind the app
  // (closing it killed the app), and the app's icon instead of Deno's.
  const windowsGui = doElectron && cfg.os === "windows"
    ? {
      icon: await writeWindowsIcon(
        join(dirname(electronStagingDir(root)), "app.ico"),
        {
          root,
          appDir: cfg.appDir,
          name: cfg.appTitle ?? binaryName,
          id: binaryName,
          warn: (m) => console.warn(`${HEY} ${m}`),
        },
      ),
    }
    : undefined;

  let hasDist = false;
  try {
    hasDist = (await Deno.stat(dist)).isDirectory;
  } catch { /* no dist */ }

  const workerInclude = dbWorkerInclude();
  // Embed the app's runtime data assets (.wasm + declared compile.include) —
  // deno compile can't trace `Deno.readFile(new URL(…, import.meta.url))`, so
  // without this a WASM app runs degraded in the binary/AppImage.
  const assets = await assetIncludes(root, configEntry);
  const v8Flags = await v8FlagsArg(root);
  if (v8Flags.length) console.log(`${v8Flags[0]}`);
  // An absolute / file: import-map value builds a binary that only runs HERE
  // (Deno 2.9 loads it from that disk path at run time). Warn, not refuse.
  await warnMachineBoundImports(root);
  if (assets.length) {
    console.log(
      `embedding ${assets.length / 2} data asset(s): ${
        assets.filter((a) => a !== "--include").join(", ")
      }`,
    );
  }
  // READ THE ARTIFACT'S OWN BUNDLE, not the source tree. Every other gate aio
  // has walks src/, and src/ is not what ships — which is how an asset URL
  // that resolves in dev shipped as a broken-image glyph on a first-run
  // screen with a full suite green. This is a warning, not a refusal: a
  // string literal is a heuristic (an app may serve `/report.pdf` from its own
  // `routes`), and a build that stops on a guess is worse than one that says
  // exactly what it found. The E2E gate is the hard half.
  await warnUnservableAssets(root, dist, hasDist, configEntry, assets);

  const graphRoots = {
    cwd: root,
    roots: compileModuleRoots(configEntry, [...workerInclude, ...assets]),
  };
  const minify = await minifyDeclared(root);
  const keepPackages = await keepPackagesDeclared(root);
  const ok = await withDevExcluded(
    nmDir,
    async (excludes) => {
      const result = await runCompile(
        root,
        _compileArgv({
          hasDist,
          workerInclude,
          assets,
          v8Flags,
          excludes,
          stamp: BUILD_STAMP_FILE,
          out: compileTarget,
          entry: configEntry,
          target: cfg.targetTriple,
          runtimeArgs: bakedClientArgs(cfg),
          windowsGui,
        }),
        minify,
      );
      if (!result.success) return false;
      // …and then RUN IT. `deno compile` exiting 0 is not the same claim as "the
      // artifact boots", and the gap is reachable: a project path containing a
      // SPACE (or any non-ASCII) makes the embedded npm module paths
      // percent-encoded TWICE (`%2520` where the importer says `%20`), so
      // nothing resolves and every flag — `--version` included — dies with
      // ERR_MODULE_NOT_FOUND. 100% dud, never intermittent, and `deno task dev`
      // in the same directory works fine, so only the shipped binary is dead.
      // The build said ✓ and `deno task doctor` said "15 checks passed".
      //
      // `ship.ts` already has this rule (`notRunnable`, via
      // `--aio-data-contract`) — it just ran one step too late, after a green
      // build had been handed to a human. Same carve-out as ship's: a
      // cross-compiled artifact is not runnable HERE, and that is not a defect.
      const smoke = await smokeRunArtifact(compileTarget, cfg.targetTriple);
      if (smoke) {
        console.error(smoke);
        return false;
      }
      await warnBuildToolsIn(compileTarget, keepPackages, cfg.platform);
      compiled(compileTarget, root);
      return true;
    },
    graphRoots,
    keepPackages,
    cfg.platform,
  );

  return ok;
}

/** Why the freshly compiled `bin` is not a runnable program, or null when it
 *  is. Cross-compiled targets are skipped: they are not runnable on THIS
 *  machine, which is not a defect.
 *
 *  `probe` is the flag the artifact is asked — the one path the TARGET
 *  guarantees terminates. `--version` for a binary whose entry is `aio.run()`
 *  (aio answers it before anything boots); `--help` for the `cli` target,
 *  whose entry is the app's own program and may parse its own argv first —
 *  `aio/cli`'s `args()` answers `--help` unconditionally, but forwards
 *  `--version` when the spec declares none, and a spec with `commands:` then
 *  refuses with "missing command" (exit 2) for a binary that is perfectly
 *  fine. Exported for the CLI builder and for the test that pins the probe. */
export async function smokeRunArtifact(
  bin: string,
  targetTriple?: string,
  probe: readonly string[] = ["--version"],
): Promise<string | null> {
  if (targetTriple && targetTriple !== Deno.build.target) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  const shown = `${bin} ${probe.join(" ")}`;
  try {
    const out = await new Deno.Command(bin, {
      args: [...probe],
      stdout: "piped",
      stderr: "piped",
      signal: ac.signal,
    }).output();
    if (out.success) return null;
    const tail = new TextDecoder().decode(out.stderr).trim().split("\n")
      .slice(-4).join("\n       ");
    // The path diagnosis only where it can be the cause: said of a plain
    // path, it sent people moving a project whose real error (a missing
    // import-map entry, a throwing top level) sat right above it.
    return `✗ ${bin} compiled, but does not run: \`${shown}\` exited ` +
      `${out.code}.\n       ${tail}\n` +
      `       This is a BROKEN BUILD. ` +
      (/[^\x21-\x7e]/.test(resolve(bin))
        ? `A path containing a space or a non-ASCII character is the known ` +
          `cause (the embedded npm paths are percent-encoded twice and ` +
          `resolve to nothing) — move the project to a plain-ASCII path with ` +
          `no spaces and rebuild.`
        : `The artifact's own error is above this line.`);
  } catch (e) {
    return `✗ ${bin} compiled, but could not be executed at all (${
      e instanceof Error ? e.message : e
    }). This is a BROKEN BUILD.`;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the bundle that is about to be embedded and say which of the asset
 *  URLs it names the artifact will not be able to answer. See
 *  `unservableAssetRefs` for the rule; this is only the I/O around it. */
async function warnUnservableAssets(
  root: string,
  dist: string,
  hasDist: boolean,
  entry: string,
  assets: string[],
): Promise<void> {
  if (!hasDist) return; // no bundle to read — nothing to check
  let bundle = "";
  for (const f of [BUNDLE_JS, APP_STYLE]) {
    bundle += await Deno.readTextFile(join(dist, f)).catch(() => "");
  }
  if (!bundle) return;
  const urls = assetUrlsIn(bundle);
  if (!urls.length) return;
  const bad = unservableAssetRefs({
    urls,
    included: assets.filter((a) => a !== "--include"),
    // The app dir a browser URL resolves against is the ENTRY'S directory —
    // the same rule the runtime applies (`baseDirCandidates`). Asking a
    // different question here than the server asks is how the two disagree.
    appDir: relative(root, dirname(join(root, entry))) || ".",
    hasDist,
    exists: (rel) => {
      try {
        Deno.statSync(join(root, rel));
        return true;
      } catch {
        return false;
      }
    },
  });
  for (const b of bad) {
    console.warn(
      b.why === "missing"
        ? `${HEY} the bundle requests ${b.url} and ${b.rel} does not exist — ` +
          `that URL 404s in dev and in the artifact.`
        : `${HEY} the bundle requests ${b.url}, which resolves to ${b.rel} — ` +
          `a file the dev server serves and this binary will NOT contain. ` +
          `Embed it: add "compile": { "include": ["${b.rel}"] } to deno.json ` +
          `(or inline the asset). Without it the URL works in \`deno task ` +
          `dev\` and is a broken link in every shipped artifact.`,
    );
  }
}

/** Runtime flags for the generated systemd unit.
 *
 *  These MUST be flags the compiled binary actually parses — a unit is copied
 *  verbatim into /etc/systemd/system, so a wrong flag is only discovered as a
 *  crash loop on the user's server. `--headless` is a BUILD flag with no
 *  runtime counterpart; the runtime spelling for "server, no UI" is
 *  `--client=server-only`. Shipping `--headless` meant the service started in
 *  the default (electron) client mode instead. Pure, so the unit's contract is
 *  unit-testable against the CLI's known flags. */
export function serviceExecFlags(
  opts: { doRemote: boolean; doHeadless: boolean; port?: number },
): string[] {
  // No invented default. `--port=3000` was written into every unit that named
  // no port, and `--port` outranks everything (`--port` > `AIO_PORT` >
  // `aio.run({ port })`), so an app that declared `port: 8123` was installed
  // as a service on 3000 — its clients, configured for 8123, found nothing.
  // Without the flag the runtime's own chain decides, exactly as it does when
  // the binary is started by hand.
  const flags = opts.port !== undefined ? [`--port=${opts.port}`] : [];
  if (opts.doRemote) flags.push("--expose");
  if (opts.doHeadless) flags.push("--client=server-only");
  return flags;
}

/** What a service unit binds when neither `build.server` nor the app names a
 *  port — the number every unit said before it stopped pinning one, so an
 *  installed fleet's clients keep finding it. */
const SERVICE_DEFAULT_PORT = 3000;

/** The port a service unit should pin: the one `build.server` names
 *  explicitly (`relay.example:8443`), else undefined — the unit then leaves
 *  the port to the runtime. `build.server` is where the clients of this build
 *  were told the server listens, so a service that bound anything else would
 *  ship a fleet that cannot reach itself. A scheme's default port (`https://x`)
 *  names none: `URL.port` is empty for it. */
export function servicePort(
  bakedServer: string | null | undefined,
): number | undefined {
  if (!bakedServer) return undefined;
  const p = new URL(bakedServer).port;
  return p ? Number(p) : undefined;
}

/** A value safe to follow `Key=` in a unit that expands specifiers.
 *
 *  `%` starts a specifier in `Description=`, `User=` and `Environment=`
 *  (`%h`, `%n`…), so a title or a path with a literal `%` was silently
 *  rewritten by systemd, or refused as an unknown specifier. */
export function systemdSpecifierEscape(v: string): string {
  return v.replace(/%/g, "%%");
}

/** One `Environment=` assignment, quoted the way systemd reads it.
 *
 *  Unquoted, the value ends at the first space: `Environment=HOME=/home/a b`
 *  is two assignments, and `b` is not one — `systemd-analyze verify` reports
 *  "Invalid environment assignment" and the variable is never set, so the app
 *  resolved its data directory from no `HOME` at all. Inside double quotes
 *  systemd applies C-style unescaping, so `\` and `"` are escaped; control
 *  characters are flattened (a newline would start a new directive). */
export function systemdEnvAssignment(key: string, value: string): string {
  const inner = systemdSpecifierEscape(`${key}=${value}`)
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `Environment="${inner}"`;
}

/** Write a systemd .service unit file for the compiled binary. */
export async function writeServiceFile(cfg: BuildConfig): Promise<void> {
  const { binaryName, appTitle, doRemote, doHeadless } = cfg;
  // The artifact on disk is `binaryName` only on the host platform; a
  // cross-compiled server target ships `binaryName-<platform>`, and a unit
  // that said `cp binaryName` named a file the build never produced — a
  // service that fails on the target's first boot, the one place the
  // operator is not watching. The unit is installed under the plain name,
  // so ExecStart keeps it; only the copy's SOURCE is the artifact.
  const artifact = artifactName(binaryName, cfg.platform);
  // systemd is Linux-only: a unit for a Windows .exe or a Mach-O binary names
  // an install path that host does not have. Written anyway, every platform's
  // unit was `<name>.service`, so `--platforms=host,windows` on a server
  // target collided in the fleet's dist/ and the whole build died after
  // compiling everything.
  if (cfg.os === "windows" || cfg.os === "darwin") {
    console.log(
      `· no systemd unit for the ${cfg.platform} binary — systemd is Linux-only`,
    );
    return;
  }
  // BUILD-MACHINE IDENTITY, and the unit is copied verbatim to a server.
  //
  // `User=` and `HOME=` were taken from the build environment and written as
  // though they were facts about the target. They are not: build as `dev`,
  // install on a host with no `dev` account, and systemd refuses the unit with
  // "Failed to determine user credentials". Same class as a compiled binary
  // serving `<cwd>/src` — a value that was true where the command was TYPED,
  // applied to a machine that lives somewhere else.
  //
  // The `?? "root"` was the dangerous half. A build with no `$USER` — a
  // container, a CI runner, i.e. the normal release pipeline — silently
  // emitted `User=root`, so the operator's service ran the app as root
  // because of where it was BUILT. aio does not know who should run this
  // service and must not guess; the placeholder fails the unit closed, with a
  // name that says what to do, which is the safe direction to be wrong in.
  const buildUser = Deno.env.get("USER");
  const user = buildUser ?? "REPLACE-ME";
  const home = Deno.env.get("HOME") ?? `/home/${user}`;
  if (!buildUser) {
    console.warn(
      `${HEY} this build has no $USER, so the generated ${binaryName}.service ` +
        `cannot name the account to run as. It carries \`User=REPLACE-ME\`, ` +
        `which systemd refuses until you set it — deliberately, rather than ` +
        `defaulting to root because of how the build was run.`,
    );
  }
  // `?? "."` keeps a hand-built config (a test, a custom script) writing into
  // the cwd exactly as it did before --out= existed.
  // Named like the binary it runs: a cross-built `linux-arm64` unit beside
  // the host's is `<name>-linux-arm64.service`, not a second `<name>.service`.
  const serviceFile = join(
    cfg.outDir ?? cfg.root ?? ".",
    `${artifact}.service`,
  );
  const port = servicePort(cfg.bakedServer);
  const execFlags = serviceExecFlags({ doRemote, doHeadless, port });
  // With no port of its own to pin, the unit still owes the service a STABLE
  // one. Leaving it to the runtime alone bound a fresh random port on every
  // restart (:49167, then :57074 — no client finds that twice), and `--port`
  // or `AIO_PORT` would outrank a declared `aio.run({ port })` again. The
  // chain's bottom rung (`envDefaultPort`) is the one that says "this, unless
  // the app declares its own".
  const defaultPortLine = port === undefined
    ? `# No --port above: the app's own port wins (aio.run({ port }), or
# AIO_PORT). This is only what it binds when it declares none — without it a
# restart would come up on a different random port.
${systemdEnvAssignment(DEFAULT_PORT_ENV, String(SERVICE_DEFAULT_PORT))}
`
    : "";
  if (port === undefined) {
    console.warn(
      `${HEY} ${artifact}.service names no --port: the service binds the ` +
        `port the app declares (aio.run({ port }) or $AIO_PORT), and ` +
        `${SERVICE_DEFAULT_PORT} when it declares none ` +
        `(${DEFAULT_PORT_ENV}=${SERVICE_DEFAULT_PORT} in the unit). To pin ` +
        `it, set "build": { "server": "host:port" } in deno.json, or edit ` +
        `that line.`,
    );
  }
  // systemd units are line-oriented: a newline in the title starts a new
  // DIRECTIVE. `"title": "My App\nExecStart=/bin/sh -c '…'\nUser=root"` in
  // deno.json therefore wrote a unit that ran something else, as root, on the
  // machine the operator installs it on. `binaryName` is slugified;
  // `appTitle` is free text and must be flattened the same way
  // build-electron.ts already flattens displayName for .desktop files.
  //
  // `--name=` first: it is how a per-target `name` reaches this build, and a
  // `relay` target's unit read `Description=spapp (aio)` — the PROJECT's
  // title, on the unit of a different app. A per-target `title`
  // (`--display-name=`) is already `appTitle` and wins over both.
  const named = Deno.args.find((a) => a.startsWith("--name="))?.slice(7);
  const hasDisplay = Deno.args.some((a) => a.startsWith("--display-name="));
  const safeTitle = ((hasDisplay && appTitle) || named || appTitle ||
    binaryName).replace(
      // deno-lint-ignore no-control-regex
      /[\u0000-\u001f\u007f]/g,
      " ",
    ).trim();
  // COMMENTS ON THEIR OWN LINES, never after a directive. systemd has no
  // trailing-comment syntax: a `#` after `ExecStart=` is part of the command
  // line, so `# adjust path after install` shipped as FIVE extra argv words
  // (`#`, `adjust`, `path`, `after`, `install`) to every service the build
  // wrote, and `RestartPreventExitStatus=143   # aio.stop() …` made systemd log
  // "Failed to parse value, ignoring: #" six times on every daemon-reload
  // (measured with `systemd-analyze verify`, systemd 255). aio's own parser
  // passes bare words through to the app, so the service booted and nothing
  // said the unit was wrong — a broken file that happens to work.
  const unit = `[Unit]
Description=${systemdSpecifierEscape(safeTitle || binaryName)} (aio)
After=network.target

[Service]
Type=simple
# Adjust the path after install (sudo cp ${artifact} /usr/local/bin/${binaryName}).
ExecStart=/usr/local/bin/${binaryName} ${execFlags.join(" ")}
# Restart=always, not on-failure: an aio app that updates ITSELF stops with a
# clean exit code 0 on purpose, so the supervisor starts the new binary. Under
# on-failure systemd treats that as "it meant to stop" and leaves the service
# DOWN — every successful auto-update took the app offline until someone
# noticed.
Restart=always
# aio.stop() exits 143 to stay down.
RestartPreventExitStatus=143
RestartSec=5
# BUILD-MACHINE VALUE — this came from the machine that built the binary, not
# from the host you are installing on. Set it to the account this service
# should run as (aio has no way to know, and will not guess).
User=${systemdSpecifierEscape(user)}
# Tells the app it is supervised, so it EXITS after an update instead of
# spawning its own successor (two processes fighting over one app lock). systemd
# sets INVOCATION_ID, which aio also honours; this is the explicit spelling for
# any other supervisor.
Environment=AIO_SUPERVISED=1
${defaultPortLine}# Also a build-machine value — the app's data directory hangs off it.
${systemdEnvAssignment("HOME", home)}

[Install]
WantedBy=multi-user.target
`;
  await Deno.writeTextFile(serviceFile, unit);
  // Under the fleet this path is STAGED — it is moved to
  // `dist/<name>-<version>.service` next — so it must not read as the
  // artifact (`✓ …/app.service` named a file gone by the build's end). The
  // one "this file now exists" line says which of the two it is.
  compiled(serviceFile, cfg.root ?? Deno.cwd());
  // Under the fleet (every CLI build) these files are about to be renamed into
  // `dist/` as `<name>-<version>…`, so steps naming them here would name files
  // that no longer exist — the fleet prints them after placement instead
  // (`placeServiceUnit` in build-all.ts).
  if (Deno.env.get(BUILD_VERSION_ENV) !== undefined) return;
  console.log(`
  Install:
    sudo cp ${artifact} /usr/local/bin/${binaryName}
    sudo cp ${serviceFile} /etc/systemd/system/${binaryName}.service
    sudo systemctl enable --now ${binaryName}

  Manage:
    sudo systemctl status ${binaryName}
    journalctl -u ${binaryName} -f
`);
}
