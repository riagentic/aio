/**
 * @module
 * Build bundle — esbuild bundling step, freshness cache check, asset copying.
 */
import { join } from "@std/path";
import { aioBrowserPlugin } from "./esbuild-plugin.ts";
import { makeHttpPlugin } from "./build-integrity.ts";
import type { BuildConfig } from "./build-config.ts";

/** Recursively yields .ts/.tsx/.css mtimes under a directory */
async function* walkSrcFiles(dir: string): AsyncGenerator<number> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        yield* walkSrcFiles(path);
      } else if (entry.isFile && /\.(tsx?|css)$/.test(entry.name)) {
        const s = await Deno.stat(path);
        if (s.mtime) yield s.mtime.getTime();
      }
    }
  } catch { /* no dir — skip */ }
}

/** Checks if dist/app.js is newer than all bundle inputs */
async function isBundleFresh(cfg: BuildConfig): Promise<boolean> {
  const {
    out,
    doForce,
    doAndroid,
    isRemote,
    frameworkSrcDir,
    root,
  } = cfg;
  if (doForce) return false;
  try {
    const outStat = await Deno.stat(out);
    if (!outStat.mtime) return false; // AIO-227: can't verify freshness → rebuild
    const outMtime = outStat.mtime.getTime();

    // Check deno.json + framework source files (skip for remote — JSR version is pinned)
    if (!isRemote) {
      const aioModule = join(
        frameworkSrcDir,
        doAndroid ? "standalone-air.ts" : "browser-air.ts",
      );
      for (
        const f of [
          join(root, "deno.json"),
          aioModule,
          join(frameworkSrcDir, "state/msg.ts"),
          join(frameworkSrcDir, "state/factory.ts"),
          join(frameworkSrcDir, "state/deep-merge.ts"),
          join(frameworkSrcDir, "state/dispatch.ts"),
        ]
      ) {
        const s = await Deno.stat(f);
        if (s.mtime && s.mtime.getTime() > outMtime) return false;
      }
    } else {
      const s = await Deno.stat(join(root, "deno.json"));
      if (s.mtime && s.mtime.getTime() > outMtime) return false;
    }

    // Check all src/ files recursively
    for await (const mtime of walkSrcFiles(join(root, "src"))) {
      if (mtime > outMtime) return false;
    }
    return true;
  } catch {
    return false; /* no dist/app.js — needs build */
  }
}

/** Generate the esbuild entry point code.
 *  Android (standalone WebView) auto-mounts — the generated index.html loads
 *  the bundle as a classic script, so there is no importer to call mount(). */
function makeEntryCode(doAndroid: boolean): string {
  if (doAndroid) {
    return `\
import { mount as _mount } from 'aio/renderer'
import { ensureConnected } from 'aio/air'
import App from './src/App.tsx'
function boot() { ensureConnected(); _mount(document.getElementById('root'), App) }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
`;
  }
  return `\
import { mount as _mount } from 'aio/renderer'
import { ensureConnected } from 'aio/air'
import App from './src/App.tsx'
export function mount(el) { ensureConnected(); _mount(el, App) }
`;
}

/** Run the esbuild bundle step. Exits process on failure. */
export async function runBundle(
  cfg: BuildConfig,
  mainConfig: Record<string, unknown>,
): Promise<void> {
  const {
    out,
    dist,
    root,
    isRemote,
    frameworkSrcDir,
    doAndroid,
  } = cfg;

  const bundleFresh = await isBundleFresh(cfg);

  if (bundleFresh) {
    const s = await Deno.stat(out);
    console.log(
      `[build] \u2713 dist/app.js cached (${
        (s.size / 1024).toFixed(1)
      } KB) — use --force to rebuild`,
    );
  } else {
    // Clean dist/ and rebuild
    try {
      await Deno.remove(dist, { recursive: true });
    } catch { /* no dist — skip */ }
    await Deno.mkdir(dist, { recursive: true });

    // Build import map for esbuild
    const fwEntry = doAndroid ? "standalone-air.ts" : "browser-air.ts";
    const aioEntry = isRemote ? null : join(frameworkSrcDir, fwEntry);
    const aioImports = frameworkSrcDir
      ? {
        "aio/jsx-runtime": join(frameworkSrcDir, "jsx-runtime.ts"),
        "aio/renderer": join(frameworkSrcDir, "air/aio-renderer.ts"),
      }
      : {};
    const buildConfig = {
      compilerOptions: mainConfig.compilerOptions,
      imports: {
        ...(mainConfig.imports as Record<string, string>),
        ...(aioEntry ? { "aio": aioEntry, "aio/air": aioEntry } : {}),
        ...aioImports,
      },
    };
    const buildConfigPath = join(root, "_build.json");
    await Deno.writeTextFile(
      buildConfigPath,
      JSON.stringify(buildConfig, null, 2),
    );

    // Generate temp entry
    const buildEntryPath = join(root, "_build_entry.tsx");
    const entryCode = makeEntryCode(doAndroid);
    await Deno.writeTextFile(buildEntryPath, entryCode);

    // esbuild alias: skip npm:/jsr: specifiers (resolved via node_modules)
    const esbuildAlias: Record<string, string> = {};
    for (
      const [k, v] of Object.entries(
        buildConfig.imports as Record<string, string>,
      )
    ) {
      if (!v.startsWith("npm:") && !v.startsWith("jsr:")) esbuildAlias[k] = v;
    }

    let bundleOk = false;
    try {
      // B-6: pin the EXACT version deno.json pins (esbuild@0.24.2) so dev
      // transpile and prod bundle never resolve a different esbuild than tested.
      // deno-lint-ignore no-import-prefix
      const esbuild = await import("npm:esbuild@0.24.2");
      const jsxConfig = { jsx: "automatic" as const, jsxImportSource: "aio" };

      const result = await esbuild.build({
        entryPoints: [buildEntryPath],
        bundle: true,
        // classic <script> in the WebView HTML — ESM would throw on `export`
        format: doAndroid ? "iife" : "esm",
        platform: "browser",
        target: "esnext",
        outfile: out,
        ...jsxConfig,
        alias: esbuildAlias,
        plugins: isRemote
          ? [aioBrowserPlugin(), makeHttpPlugin(cfg)]
          : [aioBrowserPlugin()],
        nodePaths: [join(root, "node_modules")],
        logLevel: "warning",
      });
      bundleOk = (result.errors?.length ?? 0) === 0;
    } catch (e) {
      console.error(`[build] \u2717 esbuild failed: ${e}`);
    } finally {
      await Deno.remove(buildConfigPath).catch(() => {});
      await Deno.remove(buildEntryPath).catch(() => {});
    }

    if (!bundleOk) {
      console.error("[build] \u2717 bundle failed");
      Deno.exit(1);
    }

    const stat = await Deno.stat(out);
    console.log(
      `[build] \u2713 dist/app.js (${(stat.size / 1024).toFixed(1)} KB)`,
    );
  }

  // Copy style.css to dist/ if it exists
  await Deno.mkdir(dist, { recursive: true });
  const styleSrc = join(root, "src", "style.css");
  try {
    await Deno.stat(styleSrc);
    await Deno.copyFile(styleSrc, join(dist, "style.css"));
    console.log("[build] \u2713 dist/style.css");
  } catch { /* no style.css — skip */ }

  // Copy icon.png to dist/ if it exists
  const iconSrc = join(root, "src", "icon.png");
  try {
    await Deno.stat(iconSrc);
    await Deno.copyFile(iconSrc, join(dist, "icon.png"));
    console.log("[build] \u2713 dist/icon.png");
  } catch { /* no icon.png — skip */ }
}
