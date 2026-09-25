// Static file serving & virtual route handler — extracted from server.ts
// Handles all HTTP requests (non-WS): HTML pages, transpilation, __aio/* endpoints, static files
import { APP_ICON, BUNDLE_JS, UI_ENTRY } from "./app-files.ts";
import {
  declaresOverLimit,
  readBounded,
  SNAPSHOT_MAX_BODY,
} from "./read-body.ts";
import { TROJAN_PREFIX } from "./server-auth.ts";
import { isServerOnlyMarker, SERVER_FILE_RE } from "../entries.ts";
import type { CallTimeouts } from "../protocol/protocol-types.ts";
import {
  dirname,
  extname,
  fromFileUrl,
  join,
  relative,
  resolve,
  SEPARATOR,
  toFileUrl,
} from "@std/path";
import { locateDenoJsonAbove } from "./deno-json.ts";
import { formatPrometheus, healthCells } from "./server-metrics.ts";
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
import { etagMatches, etagOf, MAX_BUFFER_BYTES } from "./http-encoding.ts";

// Framework module URLs — this file lives in src/server/, so entry files at the
// src/ root and folderized modules are one level up. The /__aio/ namespace
// mirrors src/ folder structure so a served module's own relative imports
// (`./vdom.ts`, `../state/signal.ts`) resolve back into /__aio/ unchanged.
const BROWSER_AIR_TS_URL = new URL("../browser-air.ts", import.meta.url);
const AIR_TS_URL = new URL("../air.ts", import.meta.url);
const LISTENERS_TS_URL = new URL("../state/listeners.ts", import.meta.url);
// Base for resolving sub-module imports served under /__aio/ (src/ root).
const AIO_SRC_BASE_URL = new URL("../", import.meta.url);

/** DEV ONLY: where a module the app imports from OUTSIDE its app root is
 *  served — `/__aio-src/<path relative to the project root>`.
 *
 *  The app root (`dirname(entry)`) is served at `/`, and a URL cannot climb
 *  above `/`: with the entry at `src/pro/app.ts`, `App.tsx`'s
 *  `import "../ui/Shell.tsx"` resolved in the browser to `/ui/Shell.tsx` =
 *  `src/pro/ui/Shell.tsx` — a 404 and a blank page — while the production
 *  bundle, which follows FILE paths, was fine. So the dev server rewrites such
 *  an import to this prefix and serves exactly the files served modules import
 *  (the bundler's graph, never the project directory). Inside `/__aio` so an
 *  app's catch-all route cannot capture it (`isReservedRoutePath`). */
export const SRC_TREE_PREFIX = "/__aio-src";

/** DEV ONLY: what the dev server compiles on request — the extensions the
 *  bundler compiles (`.jsx` is JSX to esbuild, exactly as in the bundle).
 *  `.mts` is TypeScript the bundle compiles too; left out, dev served it raw
 *  as `application/octet-stream`, which the browser refuses as a module. */
const DEV_TRANSPILED: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".jsx",
  ".mts",
]);

/** DEV ONLY: every file the dev server serves as a JavaScript MODULE — the
 *  compiled ones plus plain `.js`/`.mjs`. Each goes through
 *  `_rewriteRelativeImports`: a module whose relative imports were left as
 *  written resolves them against its own URL, which for a module outside the
 *  app root names a file nothing made servable — a 404 the bundle never had. */
const DEV_MODULE: ReadonlySet<string> = new Set([
  ...DEV_TRANSPILED,
  ".js",
  ".mjs",
]);

/** A relative import specifier in esbuild's ESM output: `from "…"`
 *  (import/export), `import("…")`, and a bare `import "…"`. The same
 *  output-shape regexes `transpile()` already relies on. */
const REL_IMPORT_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.\.?\/[^"'\n]*)\2/g;

/** An import statement's specifier, at the START of a line — so a comment
 *  that merely mentions `import "aio/server-only"` does not match. */
const LINE_IMPORT_RE =
  /^\s*import\s*(?:[^"'\n;]*?\bfrom\s*)?(["'])([^"'\n]+)\1/gm;

/** Does this module's source import the `aio/server-only` marker?
 *
 *  The marker is "the same statement" a `*.server.ts` name makes
 *  (docs/build/imports.md), and `isProtectedPath` refuses that name over HTTP
 *  in dev and prod alike. It could not refuse the marker — the rule is in the
 *  FILE, not its name — so the dev server transpiled a marked module and
 *  served it, connection strings and all, to `GET /db.ts`. Pure. */
function _declaresServerOnly(source: string): boolean {
  for (const m of source.matchAll(LINE_IMPORT_RE)) {
    if (isServerOnlyMarker(m[2]!)) return true;
  }
  return false;
}

/** `a` is `dir` or inside it (absolute paths). Pure. */
function _within(dir: string, a: string): boolean {
  const pfx = dir.endsWith(SEPARATOR) ? dir : dir + SEPARATOR;
  return a === dir || a.startsWith(pfx);
}

/** Is this (decoded) URL path under {@link SRC_TREE_PREFIX}? Pure. */
function _isSrcTreeUrl(pathname: string): boolean {
  return pathname.startsWith(SRC_TREE_PREFIX + "/");
}

/** A filesystem-relative path as URL path segments. Pure. */
function _urlPath(rel: string): string {
  return rel.split(/[\\/]/).map(encodeURIComponent).join("/");
}

/** THE project root a dev server serves {@link SRC_TREE_PREFIX} from: the
 *  directory of this app's deno.json, found by THE app-config walk
 *  (`locateDenoJsonAbove`, the one the runtime uses) — when it lies ABOVE the
 *  app root; null when the app root is the project root (nothing to add) or
 *  there is no config. @internal */
export function devSrcRoot(absBaseDir: string): string | null {
  const base = resolve(absBaseDir);
  let dir: string | null = null;
  try {
    const found = locateDenoJsonAbove(toFileUrl(base + SEPARATOR));
    if (found) dir = resolve(fromFileUrl(found.dir));
  } catch { /* no usable config above — nothing to serve */ }
  return dir !== null && dir !== base && _within(dir, base) ? dir : null;
}

/** THE dev URL of a module file — one url per file, so a file imported from
 *  two places is one module instance: the app root at `/`, else the first
 *  declared root (`assets`/`serveDirs`/`share`, by `withSlash` prefix) holding
 *  it, else {@link SRC_TREE_PREFIX} under `srcRoot`. Null when no dev root
 *  holds it. Pure. @internal */
export function devModuleUrl(
  file: string,
  absBaseDir: string,
  roots: readonly { withSlash: string; dir: string }[],
  srcRoot: string | null,
): string | null {
  const base = resolve(absBaseDir);
  if (_within(base, file)) return "/" + _urlPath(relative(base, file));
  for (const r of roots) {
    if (_within(r.dir, file)) {
      return r.withSlash + _urlPath(relative(r.dir, file));
    }
  }
  if (srcRoot && _within(srcRoot, file)) {
    return `${SRC_TREE_PREFIX}/${_urlPath(relative(srcRoot, file))}`;
  }
  return null;
}

/** Rewrite each relative import in `code` (a module served at `importerUrl`
 *  from `importerFile`) whose browser resolution is not the ONE url of the
 *  file the bundler would load (`canonicalUrl(file)`) to that url — so the
 *  import reaches the file, and a file imported from two places is one module
 *  instance, never two. An import that already resolves there is left
 *  byte-identical. Pure given its callback; exported for tests. @internal */
export function _rewriteRelativeImports(
  code: string,
  importerFile: string,
  importerUrl: string,
  canonicalUrl: (file: string, spec: string) => string | null,
): string {
  return code.replace(
    REL_IMPORT_RE,
    (m, head: string, q: string, spec: string) => {
      const cut = spec.search(/[?#]/);
      const path = cut < 0 ? spec : spec.slice(0, cut);
      const suffix = cut < 0 ? "" : spec.slice(cut);
      const file = resolve(dirname(importerFile), path);
      let natural: string | null = null;
      try {
        natural = _decodePathname(
          new URL(path, `http://h${_urlPath(importerUrl)}`).pathname,
        );
      } catch { /* unparsable — treat as not reaching the file */ }
      const url = canonicalUrl(file, spec);
      if (url === null || _decodePathname(url) === natural) return m;
      return `${head}${q}${url}${suffix}${q}`;
    },
  );
}

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
  // …and on the DECODED spelling as well as the raw one. Every caller decodes
  // before reaching the filesystem, so a rule that only reads what it was
  // handed depends on being handed the right thing — which is exactly how the
  // sibling `isShellAsset` came to answer "client route" for `/data/app%2Edb`.
  // Checking both cannot under-match: a name that really contains a `%` is
  // judged protected slightly more often, never less.
  const decoded = _decodePathname(pathname);
  const segments = [
    ...pathname.split("/"),
    ...(decoded === null ? [] : decoded.split("/")),
  ].filter((seg) => seg !== "");
  if (segments.length === 0) return false;
  // A path that cannot be decoded is not a file name — treat it as protected
  // rather than let a malformed escape decide.
  if (decoded === null) return true;
  for (const seg of segments) {
    if (seg === ".well-known") continue;
    if (seg.startsWith(".")) return true;
  }
  // LOWERCASED, because a filesystem's idea of "the same file" is not the
  // regex's. On APFS and NTFS — both shipped desktop targets — `GET
  // /secrets.server.TS` opens `secrets.server.ts`, and the case-sensitive
  // patterns answered "not protected" for it. Even on Linux a file that really
  // is named `secrets.Server.ts` walked past both rules: measured, `GET
  // /secrets.server.ts` → 404 and `GET /secrets.Server.ts` → 200 with the
  // file's contents. The prod `.ts`/`.tsx` denial is the same sentence: its
  // comment says that without it "in prod every `.ts`/`.tsx` under baseDir was
  // readable, unauthenticated".
  // Both spellings' last segments, for the same reason.
  const lasts = [
    pathname.split("/").filter((x) => x !== "").pop() ?? "",
    decoded.split("/").filter((x) => x !== "").pop() ?? "",
  ].map((x) => x.toLowerCase());
  for (const last of lasts) {
    // `.jsx` is source exactly like `.tsx` (the bundle compiled it).
    if (prod && /\.(tsx?|jsx)$/.test(last)) return true;
    if (SERVER_FILE_RE.test(last)) return true;
  }
  return false;
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
  // NOT `.txt`. It sat here beside `SHELL_FILES`' own `robots.txt` — an entry
  // that only means something if `.txt` is data-ish, which is what that list's
  // doc says it is. Nothing a sign-in page loads is a text file, and with it
  // here every `notes.txt` / `export.txt` under baseDir was an anonymous read
  // on an `auth: true` app. The public-by-convention text files are named in
  // `SHELL_FILES`, and `/.well-known/` is public as a prefix.
]);

/** The exact filenames a shell may name that carry a data-ish extension. */
const SHELL_FILES: ReadonlySet<string> = new Set([
  "manifest.json",
  "robots.txt",
  "humans.txt",
  "favicon.ico",
]);

/** May an anonymous caller fetch `pathname` on a per-user-auth app?
 *
 *  Pure, so the rule is unit-testable without a server. `dev` admits `.ts`/
 *  `.tsx`: the dev shell's import map makes the browser fetch sources BY NAME,
 *  so refusing them would make the sign-in page itself unrenderable — and in
 *  prod `isProtectedPath` denies them to everyone anyway. */
export function isShellAsset(rawPathname: string, dev: boolean): boolean {
  // DECIDE ON THE SAME SPELLING THE FILE LAYER READS.
  //
  // This gate ran on the RAW pathname and `serveFile` runs on the decoded one,
  // so one `%2E` put them on opposite sides of the same question:
  // `isShellAsset("/data/app%2Edb")` finds no `.` in the last segment, takes
  // the "extensionless → a client route" branch, and answers true — while the
  // file layer decodes it and happily serves `data/app.db`. Measured under
  // `auth: true` with no credential:
  //
  //   GET /data/app.db     → 401   GET /data/app%2Edb   → 200, the database
  //   GET /customers.csv   → 401   GET /customers%2Ecsv → 200, the rows
  //
  // That is verbatim the hole `SHELL_EXT`'s own header says it closed: "Worst
  // case is `--expose` + `auth: true`, the recommended internet-facing config:
  // an unauthenticated read of the project directory."
  //
  // A path that cannot be decoded is not a shell asset: fail CLOSED, so a
  // malformed escape is authenticated like anything else rather than waved
  // through as a client route.
  const pathname = _decodePathname(rawPathname);
  if (pathname === null) return false;
  // The framework runtime under /__aio/ is shell by definition; the control
  // plane inside it is denied by name before this is ever asked.
  if (pathname.startsWith("/__aio/")) return true;
  // RFC 8615 well-known URIs exist to be fetched by strangers — ACME
  // challenges, `security.txt`, Android's `assetlinks.json`, Apple's
  // app-site association — so an extension rule must not decide them
  // (`assetlinks.json` was a 401 on every `auth: true` app). Dotfiles
  // elsewhere stay `isProtectedPath`'s refusal.
  if (pathname.startsWith("/.well-known/")) return true;
  const segments = pathname.split("/").filter((s) => s !== "");
  const last = segments[segments.length - 1];
  // No file named at all → the SPA shell (a client route).
  if (!last) return true;
  // Extensionless → a client route, served the shell. Only the SHELL, though:
  // an extensionless FILE (`/uploads/3f9a2c`, `/LICENSE`) is refused by the
  // file layer, which is the only place that can see whether one exists —
  // see `_isShellFile` and `serveStatic`'s `anonymous` option.
  if (fileExt(last) === "" && !SHELL_FILES.has(last.toLowerCase())) {
    return true;
  }
  return _isShellFile(last, dev);
}

/** THE extension of a file name, lower-cased — one definition for every
 *  question this file asks of an extension (MIME type, text-or-binary, shell
 *  asset, blob type, route-or-file).
 *
 *  The anonymous gate lower-cased and the MIME and text lookups did not, so the
 *  same file got two answers: `b.SVG` passed the gate as a shell image and was
 *  then served `application/octet-stream` with `nosniff` — an `<img>` that
 *  never renders, a stylesheet (`f.CSS`) the browser refuses. `""` for a name
 *  with no extension, and for a dotfile (`.env` has none). Pure. */
export function fileExt(name: string): string {
  return extname(name).toLowerCase();
}

/** May an anonymous caller READ this existing file, by name? The shell's
 *  files and nothing else — an extensionless file is never one (nothing a
 *  sign-in page loads is named without an extension, and uploads saved under
 *  an id are). Pure. */
export function _isShellFile(name: string, dev: boolean): boolean {
  if (SHELL_FILES.has(name.toLowerCase())) return true;
  const ext = fileExt(name);
  if (dev && DEV_TRANSPILED.has(ext)) return true;
  return SHELL_EXT.has(ext);
}

/** Extensions that name a FILE, never a client route — a request for a
 *  missing one is a 404, not the app shell. Everything else with a dot in its
 *  last segment is route-shaped: `/u/john.doe`, `/blog/v1.2` and
 *  `/sites/example.com` are ordinary client routes, and they 404'd on reload
 *  because the fallback only covered paths with no dot at all — while
 *  `docs/ui/air-routing.md` says "Deep links just work". A missing
 *  `/lib/util.js` must stay a 404: the dev loader imports it, and an HTML page
 *  in its place is a far worse error than "not found". */
const FILE_EXT: ReadonlySet<string> = new Set([
  ...Object.keys(MIME),
  ...TEXT_EXTENSIONS,
  ...SHELL_EXT,
  ...[".jsx", ".mts", ".cts", ".wasm", ".bmp", ".tif", ".tiff", ".heic"],
  ...[".ogg", ".oga", ".ogv", ".m4a", ".aac", ".flac", ".mov", ".mkv"],
  ...[".csv", ".tsv", ".db", ".sqlite", ".sql", ".yaml", ".yml", ".toml"],
  ...[".gz", ".tgz", ".tar", ".7z", ".rar", ".bin", ".apk", ".exe"],
  ...[".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf", ".log"],
  ...[".pem", ".key", ".crt"],
]);

/** Does a request for a path that is NOT a file ask for the app shell? A
 *  missing path with no extension or with an extension that does not name a
 *  file type (`FILE_EXT`), or an existing DIRECTORY — `/docs`, `/settings/`
 *  are client routes that happen to share a name with a project folder, and
 *  aio serves no directory listings or index files, so a directory has
 *  nothing else to answer with. Pure; exported for tests. */
export function _isRouteShaped(
  ext: string,
  kind: "missing" | "directory",
): boolean {
  if (kind === "directory") return true;
  return ext === "" || !FILE_EXT.has(ext);
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
  const declared = name ? MIME[fileExt(name)] : undefined;
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
  // devOnly since the state-leak fix — see the mount in `serveStatic`.
  "/__aio/snapshot": { methods: ["GET", "HEAD", "POST"], devOnly: true },
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

/** `len` bytes from `file`'s current position, 64 KiB at a time, closing the
 *  file when they are sent, on a read error, or when the client goes away. */
function fileWindow(
  file: Deno.FsFile,
  len: number,
): ReadableStream<Uint8Array> {
  let remaining = len;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      file.close();
    } catch { /* already closed */ }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        close();
        controller.close();
        return;
      }
      const buf = new Uint8Array(Math.min(64 * 1024, remaining));
      let n: number | null;
      try {
        n = await file.read(buf);
      } catch (e) {
        close();
        controller.error(e);
        return;
      }
      if (n === null) {
        close();
        controller.close();
        return;
      }
      remaining -= n;
      controller.enqueue(buf.subarray(0, n));
    },
    cancel() {
      close();
    },
  });
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
  /** Extra read-only roots served in DEV **and PROD**, `"/urlPrefix" → dir`.
   *  Same machinery and same guards as `serveDirs`; the difference is only
   *  that these survive a build — see `CellsConfig.assets`. */
  assets?: Record<string, string>;
  /** Per `assets` prefix, directories tried PER FILE after the mount's own
   *  dir misses — a compiled binary's embedded copy of a relative mount (see
   *  `assetDirCandidates`). The mount's own dir always answers first, so a
   *  file the running app wrote there is served as it always was. */
  assetFallbacks?: Record<string, string[]>;
  /** Present only when `security.cspNonce` is on. `nonce()` mints one per
   *  response; `policy()` returns the SAME policy the server-wide headers
   *  would have sent, with that nonce in it. Handed in as a pair rather than
   *  re-derived here: the policy is `server.ts`'s to decide, and two places
   *  computing one header is how they come to disagree. */
  cspForShell?: { nonce(): string; policy(nonce: string): string | null };
  /** The declared workspace share (deno.json `share`, resolved and validated
   *  by `resolveShare`) — served at `/<basename>/…` with EVERY guard baseDir
   *  has. One fact for both worlds: the bundler resolves the same prefix. Dev
   *  only, like `serveDirs`: a prod server never reads outside its root. */
  share?: readonly ShareRoot[];
  /** DEV ONLY: told each file that becomes servable under
   *  {@link SRC_TREE_PREFIX} (once per file) — so live reload can watch
   *  exactly the source-tree files the page loads, and nothing else. */
  onSrcServed?: (file: string) => void;
  /** DEV ONLY: told each file served as a JavaScript module (`DEV_MODULE`),
   *  from ANY root — app root, `serveDirs`, `share`, `assets`, the source
   *  tree — every time it is served, transpile error or not. Live reload
   *  watches exactly these: a served `.js`/`.mjs`/`.jsx` edit reloads the
   *  page, and a module served from a root outside the watched tree is
   *  watched where it lives. Build output the page never loads stays out. */
  onModuleServed?: (file: string) => void;
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
  /** ui.layout — false drops the theme layout defaults. */
  layout?: boolean;
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
  /** The blob route answers only to a credential (a key, users, sessions or
   *  login flows) — its responses are then `private`: `public` would license
   *  a shared cache to store authenticated bytes and hand them to anyone who
   *  asks for the URL (RFC 9111 §3.5), bypassing the gate. */
  blobsPrivate?: boolean;
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

/** Per-request options for `serveStatic`. */
export interface ServeStaticOptions {
  /** The caller has NO credential on a per-user-auth app. The anonymous gate
   *  (`isShellAsset`) decides on the NAME and waves every extensionless path
   *  through as a client route — it cannot see the filesystem — so this is the
   *  half only the file layer can do: an existing file that is not a shell
   *  file answers 401 instead of its bytes. */
  anonymous?: boolean;
}

export function createStaticHandler(deps: StaticDeps): {
  serveStatic: (
    pathname: string,
    req?: Request,
    opts?: ServeStaticOptions,
  ) => Promise<Response>;
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
    {
      prefix: string;
      withSlash: string;
      dir: string;
      checked: boolean;
      fallback?: string[];
    }
  > = [
    // `assets` FIRST. It is the only one of the three that survives a build,
    // so when a prefix is declared in both, the one that works in production
    // is the one that should be working in dev — a mount that resolves
    // differently either side of a build is the whole class of bug this repo
    // calls WYSIDIWYSIP.
    ...Object.entries(deps.assets ?? {}).map(([prefix, dir]) => ({
      prefix,
      withSlash: prefix.endsWith("/") ? prefix : prefix + "/",
      dir: resolve(dir),
      checked: false,
      fallback: (deps.assetFallbacks?.[prefix] ?? []).map((d) => resolve(d)),
    })),
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

  // ── DEV: imports that leave the app root (see SRC_TREE_PREFIX) ──
  //
  // The project root is THE app-config walk's answer (`locateDenoJsonAbove`,
  // the same walk the runtime uses to find this app's deno.json) — resolved
  // on first need, never in prod. `undefined` = not resolved yet, `null` =
  // there is no project root above the app root to serve from.
  let _srcRootMemo: string | null | undefined;
  function _srcRoot(): string | null {
    if (_srcRootMemo === undefined) _srcRootMemo = devSrcRoot(deps.absBaseDir);
    return _srcRootMemo;
  }
  /** Files a served module imported from outside the app root — the ONLY
   *  files `SRC_TREE_PREFIX` serves. The browser always fetches an importer
   *  before what it imports, so the graph is known before it is requested. */
  const _srcServable = new Set<string>();
  /** Escaping imports already reported, so the warning fires once each. */
  const _srcWarned = new Set<string>();

  /** The ONE url a module file is served at — so a file imported from two
   *  places is one module instance, not two. Null when no dev root holds it
   *  (the import is then left as written, and said out loud). */
  function _canonicalUrl(file: string, spec: string): string | null {
    const sr = _srcRoot();
    const url = devModuleUrl(file, deps.absBaseDir, _roots, sr);
    if (url !== null) {
      if (url.startsWith(SRC_TREE_PREFIX + "/") && !_srcServable.has(file)) {
        _srcServable.add(file);
        deps.onSrcServed?.(file);
      }
      return url;
    }
    if (!_srcWarned.has(file)) {
      _srcWarned.add(file);
      log.warn(
        `import "${spec}" resolves to ${file}, outside this project` +
          (sr ? ` (${sr})` : "") + ` — the dev server cannot serve it, ` +
          `so the page will fail to load it. Declare its directory in ` +
          `deno.json "share" (docs/basics/project-structure.md), which the ` +
          `dev server and the bundler resolve the same way.`,
      );
    }
    return null;
  }

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
    r: { prefix: string; dir: string; checked: boolean; fallback?: string[] },
  ): Promise<void> {
    if (r.checked) return;
    r.checked = true;
    let ok = false;
    // An embedded fallback that exists serves the mount: nothing to warn.
    for (const d of [r.dir, ...(r.fallback ?? [])]) {
      try {
        ok = (await Deno.stat(d)).isDirectory;
      } catch { /* missing — reported below */ }
      if (ok) break;
    }
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
   *  one closure makes the next added parameter a one-place change.
   *
   *  The two refusals live here for the same reason. The headless-build check
   *  sat in the `/` branch only, so a prod server with no `dist/app.js`
   *  answered `/` with an honest 503 and every deep link with a 200 shell that
   *  404s its own bundle — the blank page the 503 exists to prevent, on
   *  exactly the URL a user reloads. */
  async function appShell(): Promise<Response> {
    const { prod, title, absDistDir, noCache } = deps;
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
    // A NONCE, fresh for this response, when the app asked for one. It has to
    // be minted here rather than once at boot: a nonce reused across responses
    // is a nonce an attacker reads from one page and replays into another,
    // which is the whole reason the directive exists.
    //
    // The shell then sets its OWN `Content-Security-Policy`, and the
    // server-wide applier leaves it alone — "an explicit header from a route
    // always wins" is already the rule there, so this needs no new mechanism.
    const nonce = deps.cspForShell ? deps.cspForShell.nonce() : undefined;
    const csp = nonce ? deps.cspForShell!.policy(nonce) : null;
    return new Response(
      generateHTML({
        ...(nonce ? { nonce } : {}),
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
        layout: deps.layout,
        themeName: deps.themeName,
        lang: deps.lang,
        dir: deps.dir,
        appId: deps.appId,
      }),
      {
        headers: {
          "Content-Type": "text/html",
          ...deps.noCache,
          ...(csp ? { "Content-Security-Policy": csp } : {}),
        },
      },
    );
  }

  async function serveStatic(
    pathname: string,
    req?: Request,
    opts: ServeStaticOptions = {},
  ): Promise<Response> {
    const { prod, debug, absDistDir, noCache } = deps;

    // ── Root / SPA entry ──
    if (pathname === "/") return _readOnly(req) ?? await appShell();

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

    // ── Snapshot endpoint — DEV-ONLY, never mounted in prod ──
    //
    // 🔓 It used to be mounted in every mode, and that was a state leak with
    // no floor under it. `getSnapshot` is `JSON.stringify(getState())`: the
    // RAW state, with no `ui`/`visible` filter and no `forUser` pass — by
    // design, because an operator restoring a snapshot needs the whole tree.
    // Which means every field an app carefully excluded from its client
    // projection was served, unauthenticated, to anything that could reach
    // the runtime.
    //
    // And in a packaged Electron app that includes the PAGE: the `aio://`
    // protocol handler proxies anything it cannot find on disk to the app
    // socket, path intact, so `fetch("/__aio/snapshot")` from any script in
    // the renderer is same-origin and answers 200. A `ctl` frame over the UDS
    // is the same door. Measured against `examples/counter --prod`: 200 with
    // the full state, while `/__aio/error` and the trojan correctly 404'd in
    // the same process.
    //
    // The app could not defend itself either: `/__aio/*` is a reserved
    // namespace, so a custom route matching it is warned about at boot and
    // aio keeps serving this handler. Reported by a crypto wallet built on aio, where
    // the excluded fields are the encrypted seeds, the encrypted account keys
    // and the passphrase verifier — i.e. the whole vault, copyable while the
    // wallet was LOCKED, and crackable offline from then on.
    //
    // So it is gated here, the same way and in the same place as the trojan
    // below, which reads full state for the same reasons and has always been
    // dev-only. Nothing in an app uses this at runtime: `app.snapshot()` and
    // `am snapshot` call the same helper directly and are unaffected.
    if (
      !prod && pathname === "/__aio/snapshot" && deps.getSnapshot &&
      deps.loadSnapshot
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
    // The framework namespace keeps its own answers (a 404 for what is not
    // mounted); files and the shell are read-only.
    if (!pathname.startsWith("/__")) {
      const denied = _readOnly(req);
      if (denied) return denied;
    }
    return await serveFile(pathname, req, opts);
  }

  /** Paths already warned about a write-method navigation (once each). */
  const _warnedNavWrite = new Set<string>();

  /** The 405 for a write method aimed at a file or the app shell, or null.
   *
   *  Both answered EVERY method: `POST /api/uplaod` (a typo'd route) got
   *  `200 text/html`, the shell — `res.ok` was true and the app told its user
   *  the upload worked; `DELETE /notes.txt` answered 200 with the file. A
   *  request that reaches here matched no route, so the truthful answer is
   *  the one `AIO_ROUTE_METHODS` gives the framework's own endpoints. */
  function _readOnly(req: Request | undefined): Response | null {
    const method = req?.method ?? "GET";
    if (method === "GET" || method === "HEAD") return null;
    // A browser NAVIGATION that POSTs lands a person on a page — a payment
    // provider's return URL, a SAML/OIDC `form_post`, a form submitted before
    // hydration. 1.0.11 served it, and a 405 text page strands that user, so
    // it keeps the old answer and says so (frozen surface). Only a fetch —
    // the typo'd-upload case, which reads `res.ok` — gets the 405.
    // Fetch metadata is not on every navigation — Chromium sends it only to a
    // potentially trustworthy origin (not a LAN address over plain http, the
    // `--expose` / remote-APK case), Safari only since 16.4. With none, a
    // navigation still says `Accept: text/html`; a fetch says `*/*`.
    const mode = req!.headers.get("sec-fetch-mode");
    const navigation = mode === null
      ? (req!.headers.get("accept") ?? "").includes("text/html")
      : mode === "navigate";
    if (navigation) {
      const path = new URL(req!.url).pathname;
      // Bounded: the path is the caller's, and a warn-once set must not grow
      // with every URL a client invents.
      if (_warnedNavWrite.size < 64 && !_warnedNavWrite.has(path)) {
        _warnedNavWrite.add(path);
        log.warn(
          "http",
          `${method} navigation to ${path} matched no route — serving it as ` +
            `GET (the request body is dropped). Declare the endpoint in ` +
            `aio.run({ routes }) to read what was posted.`,
        );
      }
      return null;
    }
    return new Response(
      `Method Not Allowed — no route handles ${method} here; files and the ` +
        `app shell serve GET, HEAD. Declare the endpoint in ` +
        `aio.run({ routes }).`,
      { status: 405, headers: { Allow: "GET, HEAD" } },
    );
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
      "Cache-Control": `${
        deps.blobsPrivate ? "private" : "public"
      }, max-age=31536000, immutable`,
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
      // Two accepted shapes (a full health document, or a bare cells map from
      // a host that supplies its own `getHealth`), told apart on their VALUES
      // rather than on a key name — see `healthCells` for the two ways the
      // name guess was wrong.
      const cells = healthCells(deps.getHealth?.());
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
        // The IDENTITY, not the window title — the same name the page's theme
        // hue comes from. `themeName`'s own doc on this deps type says "the
        // appId, so the UI and the icon are the same colour", and this line
        // read `title` instead: the moment an author gave their app a human
        // title (`appId: "notes-app"`, `ui.title: "My Notes"` — the normal
        // case; the scaffold only matches because `am create` writes
        // `title = name`) the favicon in the tab was a different hue from the
        // page it labels. Measured: page `--aio-hue: 148`, icon gradient 190.
        // CLAUDE.md and the `ui.theme` docs both promise "one app is one
        // colour everywhere it appears".
        body: appIconSvg(deps.themeName || deps.title),
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
      // Full scale = the configured FROZEN tier — the same thresholds the
      // probes grade against. Fixed capacities (1000 actions, 100ms) drew a
      // tuned app's frozen queue as a near-empty gauge.
      const serverGauges = {
        "server.queueDepth": _gaugeOf(
          "server.queueDepth",
          loopVitals.queueDepth,
          vs.thresholds.queue.frozen,
        ),
        "server.reduceTime": _gaugeOf(
          "server.reduceTime",
          loopVitals.p95ReduceTime,
          vs.thresholds.loop.frozen,
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

  /** A file's bytes, straight from disk — never held whole in memory — with
   *  byte ranges.
   *
   *  `docs/build/imports.md` promises `assets` mounts "range requests", and
   *  the static path had none: every binary was `Deno.readFile`d whole on
   *  every request and a `Range:` header was ignored. A video element seeks
   *  with ranges, so a 300 MB mp4 cost 300 MB of heap PER request — measured,
   *  four concurrent `Range: bytes=0-1023` requests took RSS to ~2.6 GB to
   *  send 4 KB. Now: one open file per request, 64 KiB at a time, 206 for a
   *  satisfiable range, 416 for one past the end — the blob route's contract
   *  (`parseByteRange`), which already streamed.
   *
   *  `If-Range` is honoured by never letting it match: the validator here is
   *  WEAK (mtime+size), and RFC 9110 §13.1.5 forbids a weak tag from
   *  satisfying If-Range — so a client resuming against a changed file gets
   *  the whole new file rather than a splice of two versions. A conditional
   *  GET that matches serves the plain 200 path, which `encodeResponse` turns
   *  into the 304. */
  async function serveFromDisk(
    filepath: string,
    st: Deno.FileInfo,
    ext: string,
    isText: boolean,
    req?: Request,
  ): Promise<Response> {
    const etag = `W/"${st.mtime?.getTime() ?? 0}-${st.size}"`;
    const headers: Record<string, string> = {
      "Content-Type": MIME[ext] ??
        (isText ? "text/plain" : "application/octet-stream"),
      // A VALIDATOR. Prod sets `Cache-Control: no-cache` on every static
      // file, and `no-cache` means "you may cache, but revalidate" —
      // revalidation needs a validator, and images, fonts, wasm and video had
      // none: `encodeResponse` returns early for incompressible types, ABOVE
      // its conditional-request block, so every one of them was a full
      // re-download on every page load.
      //
      // Weak, and from `stat` — no read, no hash: the bytes are identical
      // whenever mtime and size are, which is exactly what a weak validator
      // asserts.
      ETag: etag,
      "Accept-Ranges": "bytes",
      ...deps.noCache,
    };
    const method = req?.method.toUpperCase() ?? "GET";
    // A conditional GET that will be answered 304 is not ranged — unless the
    // response is `no-store` (dev), where `encodeResponse` never revalidates.
    const revalidates =
      !(headers["Cache-Control"] ?? "").includes("no-store") &&
      etagMatches(req?.headers.get("if-none-match") ?? null, etag);
    const ranged = (method === "GET" || method === "HEAD") &&
      !req?.headers.has("if-range") && !revalidates;
    const range = ranged
      ? parseByteRange(req?.headers.get("range") ?? null, st.size)
      : null;
    if (range === "unsatisfiable") {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${st.size}` },
      });
    }
    let file: Deno.FsFile;
    try {
      file = await Deno.open(filepath, { read: true });
    } catch (e) {
      if (isNotServable(e)) return new Response("Not Found", { status: 404 });
      log.error("server", `static: cannot open ${filepath} — ${e}`);
      return new Response("Internal Server Error", { status: 500 });
    }
    const start = range ? range.start : 0;
    const len = range ? range.end - range.start : st.size;
    try {
      if (start > 0) await file.seek(start, Deno.SeekMode.Start);
    } catch (e) {
      file.close();
      log.error("server", `static: cannot seek ${filepath} — ${e}`);
      return new Response("Internal Server Error", { status: 500 });
    }
    const body = fileWindow(file, len);
    headers["Content-Length"] = String(len);
    if (!range) return new Response(body, { status: 200, headers });
    headers["Content-Range"] = `bytes ${range.start}-${
      range.end - 1
    }/${st.size}`;
    return new Response(body, { status: 206, headers });
  }

  /** Serve a file from baseDir — handles SPA fallback, transpilation, binary/text */
  async function serveFile(
    rawPathname: string,
    req?: Request,
    opts: ServeStaticOptions = {},
  ): Promise<Response> {
    const { prod, debug, absBaseDir, noCache } = deps;

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
    // DEV: a module imported from outside the app root (SRC_TREE_PREFIX).
    // Prod never mounts it — the bundle already followed the import.
    const srcTree = !prod && _isSrcTreeUrl(pathname);
    if (srcTree) {
      const sr = _srcRoot();
      if (!sr) return new Response("Not Found", { status: 404 });
      root = sr;
      rel = pathname.slice(SRC_TREE_PREFIX.length + 1);
      matchedRoot = true;
    }
    for (const r of matchedRoot ? [] : _roots) {
      if (pathname === r.prefix || pathname.startsWith(r.withSlash)) {
        await _warnIfMissing(r);
        root = r.dir; // absolute — see _roots
        rel = pathname.slice(r.withSlash.length).replace(/^\//, "");
        matchedRoot = true;
        // Per FILE, like the app-dir ladder below: the mount's own dir first,
        // an embedded copy only for what it does not hold (a miss 404s from
        // the mount's own dir, as it always did).
        if (r.fallback?.length && !(await _pathExists(resolve(root, rel)))) {
          for (const d of r.fallback) {
            if (await _pathExists(resolve(d, rel))) {
              root = d;
              break;
            }
          }
        }
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
    // The source tree is not an HTTP root: only what a served module imported.
    if (srcTree && !_srcServable.has(filepath)) {
      return new Response("Not Found", { status: 404 });
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
    // `/about/` is a SPA route, and so is a real directory (`_isRouteShaped`).
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
    const ext = fileExt(filepath);

    // SPA fallback (not internal /__* APIs): a path that names no FILE is a
    // client route — see `_isRouteShaped`. An existing file always wins.
    let kind: "file" | "directory" | "missing" = "missing";
    try {
      kind = (await Deno.stat(filepath)).isDirectory ? "directory" : "file";
    } catch { /* not there (or unreadable) — a route candidate */ }
    if (
      !pathname.startsWith("/__") && kind !== "file" &&
      _isRouteShaped(ext, kind)
    ) {
      return await appShell();
    }
    // Anonymous on a per-user-auth app: an existing file is served only when
    // it is part of the shell. The gate upstream let every extensionless name
    // through as a client route, and the shell fallback above is the whole of
    // what that promise covers — `/uploads/3f9a2c` (an upload stored under its
    // id) and `/LICENSE` were served, bytes and all, with no credential.
    // `/.well-known/` is public by design (see `isShellAsset`): ACME tokens
    // are extensionless files.
    if (
      opts.anonymous && kind === "file" &&
      !pathname.startsWith("/.well-known/") &&
      !_isShellFile(filepath.split(/[\\/]/).pop() ?? "", !prod)
    ) {
      return new Response(
        `Unauthorized — ${rawPathname} is app DATA, and this app's public ` +
          `surface is its SHELL (the code, styles and fonts the sign-in page ` +
          `needs), not its directory. Sign in; publish a deliberately-public ` +
          `file through \`serveDirs\`.`,
        { status: 401 },
      );
    }

    // Dev modules (DEV_MODULE) are compiled and/or import-rewritten, never
    // served verbatim — so they stay on the text path whatever their size.
    const transpiled = !prod && DEV_TRANSPILED.has(ext);
    const devModule = !prod && DEV_MODULE.has(ext);
    const isText = TEXT_EXTENSIONS.has(ext) || devModule;

    // Binary files — and text too large to hold (see `serveFromDisk`).
    let st: Deno.FileInfo | null = null;
    if (!isText || !devModule) {
      try {
        st = await Deno.stat(filepath);
      } catch {
        if (!isText) return new Response("Not Found", { status: 404 });
      }
    }
    if (!isText && !st?.isFile) {
      return new Response("Not Found", { status: 404 });
    }
    if (st?.isFile && (!isText || st.size > MAX_BUFFER_BYTES)) {
      return await serveFromDisk(filepath, st, ext, isText, req);
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
    // A module that declares `import "aio/server-only"` is a `*.server.ts` by
    // another spelling — the same 404 (see `_declaresServerOnly`).
    if (DEV_MODULE.has(ext) && _declaresServerOnly(body)) {
      return new Response("Not found", { status: 404 });
    }
    // Before the transpile: a module that fails to compile is still on the
    // page, and the edit that fixes it must reload it.
    if (devModule) deps.onModuleServed?.(filepath);

    let contentType = MIME[ext] ?? "text/plain";

    // Dev only: a plain-JS module is served as written, except for the
    // relative imports whose browser resolution is not the file's one url.
    if (devModule && !transpiled) {
      body = _rewriteRelativeImports(body, filepath, pathname, _canonicalUrl);
    }

    // Dev only: live-transpile .ts/.tsx/.jsx via esbuild
    if (transpiled) {
      try {
        body = _rewriteRelativeImports(
          await transpile(body, filepath, debug),
          filepath,
          pathname,
          _canonicalUrl,
        );
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
