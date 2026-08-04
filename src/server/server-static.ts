// Static file serving & virtual route handler — extracted from server.ts
// Handles all HTTP requests (non-WS): HTML pages, transpilation, __aio/* endpoints, static files
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
import {
  type EsbuildMessage,
  fmtEsbuildError,
  transpile,
} from "./server-transpile.ts";
import { handleTrojan as _handleTrojanRoute } from "./server-trojan.ts";
import { loadVendorImmer } from "./server-vendor.ts";

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
 *  unit-testable without a server. */
export function isProtectedPath(pathname: string): boolean {
  const rel = pathname.replace(/^\/+/, "");
  if (!rel) return false;
  const segments = rel.split("/");
  for (const seg of segments) {
    if (seg === ".well-known") continue;
    if (seg.startsWith(".")) return true;
  }
  return /\.server\.tsx?$/.test(segments[segments.length - 1] ?? "");
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

/** Dependencies injected from server.ts — no mutable state owned */
export interface StaticDeps {
  prod: boolean;
  debug: (msg: string) => void;
  title: string;
  absBaseDir: string;
  /** Extra READ-ONLY roots the dev server may serve, `"/urlPrefix" → absolute
   *  dir`. Dev only: prod bundles already follow relative imports, so this
   *  exists solely so the DEV server can serve a module that lives outside
   *  baseDir (two apps in one repo sharing pure libraries). Every containment
   *  guard that protects baseDir applies to each root unchanged. */
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
  callTimeouts?: { default?: number; methods?: Record<string, number> };
  uiEntry?: string; // AIO-8.1
  viewport?: string | false; // AIO-423: ui.viewport override (false = opt out)
  headExtra?: string; // AIO-423: ui.head — verbatim <head> content
  // Graph validation state — mutable ref from server.ts (dev only)
  getGraphResult: () => GraphResult | null;
  // Snapshot support
  getSnapshot?: () => string;
  loadSnapshot?: (json: string) => void;
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
      generateHTML(
        deps.title,
        deps.prod,
        deps.hasCSS,
        deps.importMap,
        deps.showStatus,
        deps.width,
        deps.height,
        deps.renderBudget,
        deps.uiEntry,
        deps.viewport,
        deps.headExtra,
        deps.syncCells,
        deps.callTimeouts,
      ),
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
            await Deno.stat(join(absDistDir, "app.js"));
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
    if (pathname === "/__aio/ui.js") {
      return await serveAioModule(BROWSER_AIR_TS_URL, "browser-air.ts");
    }
    if (pathname === "/__aio/air.js") {
      return await serveAioModule(AIR_TS_URL, "air.ts");
    }
    if (pathname === "/__aio/listeners.ts") {
      return await serveAioModule(LISTENERS_TS_URL, "listeners.ts");
    }

    // Generic handler for aio sub-module .ts files (e.g. vitals/*.ts)
    if (
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
        const body = await Deno.readTextFile(join(absDistDir, file));
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
    if (isProtectedPath(pathname)) {
      return new Response("Not found", { status: 404 });
    }
    // Which root serves this request? A `serveDirs` prefix wins over baseDir;
    // everything after this line treats the chosen root EXACTLY as baseDir was
    // treated, guards included — an extra root must not be a weaker root.
    let root = absBaseDir;
    let rel = filename;
    for (const [prefix, dir] of Object.entries(deps.serveDirs ?? {})) {
      const p = prefix.endsWith("/") ? prefix : prefix + "/";
      if (pathname === prefix || pathname.startsWith(p)) {
        root = dir;
        rel = pathname.slice(p.length).replace(/^\//, "");
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
