// Static file serving & virtual route handler — extracted from server.ts
// Handles all HTTP requests (non-WS): HTML pages, transpilation, __aio/* endpoints, static files
import { extname, join, resolve, SEPARATOR } from "@std/path";
import { formatPrometheus } from "./server-metrics.ts";
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

/** Safety limits — prevent resource exhaustion */
const SNAPSHOT_MAX_SIZE = 10_000_000; // 10MB — reject oversized snapshot uploads

/** Dependencies injected from server.ts — no mutable state owned */
export interface StaticDeps {
  prod: boolean;
  debug: (msg: string) => void;
  title: string;
  absBaseDir: string;
  absDistDir: string | null;
  hasCSS: boolean;
  importMap: string; // JSON stringified import map
  noCache: Record<string, string>;
  showStatus?: boolean;
  width?: number;
  height?: number;
  renderBudget?: RenderBudget;
  uiEntry?: string; // AIO-8.1
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

  /** Returns errors from the last 30 seconds */
  function getRecentErrors() {
    const cutoff = Date.now() - 30_000;
    return [...errorMap.values()].filter((e) => e.ts > cutoff)
      .flatMap((e) => e.errors);
  }

  async function serveStatic(
    pathname: string,
    req?: Request,
  ): Promise<Response> {
    const {
      prod,
      debug,
      title,
      absDistDir,
      hasCSS,
      importMap,
      noCache,
      showStatus,
      width,
      height,
      renderBudget,
      uiEntry,
    } = deps;

    // ── Root / SPA entry ──
    if (pathname === "/") {
      const graphResult = deps.getGraphResult();
      if (!prod && graphResult && !graphResult.valid) {
        return new Response(
          generateDiagnosticHTML(graphResult.errors, title),
          { headers: { "Content-Type": "text/html", ...noCache } },
        );
      }
      return new Response(
        generateHTML(
          title,
          prod,
          hasCSS,
          importMap,
          showStatus,
          width,
          height,
          renderBudget,
          uiEntry,
        ),
        { headers: { "Content-Type": "text/html", ...noCache } },
      );
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
      return await serveAioModule(new URL(relPath, AIO_SRC_BASE_URL), relPath);
    }

    // ── Dev-only error endpoints ──
    if (!prod && pathname === "/__aio/error") {
      return new Response(JSON.stringify({ errors: getRecentErrors() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!prod && pathname === "/__aio/client-error" && req?.method === "POST") {
      try {
        const body = await req.json() as { message?: string; stack?: string };
        debug(`client error: ${body.stack ?? body.message ?? "(no details)"}`);
        const classified = classifyBrowserError(body.message ?? "");
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

    // ── Trojan: control REST API (localhost-only) ──
    if (deps.trojan && pathname.startsWith("/__aio/trojan/")) {
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
    const {
      prod,
      debug,
      title,
      absBaseDir,
      hasCSS,
      importMap,
      noCache,
      showStatus,
      width,
      height,
      renderBudget,
      uiEntry,
    } = deps;

    const filename = pathname.replace(/^\//, "");
    const filepath = resolve(absBaseDir, filename);
    // Path traversal protection
    const basePfx = absBaseDir.endsWith(SEPARATOR)
      ? absBaseDir
      : absBaseDir + SEPARATOR;
    if (!filepath.startsWith(basePfx)) {
      return new Response("Forbidden", { status: 403 });
    }
    // Symlinks inside baseDir must not escape it either
    try {
      const real = await Deno.realPath(filepath);
      const realBase = await Deno.realPath(absBaseDir);
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
        return new Response(
          generateHTML(
            title,
            prod,
            hasCSS,
            importMap,
            showStatus,
            width,
            height,
            renderBudget,
            uiEntry,
          ),
          { headers: { "Content-Type": "text/html", ...noCache } },
        );
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
