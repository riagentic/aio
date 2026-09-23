// source-mask.ts — comments and string literals blanked to spaces of the SAME
// length, so offsets in the masked copy line up with the original.
//
// Side-effect free and dependency free ON PURPOSE: check-dead-wiring.ts and
// check-persist-decider.ts both use it, and dead-wiring runs persist-decider in
// the same process. When `mask` lived in check-dead-wiring.ts the two formed an
// import cycle, and the CLI deadlocked on its own top-level await.

// ─── source masking ────────────────────────────────────────────────────────
// Every scan below runs over a copy of the source in which comments and string
// literals have been replaced by spaces of the SAME length, so offsets still
// line up with the original. This is the whole point of the detector: a doc
// comment that NAMES a function is exactly the evidence that fooled everyone
// about `_noteDispatch`, and it must not count as a reference.
//
// It differs from `check-vacuous.ts`'s `mask` in one way, and the difference
// is load-bearing here: a template `${…}` hole is real CODE. Blanking it whole
// (right for a test file, where masking asks "is this structure?") loses
// `` `__set${capitalize(m)}` `` — 23 real call sites in src/, every one of
// which would have been reported as dead.

// The regex-vs-division decision is THE shared rule in
// `src/diagnostics/code-mask.ts` (that mask keeps `${…}` holes as template
// content, this one needs them as CODE — worth 23 false positives — so the
// two masks stay separate while the `/` rule has one home).
import { regexStart } from "../src/diagnostics/code-mask.ts";

export function mask(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Returns the index of the `}` that closed this level (or `n`).
  const scan = (start: number, stop: "}" | ""): number => {
    let i = start;
    while (i < n) {
      const c = src[i]!, d = src[i + 1];
      if (stop === "}" && c === "}") return i;
      if (c === "/" && d === "/") {
        const e = src.indexOf("\n", i);
        const end = e === -1 ? n : e;
        blank(i, end);
        i = end;
      } else if (c === "/" && d === "*") {
        const e = src.indexOf("*/", i + 2);
        const end = e === -1 ? n : e + 2;
        blank(i, end);
        i = end;
      } else if (c === '"' || c === "'") {
        let k = i + 1;
        while (k < n) {
          if (src[k] === "\\") k += 2;
          // A newline ends a quoted string in valid TS. Without this, an
          // apostrophe inside a regex character class blanks the rest of the
          // file and every reference in it disappears.
          else if (src[k] === c || src[k] === "\n") break;
          else k++;
        }
        blank(i + 1, k);
        i = Math.min(k + 1, n);
      } else if (c === "/" && regexStart(src, i)) {
        // A REGEX LITERAL, skipped whole. Its CONTENTS can hold a backtick —
        // `/["'`]?/` in `src/db/reactive.ts` does — and the template branch
        // below would then read that backtick as an opener and blank forward
        // to the next one in the file, hiding every reference and declaration
        // between. Harmless there only by luck (the next backtick is two lines
        // away); the next such regex would take the rest of its file with it.
        // Quotes already stop at a newline for the same reason one line up.
        let k = i + 1;
        let inClass = false;
        while (k < n) {
          const ch = src[k]!;
          if (ch === "\\") {
            k += 2;
            continue;
          }
          if (ch === "\n") break; // unterminated — it was division after all
          if (inClass) {
            if (ch === "]") inClass = false;
          } else if (ch === "[") inClass = true;
          else if (ch === "/") break;
          k++;
        }
        blank(i + 1, k);
        i = Math.min(k + 1, n);
      } else if (c === "`") {
        let k = i + 1, text = i + 1;
        while (k < n) {
          if (src[k] === "\\") k += 2;
          else if (src[k] === "`") break;
          else if (src[k] === "$" && src[k + 1] === "{") {
            blank(text, k);
            k = scan(k + 2, "}");
            text = k + 1;
            k = text;
          } else k++;
        }
        blank(text, k);
        i = Math.min(k + 1, n);
      } else if (c === "{") {
        i = scan(i + 1, "}") + 1;
      } else i++;
    }
    return n;
  };
  scan(0, "");
  return out.join("");
}
