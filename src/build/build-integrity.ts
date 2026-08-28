/**
 * @module
 * Build integrity — SHA-256 verification for fetched sources + esbuild HTTP plugin.
 * Protects against CDN compromise, MITM, DNS hijack during build.
 */
import { join } from "@std/path";
import { sha256Hex } from "./ship.ts";
import { bundleFrameworkEntries } from "./esbuild-shared.ts";
import type { BuildConfig } from "./build-config.ts";

// ── Integrity verification ────────────────────────────────────────────────────

const _integrityFile = join(Deno.cwd(), ".aio-integrity.json");
let _integrityMap: Record<string, string> | null = null;
let _integrityPromise: Promise<Record<string, string>> | null = null;

async function _sha256(text: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(text));
}

function _loadIntegrityMap(): Promise<Record<string, string>> {
  if (_integrityMap) return Promise.resolve(_integrityMap);
  // AIO-225: deduplicate concurrent loads to prevent race condition
  if (!_integrityPromise) {
    _integrityPromise = (async () => {
      try {
        _integrityMap = JSON.parse(await Deno.readTextFile(_integrityFile));
      } catch {
        _integrityMap = {};
      }
      return _integrityMap!;
    })();
  }
  return _integrityPromise;
}

async function _saveIntegrityMap(): Promise<void> {
  if (!_integrityMap) return;
  await Deno.writeTextFile(
    _integrityFile,
    JSON.stringify(_integrityMap, null, 2) + "\n",
  );
}

export async function verifyIntegrity(
  url: string,
  contents: string,
): Promise<void> {
  const map = await _loadIntegrityMap();
  const hash = await _sha256(contents);
  const expected = map[url];
  if (!expected) {
    // First fetch — record hash
    map[url] = hash;
    await _saveIntegrityMap();
    return;
  }
  if (hash !== expected) {
    throw new Error(
      `[build] Integrity check failed for ${url}\n` +
        `  Expected: ${expected}\n` +
        `  Got:      ${hash}\n` +
        `  The content of this URL has changed since the last build.\n` +
        `  If this is expected (e.g. framework version bump), delete .aio-integrity.json and rebuild.`,
    );
  }
}

// ── esbuild HTTP plugin ───────────────────────────────────────────────────────
// Intercepts 'aio' import → framework URL, then resolves relative imports within it.
// Only used when running from JSR (isRemote=true).

// deno-lint-ignore no-explicit-any
export function makeHttpPlugin(cfg: BuildConfig): any {
  const base = cfg.frameworkBase.href;
  // frameworkBase is `<pkg>/src/` (build-config derives it from this module's
  // own URL); the shared entry table is PACKAGE-ROOT relative.
  const pkgRoot = new URL("../", base).href;
  const entries = bundleFrameworkEntries(cfg.doAndroid);

  return {
    name: "aio-http",
    // deno-lint-ignore no-explicit-any
    setup(build: any) {
      // Every `aio*` specifier → the framework module the bundle needs, fetched
      // from the package this build is running out of. `aio` alone was mapped
      // here; `aio/air` and `aio/renderer` — both imported by the build's OWN
      // generated entry — were not, and a JSR-pinned app's `jsr:` mappings are
      // dropped from esbuild's alias, so nothing else could resolve them.
      build.onResolve(
        { filter: /^aio(\/|$)/ },
        // deno-lint-ignore no-explicit-any
        (args: any) => {
          const rel = entries[args.path];
          // An `aio/*` we do not publish: fall through to default resolution,
          // which fails LOUDLY naming the specifier, rather than fetching a
          // URL that does not exist.
          if (rel === undefined) return undefined;
          const url = new URL(rel, pkgRoot).href;
          return { path: url, namespace: "http-url", pluginData: { url } };
        },
      );
      // Relative imports inside http-url files
      build.onResolve(
        { filter: /^\./, namespace: "http-url" },
        // deno-lint-ignore no-explicit-any
        (args: any) => {
          const url = new URL(args.path, args.pluginData?.url ?? base).href;
          return { path: url, namespace: "http-url", pluginData: { url } };
        },
      );
      // Fetch + integrity-verify any http-url file
      build.onLoad(
        { filter: /.*/, namespace: "http-url" },
        // deno-lint-ignore no-explicit-any
        async (args: any) => {
          const r = await fetch(args.path);
          if (!r.ok) {
            throw new Error(
              `[build] fetch ${args.path} -> HTTP ${r.status} — check the import URL is reachable (network/registry down?) and rebuild`,
            );
          }
          const contents = await r.text();
          await verifyIntegrity(args.path, contents);
          return {
            contents,
            loader: "ts",
            // The framework's own bare npm deps (immer) live on the FILESYSTEM,
            // in the app's node_modules — deno materializes them there for a
            // JSR package's transitive deps. Without a resolveDir esbuild
            // refuses to search the filesystem for a plugin-loaded file at all
            // ("the plugin didn't set a resolve directory"), so every `import
            // { produce } from "immer"` inside the fetched framework failed.
            resolveDir: cfg.root,
            pluginData: { url: args.path },
          };
        },
      );
    },
  };
}
