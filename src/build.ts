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
import { join } from "@std/path";
import { type BuildConfig, loadBuildConfig } from "./build/build-config.ts";
import { runBundle } from "./build/build-bundle.ts";
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

  // Remote / thin-client targets are experimental: functional, but not yet
  // field-validated off-box (see docs/build/targets.md). Warn so builders know.
  if (cfg.doRemote || doClient) {
    console.warn(
      "[build] ⚠ remote/thin-client targets are experimental — functional " +
        "but not yet field-validated off-box; behavior may change before 1.0.",
    );
  }

  // ── Step 1: Bundle dist/app.js ───────────────────────────────────────────
  // Skip for targets that don't need browser bundles
  if (!doCli && !cfg.doHeadless && !doClient && !(doAndroid && cfg.doRemote)) {
    const mainConfig = JSON.parse(
      await Deno.readTextFile(join(root, "deno.json")),
    );
    await runBundle(cfg, mainConfig);
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

if (import.meta.main) await build();
