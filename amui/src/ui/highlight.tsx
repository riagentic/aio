// Tiny, dependency-free syntax highlighter for the file viewer. Regex-tokenised
// (not a real parser) — good enough to read code: comments, strings, numbers,
// keywords for TS/JS; strings/keys/literals for JSON. Everything else is plain
// text. Highlighting is skipped for large files (perf) — they still render.
import { C } from "./style.ts";

const HL_MAX = 150_000; // bytes above which we skip highlighting

const TS_KW = new Set(
  ("const let var function return if else for while import export from async " +
    "await new class extends implements interface type enum of in try catch " +
    "finally throw typeof instanceof this super null undefined true false void " +
    "as default case switch break continue do yield public private protected " +
    "static readonly get set namespace declare abstract keyof satisfies")
    .split(" "),
);

// deno-lint-ignore no-explicit-any
type Node = any;

const span = (color: string, text: string, italic = false): Node => (
  <span style={{ color, fontStyle: italic ? "italic" : "normal" }}>{text}</span>
);

const TS_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;

function tsTokens(code: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TS_RE.lastIndex = 0;
  while ((m = TS_RE.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const tok = m[0];
    if (m[1]) out.push(span(C.dim, tok, true)); // comment
    else if (m[2]) out.push(span(C.green, tok)); // string
    else if (m[3]) out.push(span(C.blue, tok)); // number
    else if (m[4]) out.push(TS_KW.has(tok) ? span(C.purple, tok) : tok);
    else out.push(tok);
    last = m.index + tok.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

const JSON_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|(\b(?:true|false|null)\b)|(-?\d[\d.eE+-]*)/g;

function jsonTokens(code: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  JSON_RE.lastIndex = 0;
  while ((m = JSON_RE.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    if (m[1]) {
      // string — a following ':' makes it a key
      out.push(span(m[2] ? C.blue : C.green, m[1]));
      if (m[2]) out.push(m[2]);
    } else if (m[3]) out.push(span(C.purple, m[3])); // true/false/null
    else if (m[4]) out.push(span(C.blue, m[4])); // number
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

const langOf = (name: string): "ts" | "json" | null => {
  const n = name.toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(n)) return "ts";
  if (/\.(json|jsonc)$/.test(n) || n.endsWith("deno.lock")) return "json";
  return null;
};

/** Highlighted content for a file — falls back to plain text for unknown
 *  extensions or files too large to tokenise cheaply. */
export function highlight(code: string, name: string): Node[] {
  const lang = langOf(name);
  if (!lang || code.length > HL_MAX) return [code];
  return lang === "ts" ? tsTokens(code) : jsonTokens(code);
}
