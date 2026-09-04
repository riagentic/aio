// Static file serving & virtual route handler — extracted from server.ts
// Handles all HTTP requests (non-WS): HTML pages, transpilation, __aio/* endpoints, static files
import { APP_ICON, BUNDLE_JS, UI_ENTRY } from "./app-files.ts";
import {
  declaresOverLimit,
  readBounded,
  SNAPSHOT_MAX_BODY,
} from "./read-body.ts";
import { TROJAN_PREFIX } from "./server-auth.ts";
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
import type { ShareRoot } from "./app-dirs.ts";
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
import { etagMatches, etagOf } from "./http-encoding.ts";

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
  // Decide on the path the FILESYSTEM will see, not the spelling the client
  // chose. `resolve()` drops empty segments, so `/App.tsx/`, `/App.tsx//` and
  // `/App.tsx/%2e` (the WHATWG parser folds `.`, `%2e` and `./` into a
  // trailing slash) all opened the same file — while the rule looked at the
  // last RAW segment, saw "", and matched nothing. A production server handed
  // out `/App.tsx/` and `/secret.server.ts/` to anyone who typed the slash.
  const segments = pathname.split("/").filter((seg) => seg !== "");
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (seg === ".well-known") continue;
    if (seg.startsWith(".")) return true;
  }
  const last = segments[segments.length - 1]!;
  if (prod && /\.tsx?$/.test(last)) return true;
  return SERVER_FILE_RE.test(last);
}

/** File extensions an ANONYMOUS caller may fetch on a per-user-auth app: the
 *  app SHELL, and nothing else under `baseDir`.
 *
 *  `authFlows` makes the shell public so the sign-in page can render. The
 *  anonymous branch then handed everything it had not explicitly carved out
 *  (snapshot, blobs, diagnostics, trojan, app routes) straight to
 *  `serveStatic` — so every non-dotfile, non-`*.server.ts` file under
 *  `baseDir` was readable with no credential, at any depth: `/data/app.db`,
 *  `/uploads/passport.png`, `/backup.sql`, `/notes.md`. The same paths on a
 *  `users:` app answer 401. Worst case is `--expose` + `auth: true`, the
 *  recommended internet-facing config: an unauthenticated read of the project
 *  directory.
 *
 *  The code itself already states the principle two lines above the hole —
 *  "Blob BYTES are app data, not app shell" — and `docs/auth/auth.md` promises
 *  only that the SHELL is public. This is that principle, applied to the
 *  filesystem. Deliberately-public assets belong in `serveDirs`. */
const SHELL_EXT: ReadonlySet<string> = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".map",
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".webmanifest",
  ".html",
  ".txt",
]);

/** The exact filenames a shell may name that carry a data-ish extension. */
const SHELL_FILES: ReadonlySet<string> = new Set([
  "manifest.json",
  "robots.txt",
  "favicon.ico",
]);

/** May an anonymous caller fetch `pathname` on a per-user-auth app?
 *
 *  Pure, so the rule is unit-testable without a server. `dev` admits `.ts`/
 *  `.tsx`: the dev shell's import map makes the browser fetch sources BY NAME,
 *  so refusing them would make the sign-in page itself unrenderable — and in
 *  prod `isProtectedPath` denies them to everyone anyway. */
export function isShellAsset(pathname: string, dev: boolean): boolean {
  // The framework runtime under /__aio/ is shell by definition; the control
  // plane inside it is denied by name before this is ever asked.
  if (pathname.startsWith("/__aio/")) return true;
  const segments = pathname.split("/").filter((s) => s !== "");
  const last = segments[segments.length - 1];
  // No file named at all → the SPA shell (a client route).
  if (!last) return true;
  if (SHELL_FILES.has(last.toLowerCase())) return true;
  const dot = last.lastIndexOf(".");
  // Extensionless → a client route, served the shell.
  if (dot <= 0) return true;
  const ext = last.slice(dot).toLowerCase();
  if (dev && (ext === ".ts" || ext === ".tsx")) return true;
  return SHELL_EXT.has(ext);
}

/** A browser error report goes into a LOG LINE, so it is bounded like one —
 *  not at the 1 MB control-body ceiling, which is a disk-fill primitive on a
 *  route that needs a few hundred bytes. */
const CLIENT_ERROR_MAX_BODY = 8 * 1024;

/** `text` with control characters removed and length capped — safe to put in a
 *  log line. A newline in a client-supplied string is a SECOND log line the
 *  operator did not get from aio, which is how a forged report reads as fact.
 *  Pure; exported for tests. */
export function logSafe(text: unknown, max = 2000): string | undefined {
  if (typeof text !== "string") return undefined;
  // deno-lint-ignore no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

/** Percent-decode a request path segment by segment, or `null` when a segment
 *  decodes into something that is not a name: a separator, a NUL, or a
 *  traversal step. Pure; exported for tests. */
export function _decodePathname(pathname: string): string | null {
  const out: string[] = [];
  for (const seg of pathname.split("/")) {
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null; // a malformed escape is not a file name
    }
    if (d.includes("/") || d.includes("\\") || d.includes("\0")) return null;
    if (d === "." || d === "..") return null;
    out.push(d);
  }
  return out.join("/");
}

/** The Content-Type a stored blob may be served AS.
 *
 *  The type used to come straight from the UPLOADED FILENAME's extension, and
 *  `docs/persistence/big-data.md` shows exactly that pattern —
 *  `blobs.put(ctx.req.body, { name: ctx.params.name })` with the client's own
 *  filename, then `blobs.url(id)` handed back. So `evil.html` was served as
 *  `text/html` and `evil.svg` as `image/svg+xml`: navigating to that URL ran
 *  attacker script in the APP's origin. The default CSP carries no
 *  `script-src`, and `nosniff` does not help a type the server DECLARED.
 *
 *  So: an inert allowlist. Images (never SVG — it carries script), video,
 *  audio, PDF and plain text keep their type because a `<img>`/`<video>` tag
 *  needs it; everything else is `application/octet-stream`, which no browser
 *  renders. Paired with `Content-Security-Policy: sandbox` on every blob
 *  response, which makes even a mis-typed one scriptless.
 *
 *  Pure — the rule is unit-testable without a server. */
const BLOB_INLINE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "application/pdf",
  "text/plain",
]);

export function blobContentType(name?: string): string {
  const declared = name ? MIME[extname(name)] : undefined;
  if (!declared) return "application/octet-stream";
  const base = declared.split(";")[0]!.trim().toLowerCase();
  if (BLOB_INLINE_TYPES.has(base)) return base;
  if (base.startsWith("video/") || base.startsWith("audio/")) return base;
  return "application/octet-stream";
}

/** The longest file NAME any filesystem aio runs on accepts (ext4, APFS,
 *  NTFS: 255 bytes/units). A longer segment cannot name a file, so the
 *  answer is 404 — decided BEFORE the filesystem is asked, because asking
 *  threw ENAMETOOLONG, which the text branch answered with a 500 and an
 *  error line carrying the absolute path. */
const MAX_SEGMENT_BYTES = 255;
/** PATH_MAX on Linux; the same "cannot exist" reasoning as the segment cap. */
const MAX_PATH_BYTES = 4096;
const _utf8 = new TextEncoder();

/** True when no filesystem could hold a file at `filepath` — a segment over
 *  255 bytes or a path over PATH_MAX. Pure; exported for tests. */
export function cannotExist(filepath: string): boolean {
  if (_utf8.encode(filepath).byteLength > MAX_PATH_BYTES) return true;
  return filepath.split(/[\\/]/).some((seg) =>
    _utf8.encode(seg).byteLength > MAX_SEGMENT_BYTES
  );
}

/** A filesystem error that means "there is no such file to serve" — the
 *  request named something that does not exist, or names a path through a
 *  file (`/app.js/x.txt` → ENOTDIR), or a symlink cycle. Anything else (EACCES,
 *  EISDIR, EIO) is the server's problem and stays a 500. */
export function isNotServable(e: unknown): boolean {
  return e instanceof Deno.errors.NotFound ||
    e instanceof Deno.errors.NotADirectory ||
    e instanceof Deno.errors.FilesystemLoop;
}

/** THE method table for the framework's own HTTP endpoints. One place, so
 *  `TRACE /__aio/health` cannot answer 200 on one route and 405 on the next:
 *  every route here answered whatever method arrived (the handlers never
 *  looked), `/__aio/snapshot` refused HEAD with a 405 while serving GET, and
 *  `GET /__aio/client-error` fell through to a 404 that said the route did not
 *  exist. Dev-only routes are listed too — in prod they are not mounted, and
 *  a 404 (not a 405) is the truthful answer there, so `aioMethodDenial` takes
 *  the mode. HEAD rides with GET, as HTTP says it must. */
export const AIO_ROUTE_METHODS: Readonly<
  Record<string, { methods: readonly string[]; devOnly?: true }>
> = {
  "/__aio/health": { methods: ["GET", "HEAD"] },
  "/__aio/metrics": { methods: ["GET", "HEAD"] },
  "/__aio/vitals": { methods: ["GET", "HEAD"] },
  "/__aio/icon": { methods: ["GET", "HEAD"] },
  "/__aio/snapshot": { methods: ["GET", "HEAD", "POST"] },
  "/__aio/error": { methods: ["GET", "HEAD"], devOnly: true },
  "/__aio/client-error": { methods: ["POST"], devOnly: true },
};

/** The 405 for a framework endpoint asked with a method it does not serve,
 *  or null when the method is allowed (or the path is not in the table, or
 *  the route is not mounted in this mode). Pure; exported for tests. */
export function aioMethodDenial(
  pathname: string,
  method: string,
  prod: boolean,
): Response | null {
  const entry = AIO_ROUTE_METHODS[pathname];
  if (!entry) return null;
  if (prod && entry.devOnly) return null;
  if (entry.methods.includes(method.toUpperCase())) return null;
  return new Response(
    `Method Not Allowed — ${pathname} serves ${entry.methods.join(", ")}`,
    { status: 405, headers: { Allow: entry.methods.join(", ") } },
  );
}

/** Why a parsed snapshot body cannot be loaded, or null when its SHAPE is
 *  right: a plain object of plain objects, one per cell. A cell's state is
 *  always an object (`cell({ state: {…} })`), so a snapshot that puts a
 *  number, a string, an array or null under a cell name loads today and
 *  breaks the NEXT dispatch — `s.count++` on a state that is `7` throws
 *  inside the method, far from the POST that caused it. Refuse it here,
 *  naming the cell. Pure; shared by every snapshot door (the HTTP endpoint
 *  and the trojan route) so they cannot disagree. */
export function snapshotShapeError(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "snapshot must be a JSON object — pass the exact string returned by app.snapshot()";
  }
  for (
    const [cellName, v] of Object.entries(parsed as Record<string, unknown>)
  ) {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return `snapshot value for cell "${cellName}" must be an object (a cell's state is always an object), got ${
        v === null ? "null" : Array.isArray(v) ? "an array" : typeof v
      }`;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      return `snapshot value for cell "${cellName}" must be a plain object`;
    }
  }
  return null;
}

/** Why a snapshot's CELL SET cannot be loaded into this app, or null when it
 *  matches. Pure, so both refusals are a unit test rather than a claim.
 *
 *  50audits §5 (RED, total data loss): loading a snapshot taken from a
 *  DIFFERENT app — the single most likely mistake on the restore path — wiped
 *  everything and reported success. `setState(parsed)` replaces the whole
 *  state object, so every declared cell absent from the file lost its state
 *  with no message of any kind, the next persist window wrote `{}` over the
 *  row, and `am snapshot load` exited 0 saying `"status":"loaded"`.
 *
 *  Two holes, both closed here: unknown keys were a `log.warn` (a level
 *  `am errors` does not collect) and the load proceeded anyway; MISSING keys
 *  were never checked at all. `snapshotShapeError` — documented as the one
 *  decider shared by every snapshot door — validates the shape of a value
 *  under a cell name and never asks whether the cell exists. This is the
 *  other half, and it lives beside it so they cannot drift.
 *
 *  It is the one code path where being wrong costs a user their data, so it
 *  REFUSES rather than warns. `force` is the operator's explicit override. */
export function snapshotCellsError(
  parsed: unknown,
  declaredCells: readonly string[],
): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null; // not this decider's job — `snapshotShapeError` refuses it
  }
  const declared = new Set(declaredCells);
  const snapKeys = Object.keys(parsed as Record<string, unknown>);
  const snap = new Set(snapKeys);
  const unknown = snapKeys.filter((k) => !declared.has(k));
  const missing = declaredCells.filter((k) => !snap.has(k));
  if (unknown.length === 0 && missing.length === 0) return null;
  const parts: string[] = [];
  if (missing.length) {
    parts.push(
      `it has nothing for ${missing.length === 1 ? "cell" : "cells"} ${
        missing.map((c) => `"${c}"`).join(", ")
      }, whose state would be DESTROYED`,
    );
  }
  if (unknown.length) {
    parts.push(
      `it carries ${unknown.length === 1 ? "a cell" : "cells"} this app does ` +
        `not declare: ${unknown.map((c) => `"${c}"`).join(", ")}`,
    );
  }
  return `snapshot refused — ${parts.join("; and ")}. A snapshot replaces ` +
    `the WHOLE state, so this looks like a file from a different app. This ` +
    `app declares: ${
      declaredCells.length ? declaredCells.join(", ") : "(no cells)"
    }. Pass --force (am snapshot load <file> --force) if replacing the whole ` +
    `state is what you meant.`;
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
  /** THE app-dir ladder, most authoritative first, `absBaseDir` included and
   *  first. Absent (or one entry) is the ordinary case: a dev server, or an
   *  app that named its own `baseDir`. A compiled binary has two — the
   *  embedded VFS dir the build put its assets in, then `<cwd>/src`, which was
   *  its ONLY root before and stays reachable behind it. Every root here is an
   *  app dir and gets every guard `absBaseDir` gets; `serveDirs` still wins
   *  over all of them. See `baseDirCandidates`. */
  absBaseDirs?: string[];
  /** Extra READ-ONLY roots the dev server may serve, `"/urlPrefix" → dir`.
   *  A relative dir is resolved ONCE against the process cwd, exactly like
   *  `baseDir` — see `_roots` below. Dev only: prod bundles already follow
   *  relative imports, so this exists solely so the DEV server can serve a
   *  module that lives outside baseDir (two apps in one repo sharing pure
   *  libraries). Every containment guard that protects baseDir applies to each
   *  root unchanged. */
  serveDirs?: Record<string, string>;
  /** The declared workspace share (deno.json `share`, resolved and validated
   *  by `resolveShare`) — served at `/<basename>/…` with EVERY guard baseDir
   *  has. One fact for both worlds: the bundler resolves the same prefix. Dev
   *  only, like `serveDirs`: a prod server never reads outside its root. */
  share?: readonly ShareRoot[];
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
  /** ui.dir — `<html dir>`. See `UiConfig.dir`. */
  dir?: import("./aio-types.ts").UiConfig["dir"];
  /** ui.chrome — how much of the desktop window the OS draws. */
  chrome?: "standard" | "themed" | "none";
  /** ui.theme — how much of the default look the shell emits. */
  theme?: UiTheme;
  /** Identity the theme's accent hue is derived from — the appId, so the UI
   *  and the icon are the same colour. */
  themeName?: string;
  /** The app's identity, injected into the page's `window.__aioConfig` — the
   *  browser's offline sync queue scopes its per-origin `localStorage` key by
   *  it. */
  appId?: string;
  // Graph validation state — mutable ref from server.ts (dev only)
  getGraphResult: () => GraphResult | null;
  // Snapshot support
  getSnapshot?: () => string;
  loadSnapshot?: (json: string, opts?: { force?: boolean }) => void;
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
    /** Clients on the UDS socket. A desktop app has ALL of its clients here
     *  and none in `clientBackpressure`, which is keyed by WS client id — so
     *  `aio_clients_connected` read 0 for the whole desktop target. */
    udsClients?: number;
    /** Broadcast bytes/messages since this process started — MONOTONIC, which
     *  a Prometheus counter has to be. Summing `payloadStats` gave a series
     *  that reset to zero (and vanished entirely) on every client disconnect,
     *  so every browser reload was a counter reset and `rate()` was garbage. */
    broadcastTotals?: { bytes: number; count: number };
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
  > = [
    ...Object.entries(deps.serveDirs ?? {}).map(([prefix, dir]) => ({
      prefix,
      withSlash: prefix.endsWith("/") ? prefix : prefix + "/",
      dir: resolve(dir),
      checked: false,
    })),
    // A share was validated at resolve time (exists, inside the repo), so it
    // enters `checked` — nothing to warn about lazily. It is a ROOT like any
    // other from here on: traversal, symlink-escape, dotfile and server-only
    // guards all apply to it unchanged.
    ...(deps.share ?? []).map((sh) => ({
      prefix: sh.prefix,
      withSlash: sh.prefix + "/",
      dir: sh.dir,
      checked: true,
    })),
  ];

  // THE app-dir ladder, resolved once. `absBaseDir` is always first and always
  // present, so every existing caller reads the same value it always did; a
  // second entry only appears for a compiled binary that did not name its own
  // baseDir. Deduped here too, because this is the list the guards run over.
  const _appRoots: string[] = [
    resolve(deps.absBaseDir),
    ...(deps.absBaseDirs ?? []).map((d) => resolve(d)),
  ].filter((d, i, a) => a.indexOf(d) === i);

  /** Does a path resolve to something readable? The ladder's only question.
   *  `stat`, not `readFile`: the answer decides a ROOT, and the file is read
   *  (and every guard re-run) against that root afterwards. */
  async function _pathExists(p: string): Promise<boolean> {
    try {
      await Deno.stat(p);
      return true;
    } catch {
      return false;
    }
  }

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
        dir: deps.dir,
        appId: deps.appId,
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

    // ── Framework endpoints: the method table, before any handler ──
    if (req) {
      const denied = aioMethodDenial(pathname, req.method, prod);
      if (denied) return denied;
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
      // The same CSRF header every other control POST carries. Without it this
      // was a SIMPLE cross-origin request (`Content-Type: text/plain` needs no
      // preflight), so any page a developer happened to visit could forge
      // lines in the operator's terminal and log file — including a
      // convincing "BLANK SCREEN" report — if it guessed the port. It is a dev
      // route, and a dev terminal is exactly where a forged line does damage:
      // it is read as the truth about the app.
      if (!req.headers.get("x-aio")) {
        return new Response("Missing X-AIO header", { status: 403 });
      }
      try {
        // A browser error report is a message and a stack, and it is written
        // into a LOG LINE — so it is bounded here rather than "as bounded as
        // the page chooses to be", and control characters are stripped: a
        // newline in a report is a second log line the operator did not get
        // from aio.
        const rawBody = await readBounded(req, CLIENT_ERROR_MAX_BODY);
        if (rawBody === null) {
          return new Response("Error report too large", { status: 413 });
        }
        const body = JSON.parse(rawBody) as {
          message?: string;
          stack?: string;
          blankScreen?: string;
        };
        const message = logSafe(body.message);
        const stack = logSafe(body.stack);
        const classified = classifyBrowserError(message ?? "");
        if (body.blankScreen) {
          // The #1 historical failure class — make the terminal say WHY,
          // loudly (debug-level was invisible at the default log level).
          log.warn(
            "client",
            `BLANK SCREEN (${logSafe(body.blankScreen)}): ${
              message ?? "(no details)"
            }` + (classified.fix
              ? `
  fix: ${classified.fix}`
              : ""),
          );
        } else {
          debug(
            `client error: ${stack ?? message ?? "(no details)"}`,
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
    if (!prod && deps.trojan && pathname.startsWith(TROJAN_PREFIX)) {
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
        const body = await readDistCached(join(absDistDir, file));
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
          headers: { "Content-Type": ct, ...noCache, ETag: _lastDistEtag },
        });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    }

    // ── Static file serving from baseDir ──
    return await serveFile(pathname);
  }

  // ── Helpers ──

  /** The prod bundle, read once per version of the file on disk.
   *
   *  `dist/app.js` was read from disk and UTF-8 decoded on EVERY request — 162
   *  KB of I/O and decode to hand back bytes that had not changed since the
   *  process booted, which is the whole point of a production build. The cache
   *  is keyed on `(mtime, size)` rather than "prod, so it cannot change",
   *  because it CAN: a redeploy that rewrites dist/ under a running server is
   *  exactly what `_warnIfStaleArtifact` exists to notice, and a cache that
   *  outlived it would serve the old app while the warning said the opposite.
   *  One `stat` per request instead of one full read.
   *
   *  The ETag is computed here too, so the response finisher does not hash the
   *  same 162 KB again on every request — it uses the tag a handler supplies.
   */
  const _distCache = new Map<
    string,
    { mtime: number; size: number; body: string; etag: string }
  >();
  async function readDistCached(path: string): Promise<string> {
    const st = await Deno.stat(path);
    const mtime = st.mtime?.getTime() ?? 0;
    const hit = _distCache.get(path);
    if (hit && hit.mtime === mtime && hit.size === st.size) {
      _lastDistEtag = hit.etag;
      return hit.body;
    }
    const body = await Deno.readTextFile(path);
    const etag = etagOf(
      new TextEncoder().encode(body) as Uint8Array<ArrayBuffer>,
    );
    _distCache.set(path, { mtime, size: st.size, body, etag });
    _lastDistEtag = etag;
    return body;
  }
  /** The tag `readDistCached` just resolved — read by the response below,
   *  which is the only caller and is synchronous with it. */
  let _lastDistEtag = "";

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
      // Derived from an INERT allowlist, never from the uploaded filename —
      // see `blobContentType`.
      "Content-Type": blobContentType(blob.name),
      // Belt and braces: a sandboxed document has an opaque origin, no
      // scripting and no form submission, so even a blob that slipped through
      // as a renderable type cannot act as the app.
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
    };
    // `etagMatches`, not `===`: the shared reader already handles `W/` and a
    // comma-list and `*`, and this hand-rolled compare gave the SAME request
    // two answers depending on the blob's content type — a compressible blob
    // also passes through `encodeResponse`, which uses the shared one.
    if (etagMatches(req?.headers.get("if-none-match") ?? null, etag)) {
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
    if (!req || req.method === "GET" || req.method === "HEAD") {
      let body: string;
      try {
        body = deps.getSnapshot!();
      } catch (e) {
        // `getSnapshot` is `JSON.stringify(getState())`, which THROWS on a
        // BigInt or a cycle — and the throw reached the operator as a bare
        // `500 Internal Server Error`, at the one moment a diagnosis matters.
        // The walk that names the field already exists for the persist guard.
        // `app.snapshot()` names the exact path itself (aio-run-helpers), so
        // there is nothing to re-derive here — only to not swallow.
        return new Response(
          `snapshot refused: ${e instanceof Error ? e.message : String(e)}`,
          { status: 500 },
        );
      }
      return new Response(body, {
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
      // Bounded by bytes received — a declared Content-Length is a number the
      // sender chose, and `Number("abc") > MAX` is false, so garbage passed.
      if (declaresOverLimit(req, SNAPSHOT_MAX_BODY)) {
        return new Response(
          `Snapshot too large (max ${SNAPSHOT_MAX_BODY} bytes)`,
          { status: 413 },
        );
      }
      return (async () => {
        try {
          const json = await readBounded(req, SNAPSHOT_MAX_BODY);
          if (json === null) {
            return new Response(
              `Snapshot too large (max ${SNAPSHOT_MAX_BODY} bytes)`,
              { status: 413 },
            );
          }
          const shape = snapshotShapeError(JSON.parse(json));
          if (shape) return new Response(shape, { status: 400 });
          // `?force=1` is the operator's explicit "replace the whole state" —
          // the only way past the cell-set refusal in `loadSnapshot`.
          const force = new URL(req.url).searchParams.get("force") === "1";
          deps.loadSnapshot!(json, { force });
          return new Response("OK", { status: 200 });
        } catch (e) {
          // `loadSnapshot` itself can throw (a refused shape, a migration);
          // that is not "Invalid JSON", and the reason was being dropped.
          return new Response(
            e instanceof SyntaxError
              ? "Invalid JSON"
              : `snapshot refused: ${e}`,
            { status: 400 },
          );
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
      // Two accepted shapes: the full health document (`{ status, cells }`)
      // and a bare cells map (a host that supplies its own `getHealth`).
      // Keyed on `status`, not on `cells`: a health document for an app with
      // no composed cells has no `cells` key, and reading THAT as the map
      // turned `status`/`version`/`pid`/`persist` into cell rows.
      const doc = health as Record<string, unknown> | undefined;
      const cells = (doc && "status" in doc
        ? (doc as {
          cells?: Record<string, { errors: number; enabled: boolean }>;
        }).cells
        : doc as
          | Record<string, { errors: number; enabled: boolean }>
          | undefined) ?? undefined;
      const body = formatPrometheus({
        uptimeSeconds: Math.round((Date.now() - _startedAt) / 1000),
        memory: Deno.memoryUsage(),
        // BOTH transports. A local desktop app opens no TCP ports, so every
        // client is on the socket — and a metric a supervisor scrapes reading
        // a confident 0 is worse than one that is absent.
        clients: Object.keys(extra.clientBackpressure ?? {}).length +
          (extra.udsClients ?? 0),
        cells,
        payloads: extra.payloadStats,
        broadcastTotals: extra.broadcastTotals,
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
      const dirs = [deps.absDistDir, ..._appRoots].filter(
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
  async function serveFile(rawPathname: string): Promise<Response> {
    const { prod, debug, title, absBaseDir, noCache } = deps;

    // DECODE FIRST. The request path was used as a literal filesystem path,
    // and `grep -rn decodeURI src/server` had exactly one hit (route.ts, for
    // params and cookies) — so a file whose name contains a space or any
    // non-ASCII character was permanently 404, at any URL, because a browser
    // always sends `%20`. Worse, it inverted: a file LITERALLY named
    // `lit%20name.txt` was reachable and the real `my photo.txt` was not.
    // Applies to baseDir, `serveDirs` and every app root.
    //
    // Before `isProtectedPath` and before the prefix match, so every rule
    // below judges the name that will actually be opened — a segment that
    // decodes into a separator or a traversal step is the client rewriting
    // the path after the checks have run, and is refused outright.
    const pathname = _decodePathname(rawPathname);
    if (pathname === null) return new Response("Not Found", { status: 404 });

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
    let matchedRoot = false;
    for (const r of _roots) {
      if (pathname === r.prefix || pathname.startsWith(r.withSlash)) {
        await _warnIfMissing(r);
        root = r.dir; // absolute — see _roots
        rel = pathname.slice(r.withSlash.length).replace(/^\//, "");
        matchedRoot = true;
        break;
      }
    }
    // No `serveDirs` prefix claimed it: walk the app-dir ladder and let the
    // first root that HAS the file serve it. Per-FILE, not per-directory: a
    // compiled binary's embedded dir always exists (the entry module is in
    // it), so picking a directory up front would pin every request to a root
    // that may hold only modules. The last candidate is the fallthrough, so a
    // miss 404s (or SPA-falls-back) exactly where it always did.
    if (!matchedRoot && _appRoots.length > 1) {
      for (const dir of _appRoots) {
        if (await _pathExists(resolve(dir, rel))) {
          root = dir;
          break;
        }
      }
    }
    const filepath = resolve(root, rel);
    // Path traversal protection
    const basePfx = root.endsWith(SEPARATOR) ? root : root + SEPARATOR;
    if (!filepath.startsWith(basePfx)) {
      return new Response("Forbidden", { status: 403 });
    }
    // Names no filesystem can hold are 404 before any syscall — see
    // `cannotExist` (ENAMETOOLONG used to be a 500 naming the absolute path).
    if (cannotExist(filepath)) {
      return new Response("Not Found", { status: 404 });
    }
    // A path that ENDS in a slash names a directory. `resolve()` dropped the
    // slash, so `/app.js/` served the FILE app.js — the served path and the
    // requested path must be the same path, or every rule above it (the deny
    // list, an app's own routing) is checking a different name than the one
    // that gets opened. Directories still fall through: an extensionless
    // `/about/` is a SPA route, and a real directory 404s as it always did.
    if (rel.endsWith("/")) {
      try {
        if ((await Deno.stat(filepath)).isFile) {
          return new Response("Not Found", { status: 404 });
        }
      } catch { /* not there — the handlers below answer as before */ }
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
        const st = await Deno.stat(filepath);
        const bytes = await Deno.readFile(filepath);
        return new Response(bytes, {
          headers: {
            "Content-Type": MIME[ext] ?? "application/octet-stream",
            // A VALIDATOR. Prod sets `Cache-Control: no-cache` on every static
            // file, and `no-cache` means "you may cache, but revalidate" —
            // revalidation needs a validator, and images, fonts, wasm and
            // video had none: `encodeResponse` returns early for
            // incompressible types, ABOVE its conditional-request block, so
            // every one of them was a full re-download on every page load.
            // That is verbatim the bug `http-encoding.ts`'s own header
            // presents as fixed.
            //
            // Weak, and from `stat` — no read, no hash: the bytes are
            // identical whenever mtime and size are, which is exactly what a
            // weak validator asserts, and it costs the syscall the file read
            // needs anyway.
            ETag: `W/"${st.mtime?.getTime() ?? 0}-${st.size}"`,
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
    } catch (e) {
      // 404 is the answer for a file that is not there. A file that IS there
      // and cannot be read (EACCES, EISDIR) is a server problem, and saying
      // "Not Found" for it sent people checking their paths.
      if (isNotServable(e)) {
        return new Response("Not Found", { status: 404 });
      }
      log.error("server", `static: cannot read ${filepath} — ${e}`);
      return new Response("Internal Server Error", { status: 500 });
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
