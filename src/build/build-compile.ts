/**
 * @module
 * Build compile — withDevExcluded symlink manager + deno compile step + systemd service file.
 */
import {
  DENO_JSON_NAMES,
  readDenoJson,
  readDenoJsonSync,
} from "../server/deno-json.ts";
import { isProcessAlive } from "../server/single-instance-lock.ts";
import { dirname, fromFileUrl, isAbsolute, join, relative } from "@std/path";
import { artifactName } from "./platforms.ts";
import {
  compiledMaxHeapMB,
  physicalMemoryBytes,
} from "../server/heap-policy.ts";
import type { BuildConfig } from "./build-config.ts";

/** npm packages the FRAMEWORK only ever needs at BUILD / DEV / TEST time.
 *  None of them is reachable from a compiled binary:
 *   - `esbuild`   — the dev transpiler and the bundler; prod serves `dist/app.js`.
 *   - `electron`  — the npm package is the INSTALLER. A compiled desktop app
 *                   fetches its own Electron runtime (`build/electron-runtime.ts`).
 *   - `happy-dom` — `testUI` and the headless `am surface` route, and
 *                   `server.ts` only wires that route up when `!prod`.
 *
 *  Their TRANSITIVE closure goes too, and that closure is where the weight is:
 *  happy-dom 13 MB, @electron-internal/extract-zip 7 MB, @types/node 2.4 MB,
 *  undici 1.6 MB — 25 MB in a hello-world binary. A name-prefix list could
 *  never have caught them (`@electron-internal+…` does not start with
 *  `@electron+`, and `undici` looks like nobody's dependency), which is why
 *  this is a graph walk over the layout deno already wrote. */
const DEV_ONLY_PACKAGES = ["electron", "esbuild", "happy-dom"];

type SavedLink = { path: string; target: string; isDir: boolean };

/** A `node_modules/.deno` entry name → its package name
 *  (`@electron+get@5.1.0` → `@electron/get`, `immer@10.2.0` → `immer`).
 *  `null` for anything that is not `<pkg>@<version>` — notably the flat
 *  `.deno/node_modules` fallback dir, which is not a package. */
export function denoNmPackageName(dir: string): string | null {
  const at = dir.lastIndexOf("@");
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
    const first = rel.split("/")[0]!;
    return denoNmPackageName(first) ? first : null;
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

/** Temporarily remove dev symlinks, run compile callback, restore symlinks. Returns callback result. */
export async function withDevExcluded(
  tag: string,
  nmDir: string,
  fn: (excludes: string[]) => Promise<boolean>,
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
  let held = false;
  for (let i = 0; i < 600 && !held; i++) { // ~60s, then take it over
    try {
      await Deno.mkdir(nmDir, { recursive: true });
      await Deno.writeTextFile(lock, `${Deno.pid}`, { createNew: true });
      held = true;
    } catch {
      // Someone else is excluding right now. Wait rather than interleave —
      // and if the holder died without cleaning up, take the lock so a stale
      // file cannot wedge every future build.
      try {
        const owner = Number(await Deno.readTextFile(lock));
        // THE liveness decider, not a second copy of it: it knows that EPERM
        // means the pid exists under another account (alive), which a bare
        // try/catch around `Deno.kill` reads as dead.
        if (
          Number.isFinite(owner) && owner !== Deno.pid && !isProcessAlive(owner)
        ) {
          await Deno.remove(lock).catch(() => {}); // holder died mid-build
          continue;
        }
      } catch { /* lock vanished — retry immediately */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await _withDevExcluded(tag, nmDir, fn);
  } finally {
    if (held) await Deno.remove(lock).catch(() => {});
  }
}

async function _withDevExcluded(
  tag: string,
  nmDir: string,
  fn: (excludes: string[]) => Promise<boolean>,
): Promise<boolean> {
  const denoDir = join(nmDir, ".deno");

  // Which `.deno` entries only a dev-only package can reach. The ROOTS are the
  // project's own direct dependencies — the top-level `node_modules/<pkg>`
  // symlinks deno writes for the import map — split into dev-only and real.
  // Reading the roots from the tree (rather than assuming DEV_ONLY_PACKAGES is
  // the whole story) is what makes the walk safe for an app whose own deps
  // happen to share a package with electron or happy-dom.
  const graph = await readDenoNmGraph(denoDir);
  const devRoots: string[] = [];
  const keepRoots: string[] = [];
  for (const link of await _linksIn(nmDir)) {
    const entry = await _denoEntryOf(denoDir, link);
    if (!entry) continue;
    const pkg = denoNmPackageName(entry)!;
    (DEV_ONLY_PACKAGES.includes(pkg) ? devRoots : keepRoots).push(entry);
  }
  const excluded = new Set(devOnlyClosure(graph, devRoots, keepRoots));
  const excludes = [...excluded].map((e) => join(denoDir, e));

  const saved: SavedLink[] = [];
  async function _rm(path: string): Promise<void> {
    try {
      const t = await Deno.readLink(path);
      saved.push({ path, target: t, isDir: false });
      await Deno.remove(path);
    } catch { /* symlink missing */ }
  }
  async function _rmDir(path: string): Promise<void> {
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
      saved.push({ path, target: JSON.stringify(inner), isDir: true });
      await Deno.remove(path, { recursive: true });
    } catch { /* dir missing */ }
  }

  let ok = false;
  try {
    // AIO-226: removal inside try so finally always restores on error.
    //
    // `--exclude` prunes a directory, but deno FOLLOWS a symlink that points
    // into it and re-embeds the target anyway — that is why `.bin/electron`
    // and `.bin/esbuild` alone kept dragging their packages back in. So every
    // link into an excluded dir is held aside for the duration of the compile:
    // the project's own `node_modules/<pkg>`, the flat `.deno/node_modules`
    // fallback, and `.bin/*`. Restored in `finally`, whatever happens.
    for (
      const dir of [nmDir, join(denoDir, "node_modules"), join(nmDir, ".bin")]
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
      `[${tag}] excluding ${excludes.length} dev dirs, removed ${saved.length} symlinks`,
    );

    ok = await fn(excludes);
  } finally {
    for (const { path, target, isDir } of saved) {
      try {
        if (isDir) {
          await Deno.mkdir(path, { recursive: true });
          for (
            const { name, target: t } of JSON.parse(target) as Array<
              { name: string; target: string }
            >
          ) await Deno.symlink(t, join(path, name));
        } else {
          await Deno.mkdir(dirname(path), { recursive: true });
          try {
            await Deno.remove(path);
          } catch { /* already gone */ }
          await Deno.symlink(target, path);
        }
      } catch (e) {
        console.warn(`[${tag}] \u26a0 failed to restore symlink ${path}: ${e}`);
      }
    }
    if (saved.length) console.log(`[${tag}] restored ${saved.length} symlinks`);
  }
  return ok;
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

/** `--include` args for the app's runtime DATA ASSETS that `deno compile` can't
 *  trace — anything loaded via `Deno.readFile(new URL("./x", import.meta.url))`
 *  is invisible to the module graph, so it's missing from the binary/AppImage
 *  unless explicitly embedded. WITHOUT this a WASM app compiles fine but shows
 *  "wasm not available" at runtime (the #1 report). Covers:
 *   1. every `.wasm` in the project (zero-config — WASM is a first-class case);
 *   2. any extra paths the app declares in deno.json `compile.include`
 *      (files or dirs, relative to the project root — for data files, models…).
 *  Returns flat `["--include", "&lt;relpath&gt;", …]` args (deduped, root-relative). */
export async function assetIncludes(root: string): Promise<string[]> {
  const rels: string[] = [];
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
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(dir);
    } catch {
      return;
    }
    for await (const e of entries) {
      if (e.isDirectory) {
        if (ASSET_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile && e.name.endsWith(".wasm")) {
        add(relative(root, join(dir, e.name)));
      }
    }
  };
  await walk(root, 0);

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
        `[compile] ⚠ deno.json could not be read (${e}) — no compile.include applied`,
      );
    }
  }
  if (Array.isArray(decl)) {
    for (const [i, p] of decl.entries()) {
      if (typeof p !== "string" || !p.trim()) {
        throw new Error(
          `[compile] \u2717 deno.json compile.include[${i}] is ${
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
          `[compile] \u2717 deno.json compile.include[${i}] ("${p}") is ` +
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
        `[compile] ⚠ deno.json could not be read (${e}) — no build.v8Flags applied`,
      );
    }
  }
  // `compile` is Deno's own block and it validates strictly, so this spelling
  // never reaches us as a working build — it makes `deno compile` abort with
  // "Failed to parse compile configuration", which names neither the key nor
  // the fix. Say both here instead.
  if (misplaced) {
    throw new Error(
      `[compile] ✗ deno.json has compile.v8Flags — it belongs under aio's ` +
        `"build" block, not "compile" (which is Deno's own, and rejects ` +
        `unknown keys). Move it: "build": { "v8Flags": [...] }`,
    );
  }
  // NOT an early return: an app that declares no v8Flags at all is the common
  // case, and it is exactly the one that needs the heap ceiling added below.
  if (decl !== undefined && !Array.isArray(decl)) {
    throw new Error(
      `[compile] ✗ deno.json build.v8Flags is ${
        JSON.stringify(decl)
      } — it must be an ARRAY of flags, e.g. ["--max-old-space-size=16384"].`,
    );
  }
  const flags: string[] = [];
  for (const [i, f] of (Array.isArray(decl) ? decl : []).entries()) {
    if (typeof f !== "string" || !f.trim()) {
      throw new Error(
        `[compile] ✗ deno.json build.v8Flags[${i}] is ${
          JSON.stringify(f)
        } — every entry must be a non-empty V8 flag string.`,
      );
    }
    const flag = f.trim();
    // Refused rather than repaired: a flag without `--` is silently ignored by
    // V8, so the binary would ship with the default it was meant to change.
    if (!flag.startsWith("--")) {
      throw new Error(
        `[compile] ✗ deno.json build.v8Flags[${i}] ("${f}") must start ` +
          `with "--" — V8 ignores anything else, so the binary would keep the ` +
          `default this was meant to raise.`,
      );
    }
    // The list is comma-joined, so an embedded comma would split one flag into
    // two — both wrong, and neither reported by V8.
    if (flag.includes(",")) {
      throw new Error(
        `[compile] ✗ deno.json build.v8Flags[${i}] ("${f}") contains a ` +
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
    if (note) console.warn(`[compile] \u26a0 ${note}`);
    if (mb !== null) flags.push(`--max-old-space-size=${mb}`);
  }
  return flags.length ? [`--v8-flags=${flags.join(",")}`] : [];
}

/** `memory.maxHeap` from deno.json, when the app states one. */
function declaredMaxHeap(root: string): string | number | undefined {
  try {
    const cfg = readDenoJsonSync(root)?.config ?? {};
    return (cfg as { memory?: { maxHeap?: string | number } })?.memory?.maxHeap;
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
  out: string;
  entry: string;
  /** Cross-compilation triple; omitted when building for the host so deno
   *  uses its own default (and needs no extra runtime download). */
  target?: string;
}): string[] {
  return [
    "compile",
    "-A",
    ...(opts.target ? ["--target", opts.target] : []),
    ...(opts.v8Flags ?? []),
    ...(opts.hasDist ? ["--include", "dist/"] : []),
    ...opts.workerInclude,
    ...opts.assets,
    ...opts.excludes.flatMap((e) => ["--exclude", e]),
    "-o",
    opts.out,
    opts.entry,
  ];
}

/** Run deno compile. Returns true on success. */
export async function runDenoCompile(cfg: BuildConfig): Promise<boolean> {
  const { root, dist, binaryName, configEntry, doElectron } = cfg;
  const nmDir = join(root, "node_modules");

  // Cross builds carry the platform in the name (and .exe on Windows) so a
  // dist/ holding every platform is unambiguous; the host keeps the bare name
  // every existing task and test expects. Electron packages into AppDir and is
  // host-only (loadBuildConfig refuses --electron with a foreign --platform).
  const outName = doElectron
    ? binaryName
    : artifactName(binaryName, cfg.platform);
  // `--out=` (else the project root) is THE artifact destination — dist/ is
  // staging that every build wipes and embeds wholesale, so it is never where
  // a release lands. Orchestrating several single-target builds needs one
  // directory per app; without this, callers staged into dist/ and the next
  // build deleted it (R-4).
  const outDir = cfg.outDir ?? root;
  const compileTarget = doElectron
    ? join(dist, "AppDir", binaryName)
    : join(outDir, outName);
  if (!doElectron) await Deno.mkdir(outDir, { recursive: true });
  if (cfg.targetTriple) {
    console.log(
      `[compile] cross-compiling for ${cfg.platform} (${cfg.targetTriple})`,
    );
  }
  if (doElectron) await Deno.mkdir(join(dist, "AppDir"), { recursive: true });

  let hasDist = false;
  try {
    hasDist = (await Deno.stat(dist)).isDirectory;
  } catch { /* no dist */ }

  const workerInclude = dbWorkerInclude();
  // Embed the app's runtime data assets (.wasm + declared compile.include) —
  // deno compile can't trace `Deno.readFile(new URL(…, import.meta.url))`, so
  // without this a WASM app runs degraded in the binary/AppImage.
  const assets = await assetIncludes(root);
  const v8Flags = await v8FlagsArg(root);
  if (v8Flags.length) console.log(`[compile] ${v8Flags[0]}`);
  if (assets.length) {
    console.log(
      `[compile] embedding ${assets.length / 2} data asset(s): ${
        assets.filter((a) => a !== "--include").join(", ")
      }`,
    );
  }

  const ok = await withDevExcluded("compile", nmDir, async (excludes) => {
    const result = await new Deno.Command("deno", {
      args: compileArgs({
        hasDist,
        workerInclude,
        assets,
        v8Flags,
        excludes,
        out: compileTarget,
        entry: configEntry,
        target: cfg.targetTriple,
      }),
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (result.code === 0) console.log(`[compile] \u2713 ${compileTarget}`);
    return result.code === 0;
  });

  return ok;
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
  const flags = [`--port=${opts.port ?? 3000}`];
  if (opts.doRemote) flags.push("--expose");
  if (opts.doHeadless) flags.push("--client=server-only");
  return flags;
}

/** Write a systemd .service unit file for the compiled binary. */
export async function writeServiceFile(cfg: BuildConfig): Promise<void> {
  const { binaryName, appTitle, doRemote, doHeadless } = cfg;
  const user = Deno.env.get("USER") ?? "root";
  const home = Deno.env.get("HOME") ?? `/home/${user}`;
  // `?? "."` keeps a hand-built config (a test, a custom script) writing into
  // the cwd exactly as it did before --out= existed.
  const serviceFile = join(
    cfg.outDir ?? cfg.root ?? ".",
    `${binaryName}.service`,
  );
  const execFlags = serviceExecFlags({ doRemote, doHeadless });
  // systemd units are line-oriented: a newline in the title starts a new
  // DIRECTIVE. `"title": "My App\nExecStart=/bin/sh -c '…'\nUser=root"` in
  // deno.json therefore wrote a unit that ran something else, as root, on the
  // machine the operator installs it on. `binaryName` is slugified;
  // `appTitle` is free text and must be flattened the same way
  // build-electron.ts already flattens displayName for .desktop files.
  const safeTitle = (appTitle ?? binaryName).replace(
    // deno-lint-ignore no-control-regex
    /[\u0000-\u001f\u007f]/g,
    " ",
  ).trim();
  const unit = `[Unit]
Description=${safeTitle || binaryName} (aio)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/${binaryName} ${
    execFlags.join(" ")
  }  # adjust path after install
# Restart=always, not on-failure: an aio app that updates ITSELF stops with a
# clean exit code 0 on purpose, so the supervisor starts the new binary. Under
# on-failure systemd treats that as "it meant to stop" and leaves the service
# DOWN — every successful auto-update took the app offline until someone
# noticed.
Restart=always
RestartPreventExitStatus=143   # aio.stop() exits 143 to stay down
RestartSec=5
User=${user}
# Tells the app it is supervised, so it EXITS after an update instead of
# spawning its own successor (two processes fighting over one app lock). systemd
# sets INVOCATION_ID, which aio also honours; this is the explicit spelling for
# any other supervisor.
Environment=AIO_SUPERVISED=1
Environment=HOME=${home}

[Install]
WantedBy=multi-user.target
`;
  await Deno.writeTextFile(serviceFile, unit);
  console.log(`[service] \u2713 ${serviceFile}`);
  console.log(`
  Install:
    sudo cp ${binaryName} /usr/local/bin/
    sudo cp ${serviceFile} /etc/systemd/system/
    sudo systemctl enable --now ${binaryName}

  Manage:
    sudo systemctl status ${binaryName}
    journalctl -u ${binaryName} -f
`);
}
