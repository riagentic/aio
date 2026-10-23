/**
 * @module
 * A browser module's `new URL("./core_bg.wasm", import.meta.url)` — the
 * wasm-bindgen / Emscripten shape — that only dev can answer.
 *
 * In dev the page loads each module from its own path, so the URL lands
 * beside the source file and the module tree serves it. Every artifact runs
 * the BUNDLE: `import.meta.url` is then `/app.js`, the URL resolves against
 * that, and what a binary, a web build or an APK serves is the bundle plus
 * the deno.json `assets` mounts — nothing else. The WebAssembly compile then
 * fails with "HTTP status code is not ok", in the packaged app only, with
 * every gate green (field report: JotWord §1).
 *
 * ONE decider, read by the build (a warning over the client graph it just
 * bundled) and by `aiol` (the same finding before any build). Pure.
 */

import * as posix from "@std/path/posix";
import { codeText } from "../diagnostics/code-mask.ts";
import { BUNDLE_JS } from "../server/app-files.ts";

/** A deno.json `assets` mount: URL prefix → directory, root-relative. */
export type AssetMount = { prefix: string; rel: string };

/** One reference no artifact can answer. */
export type UnmountedAssetUrl = {
  line: number;
  spec: string;
  /** The file it names, root-relative (`/`-separated). */
  file: string;
  /** The URL the BUNDLE asks for. */
  url: string;
  /** The mount URL the file already has, when it sits inside a mount. */
  mountUrl?: string;
};

/** Specs a bundler resolves itself — modules, not fetched files. */
const MODULE_EXT = /\.(m|c)?[jt]sx?$/;
const URL_RE = /\bnew\s+URL\s*\(\s*/g;

/** deno.json `assets`, as mounts (values that are not strings are skipped —
 *  the build's own `assetMounts` refuses those by name). */
export function mountsOf(assets: unknown): AssetMount[] {
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) return [];
  return Object.entries(assets as Record<string, unknown>).flatMap((
    [prefix, dir],
  ) =>
    typeof dir === "string" && dir.trim()
      ? [{
        prefix: prefix.replace(/\/+$/, ""),
        rel: posix.normalize(dir.trim().replaceAll("\\", "/")).replace(
          /\/+$/,
          "",
        ),
      }]
      : []
  );
}

/** The `new URL("<file>", import.meta.url)` references in browser module
 *  `module` (root-relative) whose file the bundle's URL does not reach
 *  through a mount. `isFile` (root-relative) keeps a typo'd path out — dev
 *  answers that one with a 404 too. */
export function unmountedAssetUrls(opts: {
  module: string;
  src: string;
  mounts: readonly AssetMount[];
  isFile: (rel: string) => boolean;
}): UnmountedAssetUrl[] {
  const code = codeText(opts.src, /\.[jt]sx$/.test(opts.module));
  const out: UnmountedAssetUrl[] = [];
  const dir = posix.dirname(opts.module.replaceAll("\\", "/"));
  for (const m of code.matchAll(URL_RE)) {
    const at = m.index! + m[0].length;
    const lit = /^(['"])([^'"\n]+)\1\s*,\s*import\s*\.\s*meta\s*\.\s*url\b/
      .exec(opts.src.slice(at));
    if (!lit) continue;
    const spec = lit[2]!;
    const bare = spec.split(/[?#]/, 1)[0]!;
    if (MODULE_EXT.test(bare) || /^[a-z][a-z0-9+.-]*:/i.test(bare)) continue;
    const file = posix.normalize(posix.join(dir, bare));
    if (file.startsWith("..") || !opts.isFile(file)) continue;
    const url = new URL(bare, `http://app/${BUNDLE_JS}`).pathname;
    const served = (mt: AssetMount) =>
      // aio-ok: path-split — a bundle-relative URL path, always `/`
      url.startsWith(mt.prefix + "/") &&
      posix.normalize(posix.join(mt.rel, url.slice(mt.prefix.length + 1))) ===
        file;
    if (opts.mounts.some(served)) continue;
    // aio-ok: path-split — a bundle-relative URL path, always `/`
    const home = opts.mounts.find((mt) => file.startsWith(mt.rel + "/"));
    out.push({
      line: opts.src.slice(0, at).split("\n").length,
      spec,
      file,
      url,
      ...(home
        ? { mountUrl: `${home.prefix}/${file.slice(home.rel.length + 1)}` }
        : {}),
    });
  }
  return out;
}

/** A URL the page asks for: a `src`/`href`/`poster`/`srcset` prop, a
 *  `fetch(…)`, `new URL(…)`, `new Audio(…)`/`Image`, a CSS `url(…)` — never
 *  text (`<code>/media/a.txt</code>` is a string too). */
const ROOTED_URL_RE =
  /(?:\b(?:src|href|poster|srcset)\s*:\s*|\b(?:fetch|URL|Audio|Image|url)\s*\(\s*)(["'`]?)(\/[^"'`\s)]+)\1/g;

/** The URLs under a deno.json `assets` mount (`prefixes`, as `/media`) that
 *  the bundle or its stylesheet `code` asks for from the host's ROOT. A
 *  server answers them at the root; a standalone page does not sit there —
 *  an APK's is `/assets/index.html`, a web build's under a sub-path is
 *  `/repo/` — so there each is a 404, with every build and gate green. Pure. */
export function rootedMountUrls(
  code: string,
  prefixes: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(ROOTED_URL_RE)) {
    const u = m[2]!;
    // aio-ok: path-split — a URL path and URL prefixes
    if (prefixes.some((p) => u.startsWith(p + "/"))) out.add(u);
  }
  return [...out].sort();
}

/** The finding as one sentence and its fix. */
export function unmountedAssetUrlMessage(
  module: string,
  f: UnmountedAssetUrl,
): [headline: string, fix: string] {
  return [
    `${module}:${f.line} — new URL("${f.spec}", import.meta.url) loads ` +
    `${f.file}: dev serves it beside the module, but every artifact runs the ` +
    `bundle, where this URL is ${f.url} — and a binary, web build or APK ` +
    `serves only the bundle and the deno.json "assets" mounts. 404 in the ` +
    `packaged app`,
    // Relative to the PAGE, not to "/": a web build under a sub-path
    // (/repo/) finds the mount only that way.
    f.mountUrl
      ? `It is in a mount already: load it by the mount's URL — ` +
        `new URL("${f.mountUrl.slice(1)}", document.baseURI)`
      : `Move it into a mount — deno.json "assets": { "/assets": "./assets" } ` +
        `(one declaration: the server serves it and every build carries it) — ` +
        `and load it by that URL: new URL("assets/${
          posix.basename(f.file)
        }", document.baseURI)`,
  ];
}
