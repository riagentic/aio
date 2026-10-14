// updates-zstd.ts — a Zstandard frame decoder (RFC 8878), for update patches.
//
// An update patch is ONE zstd frame made with `zstd --patch-from=<installed
// artifact>`: the installed file is the history the frame's matches point
// into, so two builds a commit apart differ by kilobytes. Deno's own
// `node:zlib` zstd ignores its `dictionary` option (measured, Deno 2.9.7: the
// same frame Node decodes is "Data corruption detected"), so the decoder is
// here — TypeScript, no binary, nothing fetched.
//
// The caller lays the history and the output out in ONE buffer: history
// first, the decoded bytes straight after it. A match is then a plain copy
// inside that buffer, whatever it points at.
//
// What it does NOT do: verify the frame's own checksum, or take a trained
// dictionary (a frame naming a dictionary id is refused). Its only caller
// compares the SHA-256 of the whole output with a signed manifest before the
// bytes are used for anything — that check is the trust root, this file is
// plumbing. Any malformed input throws; nothing here can loop forever.

const MAGIC = 0xfd2fb528;

function bad(why: string): Error {
  return new Error(`not a usable zstd frame: ${why}`);
}

/** `n` bits (n ≤ 24) at bit position `p`, least significant first. A byte
 *  past the end reads as zero. */
function bitsAt(d: Uint8Array, p: number, n: number): number {
  const b = p >>> 3;
  return (((d[b]! | d[b + 1]! << 8 | d[b + 2]! << 16 | d[b + 3]! << 24) >>>
    (p & 7)) & ((1 << n) - 1)) >>> 0;
}

/** A bit stream read from its END (what FSE and Huffman streams are): `p` is
 *  how many bits are left. */
type Rev = { d: Uint8Array; p: number };

function rev(d: Uint8Array): Rev {
  const last = d[d.length - 1];
  if (!last) throw bad("a bit stream has no end mark");
  return { d, p: d.length * 8 + 23 - Math.clz32(last) };
}

/** The next `n` bits (n ≤ 24). Past the start the missing low bits are zero,
 *  and `p` goes negative — which is how a stream's end is seen. */
function take(r: Rev, n: number): number {
  r.p -= n;
  if (r.p >= 0) return bitsAt(r.d, r.p, n);
  const have = n + r.p;
  return have <= 0 ? 0 : bitsAt(r.d, 0, have) << -r.p;
}

/** One FSE decoding table: per state, its symbol and how the next state is
 *  read. */
type Fse = {
  log: number;
  sym: Uint8Array;
  bits: Uint8Array;
  base: Uint16Array;
};

function fseTable(norm: ArrayLike<number>, log: number): Fse {
  const size = 1 << log;
  const sym = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const base = new Uint16Array(size);
  const next = new Uint16Array(norm.length);
  let high = size;
  for (let s = 0; s < norm.length; s++) {
    if (norm[s] === -1) {
      sym[--high] = s;
      next[s] = 1;
    }
  }
  const step = (size >> 1) + (size >> 3) + 3;
  let pos = 0;
  for (let s = 0; s < norm.length; s++) {
    const n = norm[s]!;
    if (n <= 0) continue;
    next[s] = n;
    for (let i = 0; i < n; i++) {
      sym[pos] = s;
      do pos = (pos + step) & (size - 1); while (pos >= high);
    }
  }
  if (pos !== 0) throw bad("an FSE table does not add up");
  for (let i = 0; i < size; i++) {
    const n = next[sym[i]!]!++;
    bits[i] = log - (31 - Math.clz32(n));
    base[i] = (n << bits[i]!) - size;
  }
  return { log, sym, bits, base };
}

/** A table that only ever yields `s` (RLE mode). */
function fseOne(s: number): Fse {
  return {
    log: 0,
    sym: Uint8Array.of(s),
    bits: new Uint8Array(1),
    base: new Uint16Array(1),
  };
}

/** Read an FSE table description from the start of `d`; `end` is the first
 *  byte after it. */
function readFse(
  d: Uint8Array,
  maxLog: number,
  maxSym: number,
): { t: Fse; end: number } {
  const log = bitsAt(d, 0, 4) + 5;
  if (log > maxLog) throw bad("an FSE table is larger than its kind allows");
  const norm = new Int16Array(maxSym + 1);
  let p = 4;
  let left = 1 << log;
  let s = 0;
  while (left > 0 && s <= maxSym) {
    const n = 32 - Math.clz32(left + 1);
    let v = bitsAt(d, p, n);
    const low = (1 << (n - 1)) - 1;
    const thresh = (1 << n) - 1 - (left + 1);
    if ((v & low) < thresh) {
      v &= low;
      p += n - 1;
    } else {
      if (v > low) v -= thresh;
      p += n;
    }
    const proba = v - 1;
    left -= proba < 0 ? 1 : proba;
    norm[s++] = proba;
    if (proba === 0) {
      for (let rep = 3; rep === 3;) {
        rep = bitsAt(d, p, 2);
        p += 2;
        s += rep;
      }
    }
  }
  const end = (p + 7) >>> 3;
  if (left !== 0 || s > maxSym + 1 || end > d.length) {
    throw bad("an FSE table description is damaged");
  }
  return { t: fseTable(norm, log), end };
}

/** A Huffman decoding table: indexed by the next `log` bits. */
type Huf = { log: number; sym: Uint8Array; len: Uint8Array };

function readHuf(d: Uint8Array): { t: Huf; end: number } {
  const head = d[0]!;
  const w = new Uint8Array(256);
  let n = 0;
  let end: number;
  if (head >= 128) {
    n = head - 127;
    end = 1 + ((n + 1) >> 1);
    for (let i = 0; i < n; i++) {
      const b = d[1 + (i >> 1)]!;
      w[i] = i & 1 ? b & 15 : b >> 4;
    }
  } else {
    end = 1 + head;
    const body = d.subarray(1, end);
    const { t, end: at } = readFse(body, 6, 255);
    const r = rev(body.subarray(at));
    let a = take(r, t.log);
    let b = take(r, t.log);
    for (;;) {
      if (n > 253) throw bad("a Huffman table has too many weights");
      w[n++] = t.sym[a]!;
      a = t.base[a]! + take(r, t.bits[a]!);
      if (r.p < 0) {
        w[n++] = t.sym[b]!;
        break;
      }
      w[n++] = t.sym[b]!;
      b = t.base[b]! + take(r, t.bits[b]!);
      if (r.p < 0) {
        w[n++] = t.sym[a]!;
        break;
      }
    }
  }
  if (end > d.length) throw bad("a Huffman table is cut short");
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (w[i]! > 11) throw bad("a Huffman weight is out of range");
    if (w[i]) total += 1 << (w[i]! - 1);
  }
  if (total === 0) throw bad("a Huffman table is empty");
  const log = 32 - Math.clz32(total);
  const rest = (1 << log) - total;
  if (log > 11 || (rest & (rest - 1)) !== 0) {
    throw bad("Huffman weights do not add up");
  }
  w[n++] = 32 - Math.clz32(rest);
  const sym = new Uint8Array(1 << log);
  const len = new Uint8Array(1 << log);
  let pos = 0;
  for (let x = 1; x <= log; x++) {
    for (let s = 0; s < n; s++) {
      if (w[s] !== x) continue;
      const span = 1 << (x - 1);
      sym.fill(s, pos, pos + span);
      len.fill(log + 1 - x, pos, pos + span);
      pos += span;
    }
  }
  return { t: { log, sym, len }, end };
}

function hufStream(
  t: Huf,
  d: Uint8Array,
  out: Uint8Array,
  at: number,
  n: number,
): void {
  const r = rev(d);
  for (let i = 0; i < n; i++) {
    const v = take(r, t.log);
    out[at + i] = t.sym[v]!;
    r.p += t.log - t.len[v]!;
  }
  if (r.p !== 0) throw bad("a Huffman stream does not end where it says");
}

/** What one block leaves for the next: the tables a later block may repeat,
 *  and the three most recent match offsets. */
type Carry = {
  huf?: Huf;
  ll?: Fse;
  of?: Fse;
  ml?: Fse;
  rep: [number, number, number];
};

function literals(
  d: Uint8Array,
  carry: Carry,
): { lit: Uint8Array; end: number } {
  const b0 = d[0]!;
  const type = b0 & 3;
  const fmt = (b0 >> 2) & 3;
  if (type < 2) {
    const head = fmt === 1 ? 2 : fmt === 3 ? 3 : 1;
    const size = head === 1 ? b0 >> 3 : bitsAt(d, 4, head === 2 ? 12 : 20);
    const end = head + (type === 0 ? size : 1);
    if (end > d.length) throw bad("literals are cut short");
    return {
      lit: type === 0
        ? d.subarray(head, end)
        : new Uint8Array(size).fill(d[head]!),
      end,
    };
  }
  const n = fmt < 2 ? 10 : fmt === 2 ? 14 : 18;
  const head = fmt < 2 ? 3 : fmt + 2;
  const regen = bitsAt(d, 4, n);
  const end = head + bitsAt(d, 4 + n, n);
  if (end > d.length) throw bad("literals are cut short");
  let body = d.subarray(head, end);
  if (type === 2) {
    const h = readHuf(body);
    carry.huf = h.t;
    body = body.subarray(h.end);
  }
  const huf = carry.huf;
  if (!huf) throw bad("literals reuse a Huffman table that was never sent");
  const lit = new Uint8Array(regen);
  if (fmt === 0) {
    hufStream(huf, body, lit, 0, regen);
    return { lit, end };
  }
  const q = (regen + 3) >> 2;
  const sizes = [0, 2, 4].map((i) => body[i]! | body[i + 1]! << 8);
  sizes.push(body.length - 6 - sizes[0]! - sizes[1]! - sizes[2]!);
  if (sizes[3]! < 0 || regen < 3 * q) {
    throw bad("literal streams are cut short");
  }
  let at = 6;
  for (let k = 0; k < 4; k++) {
    hufStream(
      huf,
      body.subarray(at, at + sizes[k]!),
      lit,
      k * q,
      k < 3 ? q : regen - 3 * q,
    );
    at += sizes[k]!;
  }
  return { lit, end };
}

// Literal-length and match-length codes: the value a code starts at, and how
// many extra bits follow it.
const LL_BASE = [
  ...Array.from({ length: 16 }, (_, i) => i),
  ...[16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096],
  ...[8192, 16384, 32768, 65536],
];
const LL_BITS = [
  ...new Array<number>(16).fill(0),
  ...[1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
];
const ML_BASE = [
  ...Array.from({ length: 32 }, (_, i) => i + 3),
  ...[35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051],
  ...[4099, 8195, 16387, 32771, 65539],
];
const ML_BITS = [
  ...new Array<number>(32).fill(0),
  ...[1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
];

// The tables a block uses when it sends none (RFC 8878 §3.1.1.3.2.2).
// deno-fmt-ignore
const LL_DEFAULT = fseTable([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6);
// deno-fmt-ignore
const OF_DEFAULT = fseTable([1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5);
// deno-fmt-ignore
const ML_DEFAULT = fseTable([1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, -1, -1, -1, -1, -1, -1, -1], 6);

/** Decode one compressed block into `out` at `pos`; returns the new `pos`.
 *  A match may reach back to byte 0 of `out` — the history lives there. */
function block(
  d: Uint8Array,
  carry: Carry,
  out: Uint8Array,
  pos: number,
): number {
  const { lit, end } = literals(d, carry);
  d = d.subarray(end);
  if (d.length === 0) throw bad("a block has no sequences section");
  let n = d[0]!;
  let at = 1;
  if (n === 0) {
    if (d.length !== 1) throw bad("a block has bytes after its end");
    out.set(lit, pos);
    return pos + lit.length;
  }
  if (n === 255) {
    n = d[1]! + (d[2]! << 8) + 0x7f00;
    at = 3;
  } else if (n >= 128) {
    n = ((n - 128) << 8) + d[1]!;
    at = 2;
  }
  const modes = d[at++]!;
  if (modes & 3) throw bad("a block uses a reserved mode");
  const table = (
    mode: number,
    kept: Fse | undefined,
    preset: Fse,
    maxLog: number,
    maxSym: number,
  ): Fse => {
    if (mode === 0) return preset;
    if (mode === 1) return fseOne(d[at++]!);
    if (mode === 3) {
      if (!kept) throw bad("a block repeats a table that was never sent");
      return kept;
    }
    const r = readFse(d.subarray(at), maxLog, maxSym);
    at += r.end;
    return r.t;
  };
  const ll = carry.ll = table(modes >> 6, carry.ll, LL_DEFAULT, 9, 35);
  const of = carry.of = table((modes >> 4) & 3, carry.of, OF_DEFAULT, 8, 31);
  const ml = carry.ml = table((modes >> 2) & 3, carry.ml, ML_DEFAULT, 9, 52);
  if (at >= d.length) throw bad("a block's sequences are cut short");
  const r = rev(d.subarray(at));
  const rep = carry.rep;
  let l = take(r, ll.log);
  let o = take(r, of.log);
  let m = take(r, ml.log);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const oc = of.sym[o]!;
    const lc = ll.sym[l]!;
    const mc = ml.sym[m]!;
    if (oc > 31 || lc > 35 || mc > 52) throw bad("a sequence code is unknown");
    // 2 ** oc, not 1 << oc: an offset code of 31 is past a signed 32 bits.
    let off = 2 ** oc +
      (oc > 24 ? take(r, oc - 16) * 65536 + take(r, 16) : take(r, oc));
    const mlen = ML_BASE[mc]! + take(r, ML_BITS[mc]!);
    const llen = LL_BASE[lc]! + take(r, LL_BITS[lc]!);
    if (off > 3) {
      off -= 3;
      rep[2] = rep[1];
      rep[1] = rep[0];
      rep[0] = off;
    } else {
      const idx = off + (llen === 0 ? 1 : 0);
      if (idx === 1) off = rep[0];
      else {
        off = idx === 4 ? rep[0] - 1 : rep[idx - 1]!;
        if (idx > 2) rep[2] = rep[1];
        rep[1] = rep[0];
        rep[0] = off;
      }
    }
    if (i + 1 < n) {
      l = ll.base[l]! + take(r, ll.bits[l]!);
      m = ml.base[m]! + take(r, ml.bits[m]!);
      o = of.base[o]! + take(r, of.bits[o]!);
    }
    if (r.p < 0) throw bad("a block's sequences are cut short");
    if (lp + llen > lit.length || pos + llen + mlen > out.length) {
      throw bad("a block writes more than it may");
    }
    for (let k = 0; k < llen; k++) out[pos++] = lit[lp++]!;
    if (off === 0 || off > pos) throw bad("a match starts before the data");
    if (off >= mlen) out.copyWithin(pos, pos - off, pos - off + mlen);
    else for (let k = 0; k < mlen; k++) out[pos + k] = out[pos + k - off]!;
    pos += mlen;
  }
  if (r.p !== 0) throw bad("a block's sequences do not end where they say");
  out.set(lit.subarray(lp), pos);
  return pos + lit.length - lp;
}

/** Decode the ONE zstd frame `src` into `out` from `start` on, block by
 *  block. `out[0, start)` is the history its matches may point into (empty
 *  for an ordinary frame). Yields the write position after each block, so a
 *  caller can let other work run in between; returns the final one.
 *
 *  Throws on anything that is not exactly one well-formed frame fitting
 *  `out`. The frame's checksum is skipped, not verified — see the header. */
export function* zstdBlocks(
  src: Uint8Array,
  out: Uint8Array,
  start: number,
): Generator<number, number> {
  if (bitsAt(src, 0, 16) + bitsAt(src, 16, 16) * 65536 !== MAGIC) {
    throw bad("it does not start with the zstd magic number");
  }
  const desc = src[4]!;
  const single = (desc & 32) !== 0;
  const fcs = desc >> 6;
  if (desc & 8) throw bad("a reserved header bit is set");
  if (desc & 3) throw bad("it names a trained dictionary");
  let at = 5 + (single ? 0 : 1) + (fcs === 0 ? (single ? 1 : 0) : 1 << fcs);
  const carry: Carry = { rep: [1, 4, 8] };
  let pos = start;
  for (;;) {
    if (at + 3 > src.length) throw bad("it is cut short");
    const head = src[at]! | src[at + 1]! << 8 | src[at + 2]! << 16;
    const size = head >>> 3;
    const type = (head >> 1) & 3;
    at += 3;
    const body = type === 1 ? 1 : size;
    if (type === 3 || at + body > src.length) throw bad("a block is damaged");
    if (type === 2) {
      pos = block(src.subarray(at, at + size), carry, out, pos);
    } else {
      if (pos + size > out.length) throw bad("it writes more than it may");
      if (type === 0) out.set(src.subarray(at, at + size), pos);
      else out.fill(src[at]!, pos, pos + size);
      pos += size;
    }
    at += body;
    if (head & 1) break;
    yield pos;
  }
  if (desc & 4) at += 4;
  if (at !== src.length) throw bad("bytes follow the frame");
  return pos;
}
