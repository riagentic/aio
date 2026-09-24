// THE newline-framed stream reader — linear in the bytes read, however a frame
// is chunked.
//
// Every line reader in the framework used to be `buf += chunk;
// buf.split("\n")`, which rescans the WHOLE carried buffer on every chunk: a
// 12.5 MB state frame arriving in 64 KB chunks is ~200 chunks, each re-splitting
// everything carried so far — quadratic, ~1.3 GB of scanning for one frame.
// This scans only the NEW chunk for "\n" and keeps the unfinished frame as a
// list of pieces, joined once when its newline arrives.
//
// SELF-CONTAINED on purpose: the Electron main process is generated source
// (electron-uds.ts) and embeds this function by `createLineReader.toString()`,
// the way it embeds `backoffDelay` — so it must reference nothing outside its
// own body, and the generated main.cjs cannot drift from the tested copy.

/** A per-connection line reader. */
export interface LineReader {
  /** Feed one decoded chunk; returns every line it completed, in order,
   *  without their "\n" (empty lines included — callers skip them). */
  push(chunk: string): string[];
  /** Characters of the unfinished frame carried so far. */
  pending(): number;
  /** Drop the unfinished frame — a new connection starts clean. */
  reset(): void;
}

/** Create a reader. One per connection; `reset()` it on reconnect. */
export function createLineReader(): LineReader {
  let parts: string[] = [];
  let carried = 0;
  return {
    push(chunk: string): string[] {
      const out: string[] = [];
      let start = 0;
      let nl = chunk.indexOf("\n");
      while (nl !== -1) {
        const piece = chunk.slice(start, nl);
        if (parts.length > 0) {
          parts.push(piece);
          out.push(parts.join(""));
          parts = [];
          carried = 0;
        } else out.push(piece);
        start = nl + 1;
        nl = chunk.indexOf("\n", start);
      }
      if (start < chunk.length) {
        const rest = start === 0 ? chunk : chunk.slice(start);
        parts.push(rest);
        carried += rest.length;
      }
      return out;
    },
    pending(): number {
      return carried;
    },
    reset(): void {
      parts = [];
      carried = 0;
    },
  };
}
