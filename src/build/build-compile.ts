/**
 * @module
 * Build compile — the deno compile step: v8 flags, argv, the compile run, the
 * smoke run and the unembedded-read refusal. The dev-only exclusion
 * (build-dev-exclude.ts), the include set (build-includes.ts) and the service
 * files (build-service.ts) live beside it and are re-exported here, so every
 * name this module ever exported still imports from this path.
 */
import { APP_STYLE, BUNDLE_JS } from "../server/app-files.ts";
import { readDenoJson, readDenoJsonSync } from "../server/deno-json.ts";
import "../server/pid-lock.ts"; // load order: evaluated here, as before the split
import "../server/paths.ts"; // load order: evaluated here, as before the split
import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import "@std/path/posix"; // load order: evaluated here, as before the split
import { artifactName } from "./platforms.ts";
import { BUILD_STAMP_FILE } from "./build-version.ts";
import "./build-journals.ts"; // load order: evaluated here, as before the split
import "../server/app-version.ts"; // load order: evaluated here, as before the split
import "../server/aio-cli.ts"; // load order: evaluated here, as before the split
import {
  compiledMaxHeapMB,
  declaredMaxHeapOf,
  physicalMemoryBytes,
} from "../server/heap-policy.ts";
import type { BuildConfig } from "./build-config.ts";
import { HEY, NO } from "../diagnostics/fmt.ts";
import "../diagnostics/code-mask.ts"; // load order: evaluated here, as before the split
import { compiled, summaryNote } from "./build-say.ts";
import { electronStagingDir, freshElectronStaging } from "./build-electron.ts";
import { WINDOWS_ICON_FILE, writeWindowsIcon } from "./build-helpers.ts";
import { warnMachineBoundImports } from "./machine-bound-imports.ts";
import { unembeddedReadMessage, unembeddedReads } from "./unembedded-reads.ts";
import { minifyDeclared, runCompile } from "./minify-server.ts";
import { reportEmbedded, warnBuildToolsIn } from "./artifact-audit.ts";
import {
  compileModuleRoots,
  denoInfoGraphs,
  includeDirModules,
  keepPackagesDeclared,
  MODULE_FILE_RE,
  withDevExcluded,
} from "./build-dev-exclude.ts";
import {
  ASSET_SKIP_DIRS,
  assetIncludes,
  assetUrlsIn,
  dbWorkerInclude,
  unservableAssetRefs,
} from "./build-includes.ts";

// ── Dev-only exclusion — ./build-dev-exclude.ts, re-exported ──

export {
  _linkJournal,
  collectTrim,
  compileModuleRoots,
  denoEntryFromLocalPath,
  denoEntryNameOf,
  denoEntryOfRel,
  denoNmPackageName,
  devOnlyClosure,
  devOnlyPackageByName,
  droppedDependencies,
  droppedWarnings,
  emptiedScopeDirs,
  excludedEntries,
  foreignEntries,
  importedForeign,
  includeDirModules,
  installLockArgs,
  isTrimmedDir,
  isTrimmedFile,
  keepPackagesDeclared,
  keptByFamily,
  lateLinkExcludes,
  packageNameOfNpmId,
  reachedDenoRels,
  reachedNpmPackages,
  reachedOutsideBuildTooling,
  readDenoNmGraph,
  recoverInterruptedLinks,
  siblingLinkExcludes,
  TRIM_DIRS,
  unreachableNpmEntries,
  withDevExcluded,
} from "./build-dev-exclude.ts";
export type { DenoInfoGraph } from "./build-dev-exclude.ts";

// ── Compile includes — ./build-includes.ts, re-exported ──

export {
  assetIncludes,
  assetMounts,
  assetUrlsIn,
  dbWorkerInclude,
  isServerModule,
  localModuleGraph,
  serverModulePlan,
  serverWorkerFiles,
  unservableAssetRefs,
  workerUrlSpecs,
} from "./build-includes.ts";

// ── Service files — ./build-service.ts, re-exported ──

export {
  LAUNCHD_LOOP,
  launchdPlist,
  serviceExecFlags,
  servicePort,
  systemdEnvAssignment,
  systemdSpecifierEscape,
  windowsTaskScript,
  writeServiceFile,
} from "./build-service.ts";

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
        join(dirname(electronStagingDir(root)), WINDOWS_ICON_FILE),
        {
          root,
          appDir: cfg.appDir,
          name: cfg.appTitle ?? binaryName,
          id: binaryName,
          warn: summaryNote,
        },
      ),
    }
    : undefined;

  // A headless target builds no bundle: its dist/ is worth embedding only
  // when it HOLDS one (a fleet with a browser target beside it). The empty
  // dist/ a rebuild leaves behind was embedded too, and the binary then warned
  // on every boot that it was "packaged with nothing to serve".
  const hasDist = await Deno.stat(cfg.doHeadless ? join(dist, BUNDLE_JS) : dist)
    .then((s) => cfg.doHeadless ? s.isFile : s.isDirectory, () => false); // aio-ok: absent = nothing to embed

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
    roots: compileModuleRoots(
      configEntry,
      [...workerInclude, ...assets],
      await includeDirModules(root),
    ),
    installRoots: compileModuleRoots(configEntry, [
      ...workerInclude,
      ...assets,
    ]),
  };
  const argvOpts = {
    hasDist,
    workerInclude,
    assets,
    v8Flags,
    stamp: BUILD_STAMP_FILE,
    out: compileTarget,
    entry: configEntry,
    target: cfg.targetTriple,
    runtimeArgs: bakedClientArgs(cfg),
    windowsGui,
  };
  // Judged against the compile's OWN argv — what it embeds is what is covered.
  if (
    !(await refuseUnembeddedReads(
      root,
      _compileArgv({ ...argvOpts, excludes: [] }),
      graphRoots.roots,
    ))
  ) return false;
  const minify = await minifyDeclared(root);
  const keepPackages = await keepPackagesDeclared(root);
  const ok = await withDevExcluded(
    nmDir,
    async (excludes) => {
      const result = await runCompile(
        root,
        _compileArgv({ ...argvOpts, excludes }),
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
      // `--analyze`: the bundle report says where the PAGE's bytes went; this
      // is the same question for the binary.
      if (Deno.args.includes("--analyze")) await reportEmbedded(compileTarget);
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

/** Stop a compile whose server modules read a file the binary will not hold.
 *  See `unembeddedReads` for the rule; this is only the I/O around it.
 *
 *  `argv` is the `deno compile` argv about to run and `roots` its module
 *  roots ({@link compileModuleRoots}) — coverage is read from those two, so
 *  it is the compile's own answer. Scanned: the app's own modules in that
 *  graph (never `node_modules`, never a vendored framework — the dirs
 *  `assetIncludes` skips).
 *
 *  A read written INSIDE a `Deno.*` read call fails the build: the module
 *  ships, the file does not, so the read is certain to throw in every
 *  artifact. The heuristic forms (a name bound earlier,
 *  `join(import.meta.dirname, …)`, a bare `stat`), a read whose absence the
 *  code handles (a `.catch`, a `try/catch`, a `Deno.build.standalone` test),
 *  a `fetch` in a `*.server.ts` module and a target that does not exist at
 *  all are warnings. A `fetch` anywhere else is the browser's and is not
 *  judged.
 *  Returns false when the build must stop. `@internal`. */
export async function refuseUnembeddedReads(
  root: string,
  argv: readonly string[],
  roots: readonly string[],
): Promise<boolean> {
  const graphs = await denoInfoGraphs(root, roots);
  if (!graphs) {
    console.warn(
      `${HEY} could not read the module graph — runtime file reads were NOT ` +
        `checked against what this binary embeds`,
    );
    return true;
  }
  const norm = (p: string) => p.split("\\").join("/");
  // Real path AND the path as spelled — see `localModuleGraph`.
  const bases = [await Deno.realPath(root), resolve(root)];
  const relOf = (abs: string): string | undefined => {
    const rel = bases.map((b) => relative(b, abs))
      .find((r) => !r.startsWith("..") && !isAbsolute(r));
    return rel === undefined ? undefined : norm(rel);
  };
  const graph = graphs.flatMap((g) => g.modules ?? []).flatMap((m) => {
    const rel = m.local ? relOf(m.local) : undefined;
    return rel === undefined ? [] : [rel];
  });
  const modules = [...new Set(graph)]
    // aio-ok: path-split — normalised to `/` by `norm`
    .filter((p) => !p.split("/").some((seg) => ASSET_SKIP_DIRS.has(seg)))
    .filter((p) => MODULE_FILE_RE.test(p))
    .flatMap((path) => {
      try {
        return [{ path, content: Deno.readTextFileSync(join(root, path)) }];
      } catch {
        return []; // aio-ok: unreadable here — the compile reports it, with the real cause
      }
    });
  const included = argv.flatMap((a, i) =>
    argv[i - 1] === "--include" ? [relOf(resolve(root, a)) ?? []].flat() : []
  );
  let declared: string[] = [];
  try {
    const inc = ((await readDenoJson(root))?.config as
      | { compile?: { include?: unknown } }
      | undefined)?.compile?.include;
    if (Array.isArray(inc)) declared = inc.filter((x) => typeof x === "string");
  } catch {
    // aio-ok: said by assetIncludes' compile.include read, which ran first
  }
  const found = unembeddedReads({
    modules,
    included: [...included, ...graph],
    kind: (rel) => {
      try {
        return Deno.statSync(join(root, rel)).isDirectory ? "dir" : "file";
      } catch {
        return null;
      }
    },
  });
  let ok = true;
  for (const f of found) {
    const msg = unembeddedReadMessage(f, declared);
    if (f.certain) {
      ok = false;
      console.error(`${NO} ${msg}`);
    } else console.warn(`${HEY} ${msg}`);
  }
  return ok;
}
