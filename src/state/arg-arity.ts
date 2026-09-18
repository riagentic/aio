/**
 * @module
 * How many parameters a method declares after its draft `s` — read from its
 * source, so default values and destructuring count (`fn.length` stops at the
 * first default and would undercount).
 */

/** The parameter-list text of `src` (a function's `toString()`), or null. */
function paramList(src: string): string | null {
  const open = src.indexOf("(");
  const arrow = src.indexOf("=>");
  // `s => …` — a single bare parameter, no parentheses
  if (arrow >= 0 && (open < 0 || open > arrow)) {
    return src.slice(0, arrow).replace(/^\s*async\s+/, "").trim();
  }
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

/** Parameters after `s`, or null when it cannot say (a rest parameter takes
 *  any number; unparsable source). Pure. */
export function declaredArgCount(
  fn: (...a: never[]) => unknown,
): number | null {
  const list = paramList(Function.prototype.toString.call(fn));
  if (list === null) return null;
  let depth = 0;
  let quote: string | null = null;
  let params = 0;
  let sawToken = false;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      if (sawToken) params++;
      sawToken = false;
      continue;
    }
    if (depth === 0 && list.startsWith("...", i)) return null;
    if (!/\s/.test(ch)) sawToken = true;
  }
  if (sawToken) params++;
  return Math.max(0, params - 1); // minus the draft `s`
}
