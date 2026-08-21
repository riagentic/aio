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
import { join } from "@std/path";
import { type BuildConfig, loadBuildConfig } from "./build/build-config.ts";
import { appDirs, installRoot } from "./server/app-dirs.ts";
import { slugify } from "./server/single-instance-lock.ts";
import { ensureEmbeddedBundle, runBundle } from "./build/build-bundle.ts";
import { buildClient } from "./build/build-client.ts";
import { buildCli } from "./build/build-cli.ts";
import { buildAndroid } from "./build/build-android.ts";
import { runDenoCompile, writeServiceFile } from "./build/build-compile.ts";
import { buildElectron } from "./build/build-electron.ts";

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
  if (doService && !doCompile) {
    console.error(
      "[build] \u2717 --service writes a systemd unit for a compiled binary, " +
        "and this build compiles nothing.\n" +
        "       fix: `--compile --service` (the combination the unit file " +
        "describes), or drop --service to build only the bundle.",
    );
    Deno.exit(1);
  }

  // ── Step 1: Bundle dist/app.js ───────────────────────────────────────────
  // Skip for targets that don't need browser bundles
  const skipsBundle = doCli || cfg.doHeadless || doClient ||
    (doAndroid && cfg.doRemote);
  if (!skipsBundle) {
    const mainConfig = (await readDenoJson(root))?.config ?? {};
    await runBundle(cfg, mainConfig);
  } else if (doCompile && !doCli && !doClient && !doAndroid) {
    // This target BUILT no bundle but still packages one: `runDenoCompile`
    // passes `--include dist/` whenever dist/ exists, so the binary serves
    // whatever is in there. Verify it is the shape and the version this build
    // is packaging (and not stale) — the stamp used to be read only by the
    // path that rebuilds, never by the path that ships.
    const mainConfig = (await readDenoJson(root))?.config ?? {};
    await ensureEmbeddedBundle(cfg, mainConfig);
  }

  if (!doCompile && !doAndroid && !doClient && !doCli) return;

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

  // ── Clean dist/ before compile ───────────────────────────────────────────
  // dist/ is embedded WHOLESALE (`deno compile --include dist/`), so anything
  // left here ships inside the binary — the clean cannot be narrowed to "files
  // this build writes" without shipping the previous target's leftovers. That
  // is why dist/ is staging and never a destination: `--out=` (default: the
  // project root) is where artifacts land, and loadBuildConfig refuses an
  // --out inside dist/ (rimote R-4).
  try {
    for await (const entry of Deno.readDir(dist)) {
      if (
        entry.name === "app.js" || entry.name === "style.css" ||
        entry.name === "icon.png"
      ) continue;
      await Deno.remove(join(dist, entry.name), { recursive: true });
    }
  } catch { /* no dist/ when headless — skip */ }

  // ── Step 2: Compile deno binary ──────────────────────────────────────────
  const compileOk = await runDenoCompile(cfg);
  if (!compileOk) {
    console.error("[compile] ✗ deno compile failed");
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

// `aio ship` core: verifiable release manifest — SHA-256 +
// least-privilege capabilities + optional Ed25519 signature over the digest.
export {
  buildShipManifest,
  generateSigningKey,
  shipApp,
  type ShipManifest,
  verifyShipManifest,
} from "./build/ship.ts";
// Least-privilege capability scanner (also used by `aio doctor`).
export {
  type Capabilities,
  manifestReport,
  permissionFlags,
  scanCapabilities,
} from "./build/capabilities.ts";

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
  if (Deno.args.includes("--print-app-tmpdir")) {
    const cfg = await loadBuildConfig();
    console.log(appDirs(slugify(cfg.binaryName)).app);
    Deno.exit(0);
  }
  await build();
}
