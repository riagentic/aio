/**
 * @module
 * Build CLI — compiles a headless Deno CLI binary (no browser bundle, no Electron).
 */
import { join } from "@std/path";
import { withDevExcluded } from "./build-compile.ts";
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

  const cliTarget = doRemote ? `${binaryName}-client` : binaryName;
  console.log(`[cli] compiling ${cliEntry} → ${cliTarget}`);

  const ok = await withDevExcluded("cli", nmDir, async (excludes) => {
    const result = await new Deno.Command("deno", {
      args: [
        "compile",
        "-A",
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
