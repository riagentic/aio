/**
 * @module
 * Build toolchain — bundles, compiles and packages aio apps for all targets.
 *
 * Flags (CLI) / config fields: `--compile` (binary), `--electron` (AppImage),
 * `--android` (APK), `--client` (aio-client AppImage), `--force` (skip cache).
 *
 * Runnable directly (`deno run -A jsr:@riagentic/aio/build`) or programmatic:
 *
 * ```ts
 * import { build } from "aio/build";
 * await build(); // config from CLI flags + deno.json, like the script form
 * ```
 */
import { readDenoJson } from "./server/deno-json.ts";
import { ok } from "./build/build-say.ts";
import { NO } from "./diagnostics/fmt.ts";
import { fromFileUrl, join } from "@std/path";
import {
  type BuildConfig,
  loadBuildConfig,
  refuseBadBuildArgs,
} from "./build/build-config.ts";
import { appDirs, installRoot } from "./server/app-dirs.ts";
import { BUILD_VERSION_ENV } from "./server/app-version.ts";
import { targetForFlags, TARGETS } from "./build-all.ts";
import { APP_ICON, APP_STYLE, BUNDLE_JS } from "./server/app-files.ts";
import { slugify } from "./server/single-instance-lock.ts";
import { ensureEmbeddedBundle, runBundle } from "./build/build-bundle.ts";
import { buildClient } from "./build/build-client.ts";
import { buildCli } from "./build/build-cli.ts";
import { buildAndroid } from "./build/build-android.ts";
import { buildIos } from "./build/build-ios.ts";
import { runDenoCompile, writeServiceFile } from "./build/build-compile.ts";
import { buildElectron } from "./build/build-electron.ts";
import { resolveElectronVersion } from "./build/electron-runtime.ts";
import { ELECTRON_VERSION_FILE } from "./electron/electron-runtime-fetch.ts";
import {
  BUILD_STAMP_FILE,
  installArtifactName,
  writeBuildStamp,
} from "./build/build-version.ts";
import { VERSION } from "./server/aio-cli.ts";

/**
 * Run the build pipeline. Without `cfg`, configuration is loaded from CLI
 * flags and the project's `deno.json` (same as running the module directly).
 *
 * Note: target-specific paths (`--client`, `--cli`, `--android`, `--electron`)
 * terminate the process via `Deno.exit()` when done — this is a CLI pipeline,
 * not a side-effect-free library call.
 */
export async function build(cfg?: BuildConfig): Promise<void> {
  cfg ??= await loadBuildConfig();
  const {
    root,
    dist,
    doElectron,
    doAndroid,
    doIos,
    doClient,
    doCli,
    doCompile,
    doService,
  } = cfg;

  // `--service` writes a systemd unit for the BINARY this build produces, so
  // on its own it describes a file that will not exist. The pipeline used to
  // accept it: it bundled `dist/app.js`, reached the "nothing left to do"
  // return below (`doCompile` is false), and exited 0 — a successful-looking
  // command that did a fraction of what its flag implies, which is the shape
  // this project refuses everywhere else.

  // ── Step 1: Bundle dist/app.js ───────────────────────────────────────────
  // Skip for targets that don't need browser bundles
  const skipsBundle = doCli || cfg.doHeadless || doClient || doIos ||
    (doAndroid && cfg.doRemote);
  if (!skipsBundle) {
    const mainConfig = (await readDenoJson(root))?.config ?? {};
    await runBundle(cfg, mainConfig);
  } else if (doCompile && !doCli && !doClient && !doAndroid && !doIos) {
    // This target BUILT no bundle but still packages one: `runDenoCompile`
    // passes `--include dist/` whenever dist/ exists, so the binary serves
    // whatever is in there. Verify it is the shape and the version this build
    // is packaging (and not stale) — the stamp used to be read only by the
    // path that rebuilds, never by the path that ships.
    const mainConfig = (await readDenoJson(root))?.config ?? {};
    await ensureEmbeddedBundle(cfg, mainConfig);
  }

  if (!doCompile && !doAndroid && !doIos && !doClient && !doCli) return;

  // ── Stamp THE app version into the artifact ─────────────────────────────
  // `.aio/build-version.json` is embedded by `deno compile` (build-compile's
  // include) and read by the runtime when compiled, so `<bin> --version`, the
  // boot line and `/__aio/health` print the version this build resolved —
  // `-dirty.<hash8>` included. The APK / Xcode project carry it as their
  // versionName instead (build-android.ts). Written for every packaging path,
  // never for a bundle-only build.
  await writeBuildStamp(root, cfg.version, VERSION);
  ok(BUILD_STAMP_FILE, cfg.version.version);

  // ── Bake the Electron version into dist/ ────────────────────────────────
  // A plain compiled binary (`--compile`, not the AppImage) whose client is
  // Electron has to FETCH a runtime on the machine it runs on — it has no
  // node_modules and no deno. Which version is decided here, once, by the
  // build (installed runtime > import-map spec > framework default), and read
  // by the launcher from the embedded dist/. Without this file the binary and
  // the checkout could run two different Electrons, and a desktop app has no
  // business asking its user to `deno task install:electron`.
  if (doCompile && !doCli && !doClient && !doAndroid && !doIos) {
    const version = await resolveElectronVersion(root);
    await Deno.mkdir(dist, { recursive: true });
    await Deno.writeTextFile(
      join(dist, ELECTRON_VERSION_FILE),
      JSON.stringify({ version }) + "\n",
    );
    ok(`dist/${ELECTRON_VERSION_FILE}`, `electron ${version}`);
  }

  // ── aio-client: standalone Electron connect-page AppImage ───────────────
  if (doClient) {
    await buildClient(cfg);
    // buildClient calls Deno.exit(0)
  }

  // ── CLI: compile directly (no browser bundle needed) ────────────────────
  if (doCli) {
    await buildCli(cfg);
    // buildCli calls Deno.exit(0)
  }

  // ── Android: build APK ───────────────────────────────────────────────────
  if (doAndroid) {
    await buildAndroid(cfg);
    // buildAndroid calls Deno.exit(0)
  }
  if (doIos) {
    await buildIos(cfg);
    return; // the project under dist/ios IS the artifact — nothing to compile
  }

  // ── Clean dist/ before compile ───────────────────────────────────────────
  // dist/ is embedded WHOLESALE (`deno compile --include dist/`), so anything
  // left here ships inside the binary — the clean cannot be narrowed to "files
  // this build writes" without shipping the previous target's leftovers. That
  // is why dist/ is staging and never a destination: `--out=` (default: the
  // project root) is where artifacts land, and loadBuildConfig refuses an
  // --out inside dist/ (R-4).
  try {
    for await (const entry of Deno.readDir(dist)) {
      if (
        entry.name === BUNDLE_JS || entry.name === APP_STYLE ||
        entry.name === APP_ICON || entry.name === ELECTRON_VERSION_FILE
      ) continue;
      await Deno.remove(join(dist, entry.name), { recursive: true });
    }
  } catch { /* no dist/ when headless — skip */ }

  // ── Step 2: Compile deno binary ──────────────────────────────────────────
  const compileOk = await runDenoCompile(cfg);
  if (!compileOk) {
    console.error(
      "deno compile failed — its own message is above this line.\n" +
        "       fix: resolve what it names (a module it cannot find is usually " +
        "a server-only import reachable from the entry, or an asset missing " +
        "from deno.json `compile.include`), then re-run `deno task build`.",
    );
    Deno.exit(1);
  }

  // ── Optional: generate systemd .service file ─────────────────────────────
  if (doService) {
    await writeServiceFile(cfg);
  }

  if (!doElectron) return;

  // ── Step 3: Package with bundled Electron ────────────────────────────────
  await buildElectron(cfg);
}

/** Compiling the app's entry yourself (a custom script, a monorepo task, CI)?
 *  These are the two things `deno compile` cannot work out on its own, and both
 *  used to be knowledge locked inside the builder — rediscovered at runtime,
 *  after shipping, as `Module not found: …/db-worker.ts`:
 *
 *  - {@link dbWorkerInclude} — the `--include` args for the SQLite worker.
 *    `new Worker(new URL(…))` is invisible to the module graph, so EVERY
 *    compiled aio binary needs it (persistence always opens the worker DB).
 *  - {@link assetIncludes} — `--include` args for the app's runtime data assets
 *    (`.wasm`, `deno.json`, anything in `compile.include`).
 *  - {@link v8FlagsArg} — `--v8-flags=…` from `compile.v8Flags`. A COMPILED
 *    binary ignores `DENO_V8_FLAGS`, so an app that raises its heap for `deno
 *    run` silently reverts to V8's ~4 GB default once packaged unless the flag
 *    is baked in here.
 *  - {@link compileArgs} — the whole argv, assembled the way aio assembles it.
 *
 * ```ts
 * import { compileArgs, dbWorkerInclude } from "aio/build";
 *
 * const args = compileArgs({
 *   hasDist: true,
 *   workerInclude: dbWorkerInclude(),
 *   assets: await assetIncludes(Deno.cwd()),
 *   v8Flags: await v8FlagsArg(Deno.cwd()),
 *   excludes: [],
 *   out: "myapp",
 *   entry: "src/app.ts",
 * });
 * await new Deno.Command("deno", { args }).output();
 * ```
 */
export {
  assetIncludes,
  compileArgs,
  dbWorkerInclude,
  v8FlagsArg,
} from "./build/build-compile.ts";

// The `aio ship` family (buildShipManifest, generateSigningKey, shipApp,
// verifyShipManifest, ShipManifest) lives on `aio/ship` ONLY — one import path
// per symbol since alpha70 (src/state/removals.ts); `aiol --safe-fix` rewrites
// the old `aio/build` import.
// Least-privilege capability scanner (also used by `aio doctor`).
// `permissionFlags`/`manifestReport` are its internals — reachable for tests
// through src/testing/internal.ts, not from here.
export { type Capabilities, scanCapabilities } from "./build/capabilities.ts";

if (import.meta.main) {
  // `--print-app-tmpdir` answers ONE question and builds nothing: "what TMPDIR
  // should this project's packaged artifact be launched with?" It exists so a
  // launcher (run.sh) never has to re-derive an app's identity in shell — the
  // build already owns the one rule that names the binary, and the compiled
  // binary's appId is that name. A shell-side copy of the rule would silently
  // split an app's address (payload under one directory, data under another)
  // the moment either rule moved.
  // Same idea, the other directory: WHERE a built artifact gets installed.
  // `run.sh` asks instead of hardcoding `~/app`, so the installer, `am remove`
  // and the updater cannot drift into three different opinions about where an
  // app lives.
  if (Deno.args.includes("--print-install-root")) {
    console.log(installRoot());
    Deno.exit(0);
  }
  // Third question of the same family: what is a built artifact INSTALLED as?
  // The answer is a naming rule (strip the version token, strip the arch
  // suffix, keep the app's own name) that `run.sh` and `run.ps1` used to spell
  // out in shell — and the moment the build started stamping versions INTO
  // artifact names, both copies installed `demo-1.2.345.AppImage`, which is an
  // app that renames itself (and its data directory) on every update. Asked
  // here, there is one rule.
  const installNameArg = Deno.args.find((a) =>
    a.startsWith("--print-install-name=")
  );
  if (installNameArg) {
    const n = installArtifactName(installNameArg.slice(
      "--print-install-name=".length,
    ));
    // Three lines, in this order: base, ext, version ("" when the name carries
    // none). A shell reads it with three `read`s and no parsing of its own.
    console.log(n.base);
    console.log(n.ext);
    console.log(n.version ?? "");
    Deno.exit(0);
  }
  if (Deno.args.includes("--print-app-tmpdir")) {
    const cfg = await loadBuildConfig();
    console.log(appDirs(slugify(cfg.binaryName)).app);
    Deno.exit(0);
  }
  // ── ONE BUILD PATH ──────────────────────────────────────────────────
  //
  // A direct `deno run build.ts --compile --electron` used to be a SECOND
  // entry point: it writes `<name>-<arch>.AppImage` into the project root,
  // while `deno task build` runs the fleet, which places
  // `dist/<name>-<version>-<arch>.AppImage`. Two paths, two names for one
  // artifact, and only one of them covered by `test:build`'s 61 cases. The
  // pre-alpha52 scaffold emitted a whole `compile:*` matrix that took the
  // untested one.
  //
  // So a direct invocation resolves its target from the flags it was given
  // (`targetForFlags`, derived from the fleet's own TARGETS table) and runs
  // the fleet for exactly that target. Same placement, same version stamp,
  // same tests, whichever spelling the caller typed.
  //
  // THE FLEET'S OWN CHILDREN MUST NOT RECURSE, and they are already marked:
  // build-all spawns every per-target build with `AIO_BUILD_VERSION` set (it
  // is how one fleet run stamps one version into every artifact). A process
  // that has it is a child — or a parent build that deliberately handed a
  // version down, which is the same contract. Nothing new to remember.
  const _fleetChild = Deno.env.get(BUILD_VERSION_ENV) !== undefined;
  if (!_fleetChild) {
    // EVERY argv refusal first. The delegation below answers "which target is
    // this?", and a generic "that is not a build target" must never stand in
    // for "you passed --electron and --cli", "--nope is not a flag" or
    // "--service compiles nothing" — those name the actual mistake.
    refuseBadBuildArgs(Deno.args);
    const target = targetForFlags(Deno.args);
    // A build flag combination that names no target is REFUSED, not built.
    //
    // Silently falling back to the old single-target path would leave exactly
    // the second code path this delegation exists to close — and its artifact
    // is the one nothing tests: unversioned, in the project root, invisible to
    // `dist/manifest.json` and therefore to `am publish` and every updater.
    // "It built something" is the worst answer here, because the something is
    // unshippable and looks fine.
    // The same vocabulary the matcher uses, derived from TARGETS — a hand-
    // written copy here would decide "is this a build?" differently from
    // "which build is it?", which is one question with two answers.
    const buildVocabulary = new Set(
      Object.values(TARGETS).flatMap((t) => t.flags),
    );
    const buildFlagsGiven = Deno.args.filter((a) => buildVocabulary.has(a));
    if (!target && buildFlagsGiven.length > 0) {
      console.error(
        `${NO} ${buildFlagsGiven.join(" ")} is not a build target.\n` +
          `  Every build goes through the fleet, so one artifact is one name, ` +
          `one version and one manifest entry.\n` +
          `  Targets: ${Object.keys(TARGETS).join(", ")}\n` +
          `  Run:     deno task build --targets=<name>   (or \`am build <name>\`)\n` +
          `  If this came from a pre-alpha52 \`compile:*\` task, \`am fix ` +
          `--migrate-tasks\` rewrites them into the targets they encoded.`,
      );
      Deno.exit(1);
    }
    if (target) {
      // `import.meta.resolve`, NOT `new URL(…, import.meta.url)`. Both would
      // work; only one of them is unambiguous to a reader and to the worker
      // include gate, which treats every `new URL(…, import.meta.url)` in a
      // file that mentions `new Worker(` as a worker module that must be
      // embedded — and this file mentions one in a comment. The value here is
      // a script path for `deno run`, never a module to embed.
      const asPath = (spec: string) =>
        spec.startsWith("file:") ? fromFileUrl(spec) : spec;
      const passthrough = Deno.args.filter((a) =>
        a.startsWith("--entry=") || a.startsWith("--name=") ||
        a.startsWith("--ui=") || a === "--release" || a === "--force" ||
        a === "--allow-server-only"
      );
      const { code } = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          asPath(import.meta.resolve("./build-all.ts")),
          `--targets=${target}`,
          // The fleet spawns THIS module back as its per-target builder, so it
          // must be told where "this module" is — a JSR specifier included.
          `--build-spec=${asPath(import.meta.url)}`,
          ...passthrough,
        ],
        stdout: "inherit",
        stderr: "inherit",
      }).output();
      Deno.exit(code);
    }
  }
  await build();
}
