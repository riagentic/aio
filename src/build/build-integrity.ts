/**
 * @module
 * Build integrity — SHA-256 verification for fetched sources + esbuild HTTP plugin.
 * Protects against CDN compromise, MITM, DNS hijack during build.
 */
import { join } from "@std/path";
import type { BuildConfig } from "./build-config.ts";

// ── Integrity verification ────────────────────────────────────────────────────

const _integrityFile = join(Deno.cwd(), ".aio-integrity.json");
let _integrityMap: Record<string, string> | null = null;
let _integrityPromise: Promise<Record<string, string>> | null = null;

async function _sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  const entry = cfg.doAndroid
    ? (cfg.rendererMode === "aio" ? "standalone-air.ts" : "standalone.ts")
    : (cfg.rendererMode === "aio" ? "browser-air.ts" : "browser.ts");
  const entryUrl = new URL(entry, base).href;

  return {
    name: "aio-http",
    // deno-lint-ignore no-explicit-any
    setup(build: any) {
      // 'aio' → framework entry URL
      build.onResolve(
        { filter: /^aio$/ },
        () => ({
          path: entryUrl,
          namespace: "http-url",
          pluginData: { url: entryUrl },
        }),
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
            throw new Error(`[build] fetch ${args.path} → ${r.status}`);
          }
          const contents = await r.text();
          await verifyIntegrity(args.path, contents);
          return {
            contents,
            loader: "ts",
            pluginData: { url: args.path },
          };
        },
      );
    },
  };
}
