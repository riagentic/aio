/**
 * @module
 * Build CLI — compiles a headless Deno CLI binary (no browser bundle, no Electron).
 */
import { artifactName } from "./platforms.ts";
import { join } from "@std/path";
import {
  assetIncludes,
  dbWorkerInclude,
  withDevExcluded,
} from "./build-compile.ts";
import type { BuildConfig } from "./build-config.ts";
import { NO, OK } from "../diagnostics/fmt.ts";

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
  console.log(
    `compiling ${cliEntry} → ${cliTarget}${
      cfg.targetTriple ? ` (${cfg.platform}, ${cfg.targetTriple})` : ""
    }`,
  );

  // Embed app data assets (.wasm + declared compile.include) — a CLI app can
  // load WASM server-side too, and deno compile can't trace those reads.
  const assets = await assetIncludes(root);

  const ok = await withDevExcluded(nmDir, async (excludes) => {
    const result = await new Deno.Command("deno", {
      args: [
        "compile",
        "-q", // the module tree, not diagnostics — see compileArgs()
        "-A",
        ...(cfg.targetTriple ? ["--target", cfg.targetTriple] : []),
        ...(doRemote ? [] : dbWorkerInclude()),
        ...assets,
        ...excludes.flatMap((e) => ["--exclude", e]),
        "-o",
        cliTarget,
        cliEntry,
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (result.code === 0) console.log(`${OK} ${cliTarget}`);
    return result.code === 0;
  });

  if (!ok) {
    console.error("${NO} compile failed");
    Deno.exit(1);
  }
  Deno.exit(0);
}
