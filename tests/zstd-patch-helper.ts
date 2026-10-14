// zstd-patch-helper.ts — make an update patch without the `zstd` tool.
//
// A deliberately plain encoder, so the patch tests run on every machine: the
// bytes `to` shares with `from` at its start and at its end become matches
// into `from` (the frame's history), the middle is sent as it is. What the
// real tool makes is far smaller; that it decodes the same way is pinned by
// the tests that run when `zstd` is installed.

import { zstdBlocks } from "../src/server/updates-zstd.ts";

// Match-length codes 32…52 (RFC 8878 §3.1.1.3.2.1.1): the value each starts
// at and its extra bits. Codes 0…31 are the lengths 3…34.
const ML_BASE = [
  ...[35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051],
  ...[4099, 8195, 16387, 32771, 65539],
];
const ML_BITS = [
  ...[1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
];

function header(last: boolean, type: number, size: number): number[] {
  const h = (size << 3) | (type << 1) | (last ? 1 : 0);
  return [h & 255, (h >> 8) & 255, (h >> 16) & 255];
}

/** One compressed block holding one sequence: no literals, `len` bytes
 *  copied from `back` bytes before the write position. All three tables in
 *  RLE mode, so the bit stream is only the extra bits. */
function matchBlock(back: number, len: number): number[] {
  const ov = back + 3;
  const oc = 31 - Math.clz32(ov);
  const mc = len < 35 ? len - 3 : 32 + ML_BASE.findLastIndex((b) => b <= len);
  const mBits = mc < 32 ? 0 : ML_BITS[mc - 32]!;
  const mExtra = mc < 32 ? 0 : len - ML_BASE[mc - 32]!;
  // Read from the top: offset bits, then match-length bits (the literal
  // length code 0 has none), under the end mark.
  let v = (1n << BigInt(oc + mBits)) |
    (BigInt(ov - 2 ** oc) << BigInt(mBits)) | BigInt(mExtra);
  const stream: number[] = [];
  for (; v > 0n; v >>= 8n) stream.push(Number(v & 255n));
  return [0x00, 0x01, 0x54, 0, oc, mc, ...stream];
}

/** The largest piece one block may make. */
const PIECE = 100_000;

/** A zstd frame that makes `to` when decoded with `from` as its history
 *  (`zstd -d --patch-from=<from>` decodes it too). */
export function patchOf(from: Uint8Array, to: Uint8Array): Uint8Array {
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < from.length - head && tail < to.length - head &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  ) tail++;
  // A match is at least 3 bytes; a shorter run joins the middle.
  if (head < 3) head = 0;
  if (tail < 3) tail = 0;
  type Part = { at: number; len: number; src?: number };
  const parts: Part[] = [
    { at: 0, len: head, src: 0 },
    { at: head, len: to.length - head - tail },
    { at: to.length - tail, len: tail, src: from.length - tail },
  ].flatMap((p) => {
    const cut: Part[] = [];
    for (let done = 0; done < p.len;) {
      // Never leave a last piece shorter than a match may be.
      let len = Math.min(PIECE, p.len - done);
      if (p.len - done - len > 0 && p.len - done - len < 3) len -= 3;
      cut.push({
        at: p.at + done,
        len,
        ...(p.src === undefined ? {} : { src: p.src + done }),
      });
      done += len;
    }
    return cut;
  });
  // Window descriptor 0xA8: 2 GiB, the most the tool takes — every offset
  // a test needs fits.
  const out: number[] = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xa8];
  if (parts.length === 0) out.push(...header(true, 0, 0));
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    if (p.src === undefined) {
      out.push(...header(last, 0, p.len), ...to.subarray(p.at, p.at + p.len));
    } else {
      const body = matchBlock(from.length + p.at - p.src, p.len);
      out.push(...header(last, 2, body.length), ...body);
    }
  });
  return Uint8Array.from(out);
}

/** `zstdBlocks` run to its end: decode `frame` into `out` from `start` on,
 *  after the history in `out[0, start)`. Returns where the output ends. */
export function zstdDecodeInto(
  frame: Uint8Array,
  out: Uint8Array,
  start: number,
): number {
  const blocks = zstdBlocks(frame, out, start);
  for (;;) {
    const step = blocks.next();
    if (step.done) return step.value;
  }
}

/** Is the `zstd` tool (with `--patch-from`, 1.4.5+) on this machine? */
export function hasZstd(): boolean {
  try {
    const v = new TextDecoder().decode(
      new Deno.Command("zstd", { args: ["--version"], stderr: "null" })
        .outputSync().stdout,
    );
    const m = /v(\d+)\.(\d+)\.(\d+)/.exec(v);
    return !!m &&
      [m[1], m[2], m[3]].map(Number).reduce((a, n) => a * 1000 + n) >=
        1_004_005;
  } catch {
    return false; // aio-ok: not installed — the cases that need it say so
  }
}
