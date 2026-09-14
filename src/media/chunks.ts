/**
 * @module
 * What the two video writers share: the chunk shape and its invariants.
 */

/** One encoded frame, as WebCodecs hands it out. */
export type EncodedChunk = {
  /** Presentation time, microseconds from the start of the video. */
  us: number;
  /** A keyframe (decodable on its own). */
  key: boolean;
  data: Uint8Array;
};

/** The containers aio writes. The file extension picks one. */
export type VideoFormat = "mp4" | "webm";

/** Concatenate byte arrays. */
export function cat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

/** The invariants both containers rely on — checked, not assumed: an encoder
 *  that reorders frames or starts on a delta frame would otherwise produce a
 *  file that plays as garbage with no error anywhere. */
export function assertChunks(
  chunks: readonly EncodedChunk[],
  container: string,
): void {
  if (chunks.length === 0) {
    throw new Error(`[aio:video] ${container}: no encoded frames to write`);
  }
  if (!chunks[0]!.key) {
    throw new Error(
      `[aio:video] ${container}: the first frame is not a keyframe — the ` +
        `file would not decode from the start`,
    );
  }
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i]!.us <= chunks[i - 1]!.us) {
      throw new Error(
        `[aio:video] ${container}: frame ${i} is not after frame ${i - 1} ` +
          `(${chunks[i]!.us}µs ≤ ${chunks[i - 1]!.us}µs) — the encoder ` +
          `reordered frames, which this writer does not support`,
      );
    }
  }
}

/** Pure: base64 of `u8` — in 32 KB slices, because spreading a whole frame
 *  into one `String.fromCharCode` call overflows the argument limit. */
export function toB64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Pure: the bytes of base64 `s`. */
export function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
