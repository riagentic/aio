/**
 * @module
 * Build CLI — compiles a headless Deno CLI binary (no browser bundle, no Electron).
 */
import { artifactName } from "./platforms.ts";
import { join } from "@std/path";
import {
  assetIncludes,
  compileArgs,
  dbWorkerInclude,
  smokeRunArtifact,
  v8FlagsArg,
  withDevExcluded,
} from "./build-compile.ts";
import { BUILD_STAMP_FILE } from "./build-version.ts";
import type { BuildConfig } from "./build-config.ts";
import { NO } from "../diagnostics/fmt.ts";
import { compiled } from "./build-say.ts";

/** The scaffold's conventional module for a `cli-client` target: a CLI that
 *  talks to a remote aio server, which is a DIFFERENT program from the app's
 *  own entry. It is a default, never an override — see {@link cliEntryFor}. */
const REMOTE_CLI_DEFAULT = "src/client.ts";

/** THE entry this CLI build compiles.
 *
 *  `--cli --remote` used to hardcode `src/client.ts`, unconditionally: a
 *  declared `"cli-client": { "entry": "apps/cli/client.ts" }` was printed in
 *  the banner, validated by build-all and recorded in manifest.json — and then
 *  not compiled. With no `src/client.ts` in the repo the build died claiming
 *  THAT file was missing, naming a path the app never mentions. A declared
 *  entry wins; the convention only fills the gap when nothing was declared.
 *  Pure, so the precedence is a unit test rather than a claim. */
export function cliEntryFor(
  opts: { doRemote: boolean; configEntry: string; entryOverride?: string },
): string {
  if (opts.entryOverride?.trim()) return opts.entryOverride.trim();
  return opts.doRemote ? REMOTE_CLI_DEFAULT : opts.configEntry;
}

/** The `deno compile` argv for a CLI target — THE SAME assembly every other
 *  compiled target uses (`compileArgs`), narrowed to what a CLI has.
 *
 *  It used to be a second, hand-written argv, and the two had drifted in the
 *  way copies do: this one embedded no build stamp and passed no `--v8-flags`.
 *  So a `cli` target built by `deno task build` answered `--version` with
 *  "unknown (compiled binary carries no build stamp — rebuild it with aio's
 *  builder, `deno task build`…)" — advice to run the exact command that had
 *  just produced it — while the `browser` target of the same commit printed
 *  `0.1.2`; and an app's `build.v8Flags` (the ONLY channel into a compiled
 *  binary's heap ceiling, see `v8FlagsArg`) silently did not apply to its CLI.
 *  Pure, so the wiring is a unit test rather than a claim. */
export function cliCompileArgs(opts: {
  doRemote: boolean;
  out: string;
  entry: string;
  assets: string[];
  excludes: string[];
  v8Flags: string[];
  target?: string;
}): string[] {
  return compileArgs({
    hasDist: false, // a CLI serves no browser bundle
    // A remote CLI client talks to a server and opens no database of its own.
    workerInclude: opts.doRemote ? [] : dbWorkerInclude(),
    assets: opts.assets,
    v8Flags: opts.v8Flags,
    excludes: opts.excludes,
    stamp: BUILD_STAMP_FILE,
    out: opts.out,
    entry: opts.entry,
    target: opts.target,
  });
}

/** Compile a CLI binary. Exits process on completion or error. */
export async function buildCli(cfg: BuildConfig): Promise<void> {
  const { root, binaryName, configEntry, doRemote, entryOverride } = cfg;
  const nmDir = join(root, "node_modules");

  // CLI apps don't use App.tsx/React — compile the Deno entry point directly
  const cliEntry = cliEntryFor({ doRemote, configEntry, entryOverride });
  try {
    await Deno.stat(join(root, cliEntry));
  } catch {
    console.error(
      `${NO} ${cliEntry} not found` +
        (cliEntry === REMOTE_CLI_DEFAULT
          ? ` — a remote CLI client compiles ${REMOTE_CLI_DEFAULT} by ` +
            `convention. Create it, or name the module in deno.json: ` +
            `"build": { "targets": { "cli-client": { "entry": "path/to/client.ts" } } }.`
          : ""),
    );
    Deno.exit(1);
  }

  // Same platform axis as the main compile path: the artifact is named for
  // the platform it RUNS on (host keeps the bare name), and the triple is
  // passed to deno. Without this a `--platform=windows` CLI build silently
  // produced another host binary under the host's name — two identical files
  // presented as two platforms.
  const cliBase = doRemote ? `${binaryName}-client` : binaryName;
  const cliTarget = join(
    cfg.outDir ?? root,
    artifactName(cliBase, cfg.platform),
  );
  await Deno.mkdir(cfg.outDir ?? root, { recursive: true });
  // Project-relative: an absolute path here reads as "your artifact is at
  // /home/me/app/app", and under the fleet it is not — it is staged and moved.
  // `compiled()` below says which of the two this run is.
  console.log(
    `compiling ${cliEntry} → ${
      cliTarget.startsWith(root + "/")
        ? cliTarget.slice(root.length + 1)
        : cliTarget
    }${cfg.targetTriple ? ` (${cfg.platform}, ${cfg.targetTriple})` : ""}`,
  );

  // Embed app data assets (.wasm + declared compile.include) — a CLI app can
  // load WASM server-side too, and deno compile can't trace those reads.
  const assets = await assetIncludes(root);
  const v8Flags = await v8FlagsArg(root);
  if (v8Flags.length) console.log(`${v8Flags[0]}`);

  const ok = await withDevExcluded(nmDir, async (excludes) => {
    const result = await new Deno.Command("deno", {
      args: cliCompileArgs({
        doRemote,
        out: cliTarget,
        entry: cliEntry,
        assets,
        excludes,
        v8Flags,
        target: cfg.targetTriple,
      }),
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (result.code !== 0) return false;
    // …and then RUN IT — the same rule `runDenoCompile` applies to every other
    // compiled target, and for the same reason: `deno compile` exiting 0 says
    // nothing about whether the artifact boots. A project path with a space
    // makes the embedded npm paths percent-encoded twice, so the binary dies
    // with ERR_MODULE_NOT_FOUND on every flag, and this target alone still
    // printed ✓ for it. `--help` is the probe (see `smokeRunArtifact`): the
    // `cli` target's entry is the app's own program, and `--help` is the one
    // flag both `aio.run()` and `aio/cli`'s `args()` answer unconditionally.
    // A `cli-client` is skipped — its entry is a program of the app's own
    // design with no flag aio can promise it answers, and a 60 s hang on a
    // client that dials a server is a worse build than an unprobed one.
    if (!doRemote) {
      const smoke = await smokeRunArtifact(cliTarget, cfg.targetTriple, [
        "--help",
      ]);
      if (smoke) {
        console.error(smoke);
        return false;
      }
    }
    compiled(cliTarget, root);
    return true;
  });

  if (!ok) {
    console.error(`${NO} compile failed`);
    Deno.exit(1);
  }
  Deno.exit(0);
}
