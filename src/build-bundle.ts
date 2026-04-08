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
    rendererMode,
    root,
  } = cfg;
  if (doForce) return false;
  try {
    const outStat = await Deno.stat(out);
    if (!outStat.mtime) return false; // AIO-227: can't verify freshness → rebuild
    const outMtime = outStat.mtime.getTime();

    // Check deno.json + framework source files (skip for remote — JSR version is pinned)
    if (!isRemote) {
      const aioModule = doAndroid
        ? join(
          frameworkSrcDir,
          rendererMode === "aio" ? "standalone-air.ts" : "standalone.ts",
        )
        : join(
          frameworkSrcDir,
          rendererMode === "aio" ? "browser-air.ts" : "browser.ts",
        );
      for (
        const f of [
          join(root, "deno.json"),
          aioModule,
          join(frameworkSrcDir, "msg.ts"),
          join(frameworkSrcDir, "factory.ts"),
          join(frameworkSrcDir, "deep-merge.ts"),
          join(frameworkSrcDir, "dispatch.ts"),
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

/** Generate the esbuild entry point code based on target */
async function makeEntryCode(cfg: BuildConfig): Promise<string> {
  const { rendererMode, doAndroid, root, frameworkSrcDir } = cfg;
  if (rendererMode === "aio") {
    return `\
import { mount as _mount } from 'aio/renderer'
import App from './src/App.tsx'
export function mount(el) { _mount(el, App) }
`;
  }
  if (doAndroid) {
    const hasLegacyState = await Deno.stat(join(root, "src/state.ts")).then(
      () => true,
      () => false,
    );
    if (hasLegacyState) {
      return `\
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { initStandalone } from 'aio'
import { initialState } from './src/state.ts'
import { reduce } from './src/reduce.ts'
import { execute } from './src/execute.ts'
import App from './src/App.tsx'
initStandalone(initialState, { reduce, execute })
createRoot(document.getElementById('root')).render(createElement(App))
`;
    }
  }
  // Default: React with mount export
  void frameworkSrcDir; // not used for react mode
  return `\
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import App from './src/App.tsx'
export function mount(el) { createRoot(el).render(createElement(App)) }
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
    rendererMode,
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
    const fwEntry = doAndroid
      ? (rendererMode === "aio" ? "standalone-air.ts" : "standalone.ts")
      : (rendererMode === "aio" ? "browser-air.ts" : "browser.ts");
    const aioEntry = isRemote ? null : join(frameworkSrcDir, fwEntry);
    const reactImports = rendererMode === "aio"
      ? {
        ...(frameworkSrcDir
          ? {
            "aio/jsx-runtime": join(frameworkSrcDir, "jsx-runtime.ts"),
            "aio/renderer": join(frameworkSrcDir, "aio-renderer.ts"),
          }
          : {}),
      }
      : {
        "react": "npm:react@^18",
        "react-dom": "npm:react-dom@^18",
        "react-dom/client": "npm:react-dom@^18/client",
        "react/jsx-runtime": "npm:react@^18/jsx-runtime",
      };
    const buildConfig = {
      compilerOptions: mainConfig.compilerOptions,
      imports: {
        ...(mainConfig.imports as Record<string, string>),
        ...(aioEntry ? { "aio": aioEntry, "aio/air": aioEntry } : {}),
        ...reactImports,
      },
    };
    const buildConfigPath = join(root, "_build.json");
    await Deno.writeTextFile(
      buildConfigPath,
      JSON.stringify(buildConfig, null, 2),
    );

    // Generate temp entry
    const buildEntryPath = join(root, "_build_entry.tsx");
    const entryCode = await makeEntryCode(cfg);
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
      // deno-lint-ignore no-import-prefix
      const esbuild = await import("npm:esbuild@^0.24");
      // Pin React to project root's copy
      const reactAlias: Record<string, string> = {};
      if (rendererMode !== "aio") {
        for (const pkg of ["react", "react-dom", "react/jsx-runtime"]) {
          try {
            const p = join(root, "node_modules", ...pkg.split("/"));
            await Deno.stat(p);
            reactAlias[pkg] = p;
          } catch { /* not installed — skip */ }
        }
      }

      const jsxConfig = rendererMode === "aio"
        ? { jsx: "automatic" as const, jsxImportSource: "aio" }
        : { jsx: "automatic" as const, jsxImportSource: "react" };

      const result = await esbuild.build({
        entryPoints: [buildEntryPath],
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "esnext",
        outfile: out,
        ...jsxConfig,
        alias: { ...esbuildAlias, ...reactAlias },
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
