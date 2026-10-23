// serve-file.ts — a file's bytes over HTTP with single-range support: THE
// Range contract (`parseByteRange`, 206/416, a window streamed 64 KiB at a
// time and closed on cancel) shared by `/__aio/blobs/<id>`, the static
// server and the public `serveFile()` (`aio/server`).

import { extname } from "@std/path";
import { MIME } from "./server-html-constants.ts";
import { etagMatches } from "./http-encoding.ts";

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

/** A 416 describes the ERROR body it carries: plain text, with the
 *  Content-Range naming the size (RFC 9110 §15.5.17). It used to carry the
 *  file's own Content-Type and ETag — a "image/png" label, and a validator,
 *  on the text "Range Not Satisfiable". */
export function unsatisfiable(size: number): Response {
  return new Response("Range Not Satisfiable", {
    status: 416,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Range": `bytes */${size}`,
      "Cache-Control": "no-store",
    },
  });
}

/** `len` bytes from `file`'s current position, 64 KiB at a time, closing the
 *  file when they are sent, on a read error, or when the client goes away. */
export function fileWindow(
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
      // Closed with the last byte, not on a next pull: a client that has
      // every byte by Content-Length never asks for one, and the file stayed
      // open until the connection went (a loaded test run saw the leak).
      if (remaining <= 0) {
        close();
        controller.close();
      }
    },
    cancel() {
      close();
    },
  });
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
  const declared = name ? MIME[extname(name).toLowerCase()] : undefined;
  if (!declared) return "application/octet-stream";
  const base = declared.split(";")[0]!.trim().toLowerCase();
  if (BLOB_INLINE_TYPES.has(base)) return base;
  if (base.startsWith("video/") || base.startsWith("audio/")) return base;
  return "application/octet-stream";
}

/** Options for {@linkcode serveFile}. */
export interface ServeFileOptions {
  /** The Content-Type to send. Default: from the extension, through the same
   *  inert allowlist the blob route uses — images (not SVG), video, audio,
   *  PDF and plain text keep their type, anything else is
   *  `application/octet-stream`. A type given here is sent as given. */
  type?: string;
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
  // PATH_MAX is POSIX's: Windows takes far longer (`\\?\` and long paths).
  if (
    Deno.build.os !== "windows" &&
    _utf8.encode(filepath).byteLength > MAX_PATH_BYTES
  ) return true;
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

/** A Windows device name. Measured on Windows 11: `NUL` opens and then
 *  fails its stat ("Incorrect function"), while `aux.txt`, `con.json`,
 *  `nul.txt` — even a bare `aux` — are ordinary files. So the name alone
 *  decides nothing: only a stat that FAILED on such a name is a 404. */
const WINDOWS_DEVICE =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/** True when `path` cannot name a servable file before the filesystem is
 *  asked: too long ({@linkcode cannotExist}), or a NUL byte (Deno throws a
 *  TypeError naming it). */
function noSuchFile(path: string): boolean {
  return path.includes("\0") || cannotExist(path);
}

/** A failed stat of an opened `path` that is a Windows device, not a file. */
function isWindowsDevice(path: string): boolean {
  if (Deno.build.os !== "windows") return false;
  const name = path.split(/[\\/]/).at(-1) ?? "";
  return WINDOWS_DEVICE.test(name.replace(/[. ]+$/, ""));
}

/** Serve the file at `path` (a filesystem path the APP chose — never a raw
 *  request path; containment is the caller's) the way `/__aio/blobs/<id>`
 *  serves a blob: GET/HEAD (405 otherwise), `Accept-Ranges: bytes`, a single
 *  range → 206 with `Content-Range`, a range past the end → 416, a malformed
 *  or multi-range header → the whole file (200). Streamed from disk 64 KiB at
 *  a time; the file is closed when sent, on error, and when the client goes
 *  away. `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
 *  sandbox` on every reply; a weak mtime+size ETag answers `If-None-Match`
 *  with 304 (and never satisfies `If-Range`, so a changed file is sent whole).
 *  A missing path or a directory is 404.
 *
 *  ```ts
 *  import { route, serveFile } from "aio/server";
 *  routes: { "/media/:name": route((ctx) =>
 *    serveFile(ctx.req, join(mediaDir, basename(ctx.params.name)))) }
 *  ``` */
export async function serveFile(
  req: Request,
  path: string,
  opts: ServeFileOptions = {},
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }
  // Not there, a path through a file, a symlink loop, a name no filesystem
  // holds: 404, as the static files answer — a 500 put an error line naming
  // the absolute path in the log for any anonymous request.
  if (noSuchFile(path)) return new Response("Not Found", { status: 404 });
  let file: Deno.FsFile;
  let st: Deno.FileInfo;
  try {
    file = await Deno.open(path, { read: true });
  } catch (e) {
    if (isNotServable(e) || e instanceof Deno.errors.IsADirectory) {
      return new Response("Not Found", { status: 404 });
    }
    throw e;
  }
  try {
    st = await file.stat();
  } catch (e) {
    file.close();
    if (isWindowsDevice(path)) {
      return new Response("Not Found", { status: 404 });
    }
    throw e;
  }
  if (!st.isFile) {
    file.close();
    return new Response("Not Found", { status: 404 });
  }
  const etag = `W/"${st.mtime?.getTime() ?? 0}-${st.size}"`;
  const headers: Record<string, string> = {
    "Content-Type": opts.type ?? blobContentType(path),
    "Accept-Ranges": "bytes",
    "ETag": etag,
    // `no-transform`: never compressed on the way out, as the blob route —
    // a gzipped 200 and a raw 206 under one ETag glue into garbage when a
    // download is resumed (`curl -C`, `wget -c`).
    "Cache-Control": "no-cache, no-transform",
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
  };
  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    file.close();
    return new Response(null, { status: 304, headers });
  }
  // A weak validator never satisfies If-Range (RFC 9110 §13.1.5): whole file.
  const range = req.headers.has("if-range")
    ? null
    : parseByteRange(req.headers.get("range"), st.size);
  if (range === "unsatisfiable") {
    file.close();
    return unsatisfiable(st.size);
  }
  const start = range ? range.start : 0;
  const len = range ? range.end - range.start : st.size;
  try {
    if (start > 0) await file.seek(start, Deno.SeekMode.Start);
  } catch (e) {
    file.close();
    throw e;
  }
  headers["Content-Length"] = String(len);
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${
      range.end - 1
    }/${st.size}`;
  }
  return new Response(fileWindow(file, len), {
    status: range ? 206 : 200,
    headers,
  });
}
