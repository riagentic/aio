// Static file serving & virtual route handler — extracted from server.ts
// Handles all HTTP requests (non-WS): HTML pages, transpilation, __aio/* endpoints, static files
import { APP_ICON, BUNDLE_JS, UI_ENTRY } from "./app-files.ts";
import { SERVER_FILE_RE } from "../entries.ts";
import type { CallTimeouts } from "../protocol/protocol-types.ts";
import { extname, join, resolve, SEPARATOR } from "@std/path";
import { formatPrometheus } from "./server-metrics.ts";
import { log } from "../diagnostics/logger-api.ts";
import type { RenderBudget } from "../vitals/types.ts";
import type { VitalsSystem } from "../vitals/mod.ts";
import {
  classifyBrowserError,
  generateDiagnosticHTML,
  generateHTML,
  MIME,
  TEXT_EXTENSIONS,
} from "./server-html.ts";
import type { GraphResult } from "./graph-validator.ts";
import type { UiTheme } from "./aio-types.ts";
import {
  type EsbuildMessage,
  fmtEsbuildError,
  transpile,
} from "./server-transpile.ts";
import { handleTrojan as _handleTrojanRoute } from "./server-trojan.ts";
import { loadVendorImmer } from "./server-vendor.ts";
import { BLOB_ID_RE, BLOB_URL_PREFIX, type BlobStore } from "./blobs.ts";
import { appIconSvg } from "../build/app-icon.ts";

// Framework module URLs — this file lives in src/server/, so entry files at the
// src/ root and folderized modules are one level up. The /__aio/ namespace
// mirrors src/ folder structure so a served module's own relative imports
// (`./vdom.ts`, `../state/signal.ts`) resolve back into /__aio/ unchanged.
const BROWSER_AIR_TS_URL = new URL("../browser-air.ts", import.meta.url);
const AIR_TS_URL = new URL("../air.ts", import.meta.url);
const LISTENERS_TS_URL = new URL("../state/listeners.ts", import.meta.url);
// Base for resolving sub-module imports served under /__aio/ (src/ root).
const AIO_SRC_BASE_URL = new URL("../", import.meta.url);

/** True when a baseDir-relative request path must never be served over HTTP.
 *
 *  `*.server.ts` is aio's documented server-ONLY seam (it holds the code and
 *  secrets that must not reach a client), and dotfiles cover `.env`, `.git/`,
 *  `.aio/` and friends — all of which sat under baseDir and were served
 *  verbatim as text. `.well-known/` stays reachable: it is a public-by-design
 *  path (ACME challenges, app-site association). Pure, so the deny list is
 *  unit-testable without a server.
 *
 *  `prod` extends it to ALL TypeScript source. The dev server transpiles
 *  `.ts`/`.tsx` on demand because the dev shell's import map makes the browser
 *  fetch them by name — that is the whole dev loop. A production page has no
 *  import map at all (see prodHTML): it loads one bundled `/app.js` and never
 *  names a source path. So in prod every `.ts`/`.tsx` under baseDir was
 *  readable, unauthenticated, as `text/plain` — the app's own sources,
 *  comments and constants, served to anyone who guessed `/App.tsx`. Exactly the
 *  reasoning that closed the `/__aio/**.ts` framework-source routes in prod
 *  ("reachable, unauthenticated, and used by nobody"), one file extension
 *  short: `.server.ts` was denied while `secrets.ts` next to it was not. */
export function isProtectedPath(pathname: string, prod = false): boolean {
  const rel = pathname.replace(/^\/+/, "");
  if (!rel) return false;
  const segments = rel.split("/");
  for (const seg of segments) {
    if (seg === ".well-known") continue;
    if (seg.startsWith(".")) return true;
  }
  const last = segments[segments.length - 1] ?? "";
  if (prod && /\.tsx?$/.test(last)) return true;
  return SERVER_FILE_RE.test(last);
}

/** Resolve a `/__aio/<rel>` request to a framework source file, or null.
 *
 *  Fails CLOSED. The route exists to serve aio's own `src/**` modules to the
 *  dev client, and nothing else: `new URL(rel, base)` silently ignores the base
 *  when `rel` is absolute, so an unvalidated segment turned this route into an
 *  arbitrary-file reader (`file:///…`) and an SSRF proxy (`http://internal/…`)
 *  whose response was reflected back as executable JavaScript — in prod too.
 *  Pure, so both the allowed and the rejected shapes are unit-testable. */
export function aioModuleUrl(
  relPath: string,
  base: URL = AIO_SRC_BASE_URL,
): URL | null {
  // Relative, no scheme, no authority, no traversal, no absolute path.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*\.tsx?$/.test(relPath)) return null;
  if (relPath.includes("..") || relPath.includes("//")) return null;
  const url = new URL(relPath, base);
  // Re-check after resolution: the file must live under the framework src/.
  return url.href.startsWith(base.href) ? url : null;
}

/** Safety limits — prevent resource exhaustion */
const SNAPSHOT_MAX_SIZE = 10_000_000; // 10MB — reject oversized snapshot uploads

/** Parse a single-range `Range` header against a resource of `size` bytes.
 *
 *  Returns the byte window `{ start, end }` (end EXCLUSIVE), the string
 *  `"unsatisfiable"` (→ 416 with a Content-Range naming the total size), or
 *  null when the header is absent/malformed/multi-range — per RFC 7233 an
 *  unreadable Range is IGNORED (a full 200), never guessed at. Pure +
 *  exported for tests. */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // malformed or multi-range — serve the full resource
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    // Suffix range: last N bytes.
    const n = Number(rawEnd);
    if (!Number.isSafeInteger(n)) return null;
    if (n === 0 || size === 0) return "unsatisfiable";
    const start = Math.max(0, size - n);
    return { start, end: size };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return "unsatisfiable";
  if (rawEnd === "") return { start, end: size };
  const endIncl = Number(rawEnd);
  if (!Number.isSafeInteger(endIncl) || endIncl < start) return null;
  return { start, end: Math.min(endIncl + 1, size) };
}

/** Dependencies injected from server.ts — no mutable state owned */
export interface StaticDeps {
  prod: boolean;
  debug: (msg: string) => void;
  title: string;
  absBaseDir: string;
  /** Extra READ-ONLY roots the dev server may serve, `"/urlPrefix" → dir`.
   *  A relative dir is resolved ONCE against the process cwd, exactly like
   *  `baseDir` — see `_roots` below. Dev only: prod bundles already follow
   *  relative imports, so this exists solely so the DEV server can serve a
   *  module that lives outside baseDir (two apps in one repo sharing pure
   *  libraries). Every containment guard that protects baseDir applies to each
   *  root unchanged. */
  serveDirs?: Record<string, string>;
  absDistDir: string | null;
  hasCSS: boolean;
  importMap: string; // JSON stringified import map
  noCache: Record<string, string>;
  showStatus?: boolean;
  width?: number;
  height?: number;
  renderBudget?: RenderBudget;
  syncCells?: string[];
  callTimeouts?: CallTimeouts;
  uiEntry?: string; // AIO-8.1
  viewport?: string | false; // AIO-423: ui.viewport override (false = opt out)
  headExtra?: string; // AIO-423: ui.head — verbatim <head> content
  /** ui.lang — the document language every shell carries. */
  lang?: string;
  /** ui.chrome — how much of the desktop window the OS draws. */
  chrome?: "standard" | "themed" | "none";
  /** ui.theme — how much of the default look the shell emits. */
  theme?: UiTheme;
  /** Identity the theme's accent hue is derived from — the appId, so the UI
   *  and the icon are the same colour. */
  themeName?: string;
  // Graph validation state — mutable ref from server.ts (dev only)
  getGraphResult: () => GraphResult | null;
  // Snapshot support
  getSnapshot?: () => string;
  loadSnapshot?: (json: string) => void;
  /** Content-addressed blob store — serves `/__aio/blobs/<id>` (GET/HEAD,
   *  single-range, immutable caching). Auth-gated upstream in server.ts
   *  exactly like every other app resource — see the per-user anonymous
   *  gate there. */
  blobs?: BlobStore;
  // Health endpoint
  getHealth?: () => unknown;
  // Vitals
  vitalsSystem?: VitalsSystem;
  getVitalsExtra: () => {
    payloadStats: Map<
      string,
      { lastPayloadBytes: number; totalBytes: number; count: number }
    >;
    clientBackpressure: Record<string, number>;
    rawState?: Record<string, unknown>;
  };
  // Trojan
  trojan?: { getState: () => unknown };
  getTrojanDeps: () => unknown; // returns TrojanDeps for server-trojan.ts
}

type ErrorEntry = {
  errors: Array<{
    text: string;
    file?: string;
    line?: number;
    col?: number;
    lineText?: string;
  }>;
  ts: number;
};

/** Creates a static file handler bound to the given deps. Internal error tracking is module-private. */
const _startedAt = Date.now();

export function createStaticHandler(deps: StaticDeps): {
  serveStatic: (pathname: string, req?: Request) => Promise<Response>;
  getRecentErrors: () => Array<
    {
      text: string;
      file?: string;
      line?: number;
      col?: number;
      lineText?: string;
    }
  >;
} {
  let lastError = ""; // last transpile error
  const errorMap = new Map<string, ErrorEntry>();
  // Memoized: in prod, is the browser bundle (dist/app.js) actually present?
  // A `--headless` build skips it, but the server still serves the UI shell —
  // which then 404s on /app.js and shows a broken page. We detect that and
  // serve a clear diagnostic at `/` instead.
  let _uiBundlePresent: boolean | undefined;

  // `serveDirs` roots are ABSOLUTE from here on — resolved ONCE, exactly the
  // way `baseDir` is (`resolve()` against the process cwd, server.ts). Without
  // this a RELATIVE root ("../core/lib" — the form the docs show) resolved to
  // an absolute filepath while the containment prefix stayed relative, so
  // `filepath.startsWith(basePfx)` was false for EVERY file: a blanket 403
  // that read as "the guard refused you" instead of "your path was relative".
  // Absolute-vs-absolute keeps every guard exactly as strong.
  const _roots: Array<
    { prefix: string; withSlash: string; dir: string; checked: boolean }
  > = Object.entries(deps.serveDirs ?? {}).map(([prefix, dir]) => ({
    prefix,
    withSlash: prefix.endsWith("/") ? prefix : prefix + "/",
    dir: resolve(dir),
    checked: false,
  }));

  /** Fail loud, once per root, the first time anything asks for it: a root
   *  that is not a directory serves nothing but 404s, and the symptom the
   *  developer sees (a blank page from a failed dynamic import) points at the
   *  import, never at the config. Names the RESOLVED path, because a wrong
   *  relative root is the likely mistake. */
  async function _warnIfMissing(
    r: { prefix: string; dir: string; checked: boolean },
  ): Promise<void> {
    if (r.checked) return;
    r.checked = true;
    let ok = false;
    try {
      ok = (await Deno.stat(r.dir)).isDirectory;
    } catch { /* missing — reported below */ }
    if (!ok) {
      log.warn(
        `serveDirs["${r.prefix}"] → ${r.dir} is not a directory — every ` +
          `request under "${r.prefix}" will 404 (a relative root resolves ` +
          `against the process cwd, exactly like baseDir)`,
      );
    }
  }

  /** Returns errors from the last 30 seconds */
  function getRecentErrors() {
    const cutoff = Date.now() - 30_000;
    return [...errorMap.values()].filter((e) => e.ts > cutoff)
      .flatMap((e) => e.errors);
  }

  /** THE app shell — served at `/` and by the SPA deep-link fallback. Two
   *  hand-maintained generateHTML() calls already diverged once (the fallback
   *  missed `syncCells`, so a reloaded deep link silently lost local-first);
   *  one closure makes the next added parameter a one-place change. */
  function appShell(): Response {
    return new Response(
      generateHTML({
        title: deps.title,
        prod: deps.prod,
        hasCSS: deps.hasCSS,
        importMap: deps.importMap,
        showStatus: deps.showStatus,
        width: deps.width,
        height: deps.height,
        renderBudget: deps.renderBudget,
        uiEntry: deps.uiEntry,
        viewport: deps.viewport,
        headExtra: deps.headExtra,
        syncCells: deps.syncCells,
        callTimeouts: deps.callTimeouts,
        chrome: deps.chrome,
        theme: deps.theme,
        themeName: deps.themeName,
        lang: deps.lang,
      }),
      { headers: { "Content-Type": "text/html", ...deps.noCache } },
    );
  }

  async function serveStatic(
    pathname: string,
    req?: Request,
  ): Promise<Response> {
    const { prod, debug, title, absDistDir, noCache } = deps;

    // ── Root / SPA entry ──
    if (pathname === "/") {
      const graphResult = deps.getGraphResult();
      if (!prod && graphResult && !graphResult.valid) {
        return new Response(
          generateDiagnosticHTML(graphResult.errors, title),
          { headers: { "Content-Type": "text/html", ...noCache } },
        );
      }
      // Headless-build footgun: prod is serving the UI shell but the
      // browser bundle was never built (a `--headless` build), so /app.js will
      // 404 and the page breaks blank. Say so plainly instead.
      if (prod && absDistDir) {
        if (_uiBundlePresent === undefined) {
          try {
            await Deno.stat(join(absDistDir, BUNDLE_JS));
            _uiBundlePresent = true;
          } catch {
            _uiBundlePresent = false;
          }
        }
        if (!_uiBundlePresent) {
          deps.debug(
            "headless build has no browser bundle (dist/app.js) — the UI is " +
              "unavailable; serve a UI target or use the app headlessly (API/CLI)",
          );
          const body =
            `<!doctype html><meta charset=utf-8><title>${title} — headless` +
            `</title><body style="font:15px/1.6 system-ui;max-width:38rem;` +
            `margin:12vh auto;padding:0 1.25rem;color:#ddd;background:#0d1117">` +
            `<h1 style="font-size:1.15rem">Headless build — no browser UI</h1>` +
            `<p>This server was built <code>--headless</code>, so no web UI ` +
            `bundle (<code>/app.js</code>) exists. The server, cells, API ` +
            `routes and serverFns all work — only the page here is unavailable.` +
            `</p><p style="color:#8b949e">Build a UI target (browser / electron` +
            ` / android) to serve a page, or use the app headlessly.</p>`;
          return new Response(body, {
            status: 503,
            headers: { "Content-Type": "text/html", ...noCache },
          });
        }
      }
      return appShell();
    }

    // ── AIO virtual JS modules ──
    // Framework npm deps served locally — dev must not need the internet.
    if (!prod && pathname === "/__aio/vendor/immer.js") {
      const src = loadVendorImmer();
      if (src) {
        return new Response(src, {
          headers: { "Content-Type": "text/javascript", ...noCache },
        });
      }
      return new Response("// no local immer found", { status: 404 });
    }
    // These serve FRAMEWORK SOURCE, live-transpiled per request. They exist for
    // the dev import map (`aio` → /__aio/ui.js), and `prodHTML` emits no import
    // map at all — a production page loads one bundled /app.js and never names
    // this namespace. So in prod they were reachable, unauthenticated, and used
    // by nobody.
    //
    // That is not merely dead surface. Each hit is a file read plus an esbuild
    // transpile with no cache on either side (the responses carry `no-cache`,
    // so nothing downstream absorbs a repeat either) — an unauthenticated
    // request that costs the server far more than it costs the caller, which is
    // the same amplifier shape as the auth-budget DoS. Dev keeps them; prod
    // falls through to the 404 that already describes the rest of this
    // namespace.
    if (!prod && pathname === "/__aio/ui.js") {
      return await serveAioModule(BROWSER_AIR_TS_URL, "browser-air.ts");
    }
    if (!prod && pathname === "/__aio/air.js") {
      return await serveAioModule(AIR_TS_URL, "air.ts");
    }
    if (!prod && pathname === "/__aio/listeners.ts") {
      return await serveAioModule(LISTENERS_TS_URL, "listeners.ts");
    }

    // Generic handler for aio sub-module .ts files (e.g. vitals/*.ts)
    if (
      !prod &&
      pathname.startsWith("/__aio/") &&
      (pathname.endsWith(".ts") || pathname.endsWith(".tsx")) &&
      !pathname.includes("..")
    ) {
      const relPath = pathname.slice("/__aio/".length);
      const target = aioModuleUrl(relPath);
      // Unresolvable → 404, never a fetch. `new URL(rel, base)` IGNORES the
      // base when rel is absolute, so an unchecked path let a request name any
      // file (`/__aio/file:///etc/x.ts`) or any host
      // (`/__aio/http://10.0.0.7/x.ts` — SSRF, reflected as JS). See
      // aioModuleUrl: it fails closed on anything outside the framework src.
      if (!target) return new Response("not found", { status: 404 });
      return await serveAioModule(target, relPath);
    }

    // ── Dev-only error endpoints ──
    if (!prod && pathname === "/__aio/error") {
      return new Response(JSON.stringify({ errors: getRecentErrors() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!prod && pathname === "/__aio/client-error" && req?.method === "POST") {
      try {
        const body = await req.json() as {
          message?: string;
          stack?: string;
          blankScreen?: string;
        };
        const classified = classifyBrowserError(body.message ?? "");
        if (body.blankScreen) {
          // The #1 historical failure class — make the terminal say WHY,
          // loudly (debug-level was invisible at the default log level).
          log.warn(
            "client",
            `BLANK SCREEN (${body.blankScreen}): ${
              body.message ?? "(no details)"
            }` + (classified.fix
              ? `
  fix: ${classified.fix}`
              : ""),
          );
        } else {
          debug(
            `client error: ${body.stack ?? body.message ?? "(no details)"}`,
          );
        }
        return new Response(JSON.stringify(classified), {
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new Response(null, { status: 204 });
      }
    }

    // ── Blob bytes (content-addressed, Range-capable) ──
    if (pathname.startsWith(BLOB_URL_PREFIX) && deps.blobs) {
      return handleBlob(pathname, req);
    }

    // ── App icon ──
    //
    // ONE url for every consumer (the `<link rel="icon">` below, an OG card, a
    // README), and one decider behind it: the app's own `icon.png`/`icon.svg`
    // if it drew one, otherwise its generated monogram. Serving a default
    // rather than a 404 is deliberate — a browser with no favicon shows the
    // same grey globe for every tab, which is precisely the "which of my apps
    // is this?" problem the icon exists to answer.
    if (pathname === "/__aio/icon") return handleIcon();

    // ── Snapshot endpoint ──
    if (
      pathname === "/__aio/snapshot" && deps.getSnapshot && deps.loadSnapshot
    ) {
      return handleSnapshot(req);
    }

    // ── Health endpoint ──
    if (pathname === "/__aio/health" && deps.getHealth) {
      return handleHealth();
    }

    // ── Vitals endpoint ──
    if (pathname === "/__aio/vitals" && deps.vitalsSystem) {
      return handleVitals();
    }

    // ── Prometheus metrics endpoint ──
    if (pathname === "/__aio/metrics") {
      return handleMetrics();
    }

    // ── Trojan: control REST API — DEV-ONLY, never mounted in prod ──
    // The trojan reads full state, runs SQL, triggers UI, and loads snapshots.
    // It exists to make development productive; a release build has no business
    // exposing it, so it is gated off entirely here (single source of truth).
    if (!prod && deps.trojan && pathname.startsWith("/__aio/trojan/")) {
      const trojanResp = await _handleTrojanRoute(
        pathname,
        req,
        deps.getTrojanDeps() as Parameters<typeof _handleTrojanRoute>[2],
      );
      if (trojanResp) return trojanResp;
    }

    // ── Prod: serve bundled assets from distDir ──
    if (
      prod && absDistDir &&
      (pathname === "/app.js" || pathname === "/style.css")
    ) {
      const file = pathname.slice(1);
      try {
        await _warnIfStaleArtifact(file);
        const body = await Deno.readTextFile(join(absDistDir, file));
        // The bundle records which UI component it was built from
        // (__aioBundleUi; absent = the App.tsx convention, which is what every
        // pre-stamp build bundled). Serving a bundle built from a DIFFERENT
        // component than the running `ui.entry` is the dev≠prod divergence in
        // its purest form — the page renders, just the wrong app. Refuse, and
        // name both sides and the fix.
        if (file === BUNDLE_JS) {
          const stampUi =
            body.match(/globalThis\.__aioBundleUi\s*=\s*"([^"]*)"/)?.[1] ??
              UI_ENTRY;
          const runtimeUi = deps.uiEntry ?? UI_ENTRY;
          if (stampUi !== runtimeUi) {
            const msg =
              `dist/app.js was bundled from ${stampUi} but this server's ui.entry is ${runtimeUi} — ` +
              `the compiled page would render a different component than dev. ` +
              `Rebuild with --ui=${runtimeUi} (or set "build": { "ui": "${runtimeUi}" } in deno.json).`;
            log.error(`[ui-entry] ${msg}`);
            // The served body PUTS the reason on the page and then throws, so
            // the browser console shows it too and whatever awaited this
            // module fails loudly instead of mounting nothing.
            const shown = JSON.stringify("[aio] " + msg);
            return new Response(
              `document.body.innerHTML = '<pre style="padding:2rem;white-space:pre-wrap">' + ${shown} + '</pre>';\n` +
                `throw new Error(${shown});\n`,
              {
                status: 500,
                headers: {
                  "Content-Type": "application/javascript",
                  ...noCache,
                },
              },
            );
          }
        }
        const ct = file.endsWith(".css")
          ? "text/css"
          : "application/javascript";
        return new Response(body, {
          headers: { "Content-Type": ct, ...noCache },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }

    // ── Static file serving from baseDir ──
    return await serveFile(pathname);
  }

  // ── Helpers ──

  /** Transpile and serve an AIO internal module by URL */
  async function serveAioModule(
    fileUrl: URL,
    label: string,
  ): Promise<Response> {
    const { debug, noCache } = deps;
    try {
      const source = await fetch(fileUrl).then((r) => r.text());
      const code = await transpile(source, fileUrl.href, debug);
      return new Response(code, {
        headers: { "Content-Type": "application/javascript", ...noCache },
      });
    } catch (err) {
      debug(`transpile ${label} error: ${fmtEsbuildError(err, label)}`);
      return new Response(
        `throw new Error(${
          JSON.stringify(
            label + " transpile failed: " + fmtEsbuildError(err, label) +
              " — fix the syntax error above; the dev server rebuilds on save",
          )
        })`,
        {
          headers: { "Content-Type": "application/javascript", ...noCache },
        },
      );
    }
  }

  /** Serve `/__aio/blobs/<id>` — GET/HEAD, single-range (206/416), immutable
   *  caching. The id IS the sha256 of the content, so the response can never
   *  go stale: `immutable` + a matching ETag are correct BY CONSTRUCTION. */
  async function handleBlob(
    pathname: string,
    req?: Request,
  ): Promise<Response> {
    const method = req?.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }
    const id = pathname.slice(BLOB_URL_PREFIX.length);
    // Not a well-formed id → same 404 as an absent blob (no probe surface).
    if (!BLOB_ID_RE.test(id)) return new Response("Not Found", { status: 404 });
    const blob = await deps.blobs!.info(id);
    if (!blob) return new Response("Not Found", { status: 404 });

    const etag = `"${id}"`;
    const baseHeaders: Record<string, string> = {
      // Content-addressed: the bytes behind this URL can never change.
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": etag,
      "Accept-Ranges": "bytes",
      "Content-Type": (blob.name ? MIME[extname(blob.name)] : undefined) ??
        "application/octet-stream",
    };
    if (req?.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: baseHeaders });
    }

    const range = parseByteRange(req?.headers.get("range") ?? null, blob.size);
    if (range === "unsatisfiable") {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${blob.size}` },
      });
    }
    // HEAD carries the SAME response (headers included) — the HTTP runtime
    // strips the body and cancels the stream, and building it identically is
    // what keeps a HEAD's Content-Length from drifting to 0 (a null-body
    // Response gets its declared length overwritten by the server runtime).
    if (range) {
      const len = range.end - range.start;
      const headers = {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end - 1}/${blob.size}`,
        "Content-Length": String(len),
      };
      return new Response(await deps.blobs!.stream(id, range), {
        status: 206,
        headers,
      });
    }
    const headers = { ...baseHeaders, "Content-Length": String(blob.size) };
    return new Response(await deps.blobs!.stream(id), {
      status: 200,
      headers,
    });
  }

  /** Handle GET/POST snapshot endpoint */
  function handleSnapshot(req?: Request): Response | Promise<Response> {
    if (!req || req.method === "GET") {
      return new Response(deps.getSnapshot!(), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="snapshot.json"',
        },
      });
    }
    if (req.method === "POST" && !req.headers.get("x-aio")) {
      return new Response("Missing X-AIO header", { status: 403 });
    }
    if (req.method === "POST") {
      const clHeader = req.headers.get("content-length");
      if (clHeader !== null && Number(clHeader) > SNAPSHOT_MAX_SIZE) {
        return new Response(
          `Snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`,
          { status: 413 },
        );
      }
      return (async () => {
        try {
          const json = await req.text();
          if (json.length > SNAPSHOT_MAX_SIZE) {
            return new Response(
              `Snapshot too large (max ${SNAPSHOT_MAX_SIZE} bytes)`,
              { status: 413 },
            );
          }
          JSON.parse(json); // validate
          deps.loadSnapshot!(json);
          return new Response("OK", { status: 200 });
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
      })();
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  /** Handle GET /__aio/metrics — Prometheus text exposition. */
  function handleMetrics(): Response {
    try {
      const extra = deps.getVitalsExtra();
      const health = deps.getHealth?.() as
        | { cells?: Record<string, { errors: number; enabled: boolean }> }
        | Record<string, { errors: number; enabled: boolean }>
        | undefined;
      const cells = (health && "cells" in (health as Record<string, unknown>)
        ? (health as {
          cells?: Record<string, { errors: number; enabled: boolean }>;
        }).cells
        : health as Record<string, { errors: number; enabled: boolean }>) ??
        undefined;
      const body = formatPrometheus({
        uptimeSeconds: Math.round((Date.now() - _startedAt) / 1000),
        memory: Deno.memoryUsage(),
        clients: Object.keys(extra.clientBackpressure ?? {}).length,
        cells,
        payloads: extra.payloadStats,
      });
      return new Response(body, {
        headers: { "Content-Type": "text/plain; version=0.0.4" },
      });
    } catch (e) {
      return new Response(`# metrics error: ${String(e)}\n`, { status: 503 });
    }
  }

  /** In PROD the browser is served `dist/`, while the developer edits `src/`.
   *
   *  That is correct — a prod server has a build — and it is invisible: edit
   *  `src/style.css`, reload, see nothing change, and the natural conclusion
   *  is that the edit was a no-op. One field report re-screenshotted after a
   *  change, got a BYTE-IDENTICAL png, and went looking for a bug in their own
   *  code before thinking to ask what the server was actually serving. "The
   *  file you edited is not the file being served" is a silent failure with a
   *  long debugging tail, and the server is the only thing that can see both.
   *
   *  Once per path per process: a stale artifact is a fact about the build,
   *  not about this request, and a line per reload is a line nobody reads. */
  const _staleWarned = new Set<string>();
  async function _warnIfStaleArtifact(file: string): Promise<void> {
    if (_staleWarned.has(file)) return;
    _staleWarned.add(file);
    const src = file === BUNDLE_JS ? null : join(deps.absBaseDir, file);
    if (!src) return; // app.js has no single source file — the bundle has many
    try {
      const [a, b] = await Promise.all([
        Deno.stat(join(deps.absDistDir!, file)),
        Deno.stat(src),
      ]);
      if (!a.mtime || !b.mtime || b.mtime <= a.mtime) return;
      deps.debug(
        `serving dist/${file} (a build artifact) while ${file} in the source ` +
          `dir is NEWER — your edit is not on screen. Rebuild (deno task ` +
          `build), or run the dev server, which serves the source directly.`,
      );
    } catch { /* no source, or no artifact — nothing to compare */ }
  }

  /** Handle GET /__aio/icon — the app's icon, always.
   *
   *  Cached in PROD only: the artifact cannot change under a running server.
   *  In dev it re-resolves per request — the Cache-Control below promises that
   *  "dropping an icon.png into the app dir shows up on the next reload", and
   *  a server-side forever-cache would quietly break that promise while the
   *  header keeps making it. */
  let _iconCache: { body: Uint8Array | string; type: string } | null = null;
  async function handleIcon(): Promise<Response> {
    if (!deps.prod) _iconCache = null;
    if (!_iconCache) {
      // The app's own art wins, in the same dir every other app asset comes
      // from (THE app-dir decider). PNG first: that is the file the build,
      // Electron and Android all read, so a project with both cannot end up
      // with a browser tab that disagrees with its taskbar entry.
      const dirs = [deps.absDistDir, deps.absBaseDir].filter(
        Boolean,
      ) as string[];
      for (const dir of dirs) {
        for (
          const [file, type] of [
            [APP_ICON, "image/png"],
            ["icon.svg", "image/svg+xml"],
          ] as const
        ) {
          try {
            _iconCache = { body: await Deno.readFile(join(dir, file)), type };
            break;
          } catch { /* next candidate */ }
        }
        if (_iconCache) break;
      }
      _iconCache ??= {
        body: appIconSvg(deps.title),
        type: "image/svg+xml",
      };
    }
    return new Response(_iconCache.body as BodyInit, {
      headers: {
        "Content-Type": _iconCache.type,
        // Short, not immutable: dropping an icon.png into the app dir has to
        // show up on the next reload, or the feature teaches people that the
        // icon they just drew does not work.
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  /** Handle GET /__aio/health */
  function handleHealth(): Response {
    try {
      const health = deps.getHealth!();
      return new Response(JSON.stringify(health, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ status: "error", error: String(e) }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  /** Handle GET /__aio/vitals */
  function handleVitals(): Response {
    const vs = deps.vitalsSystem!;
    try {
      const data = vs.getEndpointData();
      const pm = vs.pressureMonitor;
      const extra = deps.getVitalsExtra();
      const payloadStats: Record<string, Record<string, unknown>> = {};
      for (const [id, stats] of extra.payloadStats) {
        payloadStats[id] = {
          ...stats,
          bytesPerSec: pm?.getBytesPerSec(id) ?? 0,
        };
      }
      const cellSizes = extra.rawState
        ? vs.computeCellSizes(extra.rawState)
        : {};
      const _gaugeOf = (name: string, current: number, capacity: number) => ({
        name,
        current,
        capacity,
        percent: capacity > 0
          ? Math.min(100, Math.round((current / capacity) * 100))
          : 0,
      });
      const loopVitals = vs.loopProbe.getVitals();
      const serverGauges = {
        "server.queueDepth": _gaugeOf(
          "server.queueDepth",
          loopVitals.queueDepth,
          1000,
        ),
        "server.reduceTime": _gaugeOf(
          "server.reduceTime",
          loopVitals.p95ReduceTime,
          100,
        ),
      };
      const responseData = {
        ...data,
        payloadStats,
        cellSizes,
        gauges: serverGauges,
        clientBackpressure: extra.clientBackpressure,
      };
      return new Response(JSON.stringify(responseData, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ status: "error", error: String(e) }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  /** Serve a file from baseDir — handles SPA fallback, transpilation, binary/text */
  async function serveFile(pathname: string): Promise<Response> {
    const { prod, debug, title, absBaseDir, noCache } = deps;

    const filename = pathname.replace(/^\//, "");
    // Server-only files and dotfiles are never served, at any depth — see
    // isProtectedPath. (Checked before the file is even resolved, so the reply
    // is identical whether or not it exists.)
    if (isProtectedPath(pathname, prod)) {
      return new Response("Not found", { status: 404 });
    }
    // Which root serves this request? A `serveDirs` prefix wins over baseDir;
    // everything after this line treats the chosen root EXACTLY as baseDir was
    // treated, guards included — an extra root must not be a weaker root.
    let root = absBaseDir;
    let rel = filename;
    for (const r of _roots) {
      if (pathname === r.prefix || pathname.startsWith(r.withSlash)) {
        await _warnIfMissing(r);
        root = r.dir; // absolute — see _roots
        rel = pathname.slice(r.withSlash.length).replace(/^\//, "");
        break;
      }
    }
    const filepath = resolve(root, rel);
    // Path traversal protection
    const basePfx = root.endsWith(SEPARATOR) ? root : root + SEPARATOR;
    if (!filepath.startsWith(basePfx)) {
      return new Response("Forbidden", { status: 403 });
    }
    // Symlinks inside the root must not escape it either
    try {
      const real = await Deno.realPath(filepath);
      const realBase = await Deno.realPath(root);
      const realPfx = realBase.endsWith(SEPARATOR)
        ? realBase
        : realBase + SEPARATOR;
      if (real !== realBase && !real.startsWith(realPfx)) {
        return new Response("Forbidden", { status: 403 });
      }
    } catch { /* file doesn't exist — later handlers 404 */ }
    const ext = extname(filepath);

    // SPA fallback: extensionless paths (not internal /__* APIs)
    if (!ext && !pathname.startsWith("/__")) {
      let exists = false;
      try {
        await Deno.stat(filepath);
        exists = true;
      } catch { /* not found */ }
      if (!exists) {
        const graphResult = deps.getGraphResult();
        if (!prod && graphResult && !graphResult.valid) {
          return new Response(
            generateDiagnosticHTML(graphResult.errors, title),
            { headers: { "Content-Type": "text/html", ...noCache } },
          );
        }
        return appShell();
      }
    }

    const isText = TEXT_EXTENSIONS.has(ext);

    // Binary files
    if (!isText) {
      try {
        const bytes = await Deno.readFile(filepath);
        return new Response(bytes, {
          headers: {
            "Content-Type": MIME[ext] ?? "application/octet-stream",
            ...noCache,
          },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }

    let body: string;
    try {
      body = await Deno.readTextFile(filepath);
    } catch {
      return new Response("Not Found", { status: 404 });
    }

    let contentType = MIME[ext] ?? "text/plain";

    // Dev only: live-transpile .ts/.tsx via esbuild
    if (!prod && (ext === ".tsx" || ext === ".ts")) {
      try {
        body = await transpile(body, filepath, debug);
        contentType = "application/javascript";
        lastError = "";
        errorMap.delete(filename);
      } catch (err) {
        const formatted = fmtEsbuildError(err, filename);
        debug(`transpile error: ${formatted}`);
        lastError = formatted;
        const rawMsgs = (err as { errors?: EsbuildMessage[] }).errors ?? [];
        errorMap.set(filename, {
          errors: rawMsgs.length
            ? rawMsgs.map((m) => ({
              text: m.text,
              file: m.location?.file ?? filename,
              line: m.location?.line,
              col: m.location?.column,
              lineText: m.location?.lineText,
            }))
            : [{ text: formatted }],
          ts: Date.now(),
        });
        for (const [f, e] of errorMap) {
          if (Date.now() - e.ts > 60_000) errorMap.delete(f);
        }
        return new Response(
          `throw new Error(${JSON.stringify(lastError)})`,
          {
            status: 200,
            headers: { "Content-Type": "application/javascript", ...noCache },
          },
        );
      }
    }

    return new Response(body, {
      headers: { "Content-Type": contentType, ...noCache },
    });
  }

  return { serveStatic, getRecentErrors };
}
