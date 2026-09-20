// How many BYTES a string is on the wire and on disk — the unit every size
// limit in aio is declared in.
//
// `"…".length` is UTF-16 code units, not bytes, and the two agree only for
// ASCII. A CJK document is ~3× its `length` in UTF-8, so a limit written as
// "1MB" and checked against `length` passed 3 MB of Japanese text — the
// budgets' own doc says bytes, and the measurement said characters.
//
// Cheap on the hot path, which is why this is not simply
// `new TextEncoder().encode(s).byteLength`: that allocates a copy of the whole
// string (16 MB of garbage per check on a 16 MB cell, per persist window).
// `utf8Size` counts instead, and `overUtf8` answers the only question a limit
// ever asks — "is this over N bytes?" — usually without looking at the string
// at all, because a string shorter than N/3 code units cannot be.

/** Exact UTF-8 byte length of `s`. Counts; never allocates. */
export function utf8Size(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // A surrogate PAIR is one 4-byte code point; a lone surrogate is
      // replaced by U+FFFD on encode, which is 3 bytes — both counted here
      // exactly as `TextEncoder` would.
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** Is `s` more than `limit` UTF-8 bytes? Answers without counting whenever the
 *  code-unit length settles it: at most 3 bytes per code unit (a surrogate
 *  pair is 2 units and 4 bytes, so the bound holds), and at least 1. */
export function overUtf8(s: string, limit: number): boolean {
  if (s.length > limit) return true; // ≥ 1 byte per unit
  if (s.length * 3 <= limit) return false; // ≤ 3 bytes per unit
  return utf8Size(s) > limit;
}
