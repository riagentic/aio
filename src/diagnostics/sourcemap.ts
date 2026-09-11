// sourcemap.ts — turn `app.js:1:22073` back into `src/App.tsx:12:5`.
//
// THE PROBLEM. Two field reports call the renderer-console forwarder the best
// thing in the box: a `console.error` in the browser lands in the server's
// log, where an agent or a tail can actually see it. Every one of those lines
// pointed at the bundle — `app.js:1:22073` — because the client bundle is one
// minified line and nothing ever mapped it back. The strongest feature in the
// framework, undercut by a position nobody can act on.
//
// WHY THE ESBUILD FLAG IS NOT THE FIX. `grep -rn sourcemap src/build*` returned
// nothing, so the obvious reading is "turn on esbuild's sourcemap". That alone
// changes nothing here: a browser does NOT apply a source map to
// `error.stack`. Devtools maps frames for DISPLAY; the string the page reads
// and forwards still carries generated positions. The map has to be applied by
// whoever renders the text, and that is the server.
//
// So: esbuild emits the map, the server keeps it, and every forwarded stack or
// call site is translated before it is written. Zero dependencies and pure —
// `decodeVlq`/`mapPosition`/`remapStack` take data and return data, which is
// what makes the 40 lines of VLQ worth auditing.
//
// BEST-EFFORT BY CONSTRUCTION, like the call-site capture it serves. A missing
// map, an unparseable map, a position with no mapping: the text is returned
// exactly as it arrived. A remapper that throws would take down the one channel
// a browser reports its own errors on.

/** A parsed source map, ready for lookups. */
export type SourceMapIndex = {
  /** `sources`, with `sourceRoot` already applied. */
  readonly sources: readonly string[];
  /** Per generated line (0-based): segments sorted by generated column. */
  readonly lines: ReadonlyArray<readonly SourceMapSegment[]>;
};

/** One decoded mapping segment. All fields 0-based, as the format stores them. */
export type SourceMapSegment = {
  readonly genCol: number;
  readonly source: number;
  readonly line: number;
  readonly col: number;
};

/** Where a generated position came from. `line`/`column` are 1-based, matching
 *  how a stack frame is written and read. */
export type OriginalPosition = {
  readonly source: string;
  readonly line: number;
  readonly column: number;
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64-VLQ → the signed integers of one segment. Pure; never throws — a
 *  character outside the alphabet ends the segment, which is what an
 *  unparseable map should do (yield nothing) rather than take the caller with
 *  it. */
export function decodeVlq(s: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < s.length; i++) {
    const digit = B64.indexOf(s[i]!);
    if (digit < 0) return out;
    const cont = (digit & 32) !== 0;
    value += (digit & 31) << shift;
    if (cont) {
      shift += 5;
      continue;
    }
    // The low bit is the SIGN, not magnitude — `-0` is a legal encoding and
    // means "the largest negative", which a naive `value >> 1` gets wrong by
    // reporting 0 and silently shifting every later column in the segment.
    const negative = (value & 1) === 1;
    const magnitude = value >> 1;
    out.push(
      negative ? (magnitude === 0 ? -0x80000000 : -magnitude) : magnitude,
    );
    value = 0;
    shift = 0;
  }
  return out;
}

/** Parse a source map's JSON text. Returns `null` for anything unusable —
 *  absent, malformed, or a map with no `mappings` — so a caller has exactly one
 *  thing to check. */
export function parseSourceMap(json: string): SourceMapIndex | null {
  let raw: {
    sources?: unknown;
    sourceRoot?: unknown;
    mappings?: unknown;
  };
  try {
    raw = JSON.parse(json);
  } catch {
    return null; // aio-ok: an unparseable map is an absent map
  }
  if (!Array.isArray(raw.sources) || typeof raw.mappings !== "string") {
    return null;
  }
  const root = typeof raw.sourceRoot === "string" && raw.sourceRoot
    ? raw.sourceRoot.replace(/\/$/, "") + "/"
    : "";
  const sources = raw.sources.map((s) => root + String(s));

  const lines: SourceMapSegment[][] = [];
  // The four running totals the format is built on: every field after the
  // generated column is a DELTA against the previous segment, and `source`,
  // `line` and `col` carry across generated lines while `genCol` resets.
  let src = 0, line = 0, col = 0;
  for (const group of raw.mappings.split(";")) {
    const segs: SourceMapSegment[] = [];
    let genCol = 0;
    if (group) {
      for (const part of group.split(",")) {
        if (!part) continue;
        const f = decodeVlq(part);
        if (f.length === 0) continue;
        genCol += f[0]!;
        // A 1-field segment is "generated code with no origin" — a real and
        // common shape (esbuild's banner, injected helpers). It is not a
        // mapping, and treating it as one attributes the framework's own
        // prelude to the app's first source file.
        if (f.length < 4) continue;
        src += f[1]!;
        line += f[2]!;
        col += f[3]!;
        segs.push({ genCol, source: src, line, col });
      }
    }
    segs.sort((a, b) => a.genCol - b.genCol);
    lines.push(segs);
  }
  return { sources, lines };
}

/** The original position for a 1-based generated `line`/`column`, or `null`.
 *
 *  Binary search for the LAST segment at or before the column — the mapping
 *  that covers a position is the one that starts on or before it, and a
 *  minified bundle puts thousands of segments on line 1, where a linear scan is
 *  the difference between free and noticeable on a busy error channel. */
export function mapPosition(
  map: SourceMapIndex,
  line: number,
  column: number,
): OriginalPosition | null {
  const segs = map.lines[line - 1];
  if (!segs || segs.length === 0) return null;
  const target = column - 1;
  let lo = 0, hi = segs.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.genCol <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const seg = segs[found]!;
  const source = map.sources[seg.source];
  if (source === undefined) return null;
  return { source, line: seg.line + 1, column: seg.col + 1 };
}

/** Every `…:LINE:COL` in `text`, rewritten through `map`.
 *
 *  Deliberately shape-agnostic: it rewrites the POSITION and leaves the rest of
 *  the frame — `at fn (`, the URL, the closing paren — exactly as the engine
 *  wrote it, because `Error.stack` is not standardised and a parser that
 *  insisted on V8's shape would silently do nothing in a different engine. A
 *  position that maps to nothing is left alone, so a partially-mapped stack is
 *  still a stack. */
export function remapStack(
  text: string,
  map: SourceMapIndex | null,
  opts: { readonly only?: RegExp } = {},
): string {
  if (!map) return text;
  return text.replace(
    /([^\s():]+):(\d+):(\d+)/g,
    (whole, file: string, l: string, c: string) => {
      // `only` scopes the rewrite to the bundle's own filename. Without it a
      // stack that mentions any `name:1:2` — including one already mapped —
      // would be run through the bundle's map and come out wrong.
      if (opts.only && !opts.only.test(file)) return whole;
      const pos = mapPosition(map, Number(l), Number(c));
      if (!pos) return whole;
      return `${pos.source}:${pos.line}:${pos.column}`;
    },
  );
}
