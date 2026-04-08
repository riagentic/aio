/**
 * @module
 * Build toolchain — bundles, compiles and packages aio apps for all targets.
 *
 * Flags: `--compile` (binary), `--electron` (AppImage), `--android` (APK),
 * `--client` (aio-client AppImage), `--force` (skip cache).
 *
 * ```ts
 * import { build } from "@riagentic/aio/src/build"
 * ```
 */
import { join } from "@std/path";
import { loadBuildConfig } from "./build-config.ts";
import { runBundle } from "./build-bundle.ts";
import { buildClient } from "./build-client.ts";
import { buildCli } from "./build-cli.ts";
import { buildAndroid } from "./build-android.ts";
import { runDenoCompile, writeServiceFile } from "./build-compile.ts";
import { buildElectron } from "./build-electron.ts";

const cfg = await loadBuildConfig();
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

// ── Step 1: Bundle dist/app.js ─────────────────────────────────────────────
// Skip for targets that don't need browser bundles
if (!doCli && !cfg.doHeadless && !doClient && !(doAndroid && cfg.doRemote)) {
  const mainConfig = JSON.parse(
    await Deno.readTextFile(join(root, "deno.json")),
  );
  await runBundle(cfg, mainConfig);
}

if (!doCompile && !doAndroid && !doClient && !doCli) Deno.exit(0);

// ── aio-client: standalone Electron connect-page AppImage ─────────────────
if (doClient) {
  await buildClient(cfg);
  // buildClient calls Deno.exit(0)
}

// ── CLI: compile directly (no browser bundle needed) ──────────────────────
if (doCli) {
  await buildCli(cfg);
  // buildCli calls Deno.exit(0)
}

// ── Android: build APK ────────────────────────────────────────────────────
if (doAndroid) {
  await buildAndroid(cfg);
  // buildAndroid calls Deno.exit(0)
}

// ── Clean dist/ before compile ────────────────────────────────────────────
try {
  for await (const entry of Deno.readDir(dist)) {
    if (
      entry.name === "app.js" || entry.name === "style.css" ||
      entry.name === "icon.png"
    ) continue;
    await Deno.remove(join(dist, entry.name), { recursive: true });
  }
} catch { /* no dist/ when headless — skip */ }

// ── Step 2: Compile deno binary ────────────────────────────────────────────
const compileOk = await runDenoCompile(cfg);
if (!compileOk) {
  console.error("[compile] \u2717 deno compile failed");
  Deno.exit(1);
}

// ── Optional: generate systemd .service file ──────────────────────────────
if (doService) {
  await writeServiceFile(cfg);
}

if (!doElectron) Deno.exit(0);

// ── Step 3: Package with bundled Electron ─────────────────────────────────
await buildElectron(cfg);
