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

/** Compile a CLI binary. Exits process on completion or error. */
export async function buildCli(cfg: BuildConfig): Promise<void> {
  const { root, binaryName, configEntry, doRemote } = cfg;
  const nmDir = join(root, "node_modules");

  // CLI apps don't use App.tsx/React — compile the Deno entry point directly
  const cliEntry = doRemote ? "src/client.ts" : configEntry;
  try {
    await Deno.stat(join(root, cliEntry));
  } catch {
    console.error(`[cli] \u2717 ${cliEntry} not found`);
    Deno.exit(1);
  }

  // Same platform axis as the main compile path: the artifact is named for
  // the platform it RUNS on (host keeps the bare name), and the triple is
  // passed to deno. Without this a `--platform=windows` CLI build silently
  // produced another host binary under the host's name — two identical files
  // presented as two platforms.
  const cliBase = doRemote ? `${binaryName}-client` : binaryName;
  const cliTarget = artifactName(cliBase, cfg.platform);
  console.log(
    `[cli] compiling ${cliEntry} → ${cliTarget}${
      cfg.targetTriple ? ` (${cfg.platform}, ${cfg.targetTriple})` : ""
    }`,
  );

  // Embed app data assets (.wasm + declared compile.include) — a CLI app can
  // load WASM server-side too, and deno compile can't trace those reads.
  const assets = await assetIncludes(root);

  const ok = await withDevExcluded("cli", nmDir, async (excludes) => {
    const result = await new Deno.Command("deno", {
      args: [
        "compile",
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
    if (result.code === 0) console.log(`[cli] \u2713 ${cliTarget}`);
    return result.code === 0;
  });

  if (!ok) {
    console.error("[cli] \u2717 compile failed");
    Deno.exit(1);
  }
  Deno.exit(0);
}
