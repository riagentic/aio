// check:placeholders — a `${…}` that never interpolates.
//
// `console.error("${NO} compile failed")` is valid TypeScript, passes every
// type check, every lint rule and every test that does not read the line — and
// prints `${NO} compile failed` to a user whose build just failed. It is a
// quote character in the wrong place, and the only reader who ever notices is
// the one already having a bad day.
//
// Found 15 of them at once, all on the Android and Electron build paths: every
// ✓ and ✗ glyph in those two files was a literal `${OK}` / `${NO}`. Those paths
// have no automated consumer, so nothing was ever going to catch it except a
// person on a machine with an unset ANDROID_HOME.
//
// The rule: a plain string literal (not a template) that contains `${ident}`
// is a mistake unless the line — or the line above — carries `aio-ok:`, which
// is how the codebase says "this text is deliberately showing you source".
//
// Usage: deno run --allow-read scripts/check-placeholders.ts
import { fromFileUrl, join, relative } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".aio",
  "coverage",
]);
const PLACEHOLDER = /\$\{\s*[A-Za-z_$][\w$]*[\w$.?![\]()]*\s*\}/;
const JUSTIFIED = /aio-ok:/;

export type Hit = { file: string; line: number; text: string };

/** Scan one source text for string literals carrying a live-looking `${…}`.
 *
 *  A hand-rolled walk rather than a regex over lines: the whole point is to
 *  tell a TEMPLATE literal (where `${…}` is correct) from a quoted one (where
 *  it is not), and that distinction does not survive line-at-a-time matching.
 *  Comments and regex literals are skipped for the same reason — both hold
 *  quote characters that would otherwise open a string that never closes. */
export function scanText(src: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  const lines = src.split("\n");
  let i = 0, line = 1;
  // The previous significant character, which is what decides whether a `/`
  // opens a regex or divides. `=(,:[!&|?{;` and a newline can only precede a
  // regex; an identifier or a closing bracket can only precede a division.
  let prev = "";
  const setPrev = (c: string | undefined) => {
    if (c && !/\s/.test(c)) prev = c;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      prev = "\n";
      continue;
    }
    // line comment
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // regex literal
    if (c === "/" && /^$|[=(,:[!&|?{;+\-*%<>~^\n]/.test(prev)) {
      i++;
      let closed = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "[") { // a class may hold an unescaped `/`
          while (i < src.length && src[i] !== "]" && src[i] !== "\n") {
            i += src[i] === "\\" ? 2 : 1;
          }
        }
        if (src[i] === "/") {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (closed) {
        prev = "/";
        continue;
      }
      // Not a regex after all (a stray divide at a line end) — fall through.
    }
    // template literal: `${…}` is correct here, so skip it whole, tracking the
    // nesting so a nested template or string inside `${…}` cannot end it early
    if (c === "`") {
      i++;
      let depth = 0;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        if (src[i] === "$" && src[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (depth > 0 && src[i] === "}") {
          depth--;
          i++;
          continue;
        }
        if (depth === 0 && src[i] === "`") {
          i++;
          break;
        }
        i++;
      }
      prev = "`";
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c, start = line;
      i++;
      let body = "";
      let terminated = false;
      while (i < src.length) {
        if (src[i] === "\\") {
          body += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (src[i] === "\n") break; // unterminated: not a string literal
        if (src[i] === q) {
          i++;
          terminated = true;
          break;
        }
        body += src[i];
        i++;
      }
      if (terminated && PLACEHOLDER.test(body)) {
        const here = lines[start - 1] ?? "";
        const above = lines[start - 2] ?? "";
        if (!JUSTIFIED.test(here) && !JUSTIFIED.test(above)) {
          hits.push({ line: start, text: `${q}${body}${q}` });
        }
      }
      prev = q;
      continue;
    }
    setPrev(c);
    i++;
  }
  return hits;
}

export async function scan(dirs: string[]): Promise<Hit[]> {
  const hits: Hit[] = [];
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        for (const h of scanText(await Deno.readTextFile(p))) {
          hits.push({ file: relative(ROOT, p), ...h });
        }
      }
    }
  };
  for (const d of dirs) await walk(join(ROOT, d));
  return hits;
}

if (import.meta.main) {
  const hits = await scan(["src", "scripts", "amui/src", "aiol"]);
  if (hits.length > 0) {
    console.error(
      `✗ ${hits.length} string literal(s) carry a \`\${…}\` that never ` +
        `interpolates — the user reads the source of the message:\n`,
    );
    for (const h of hits) {
      console.error(`  ${h.file}:${h.line}\n      ${h.text}`);
    }
    console.error(
      `\n  fix: make it a template literal (backticks), or — when the text ` +
        `is\n  deliberately SHOWING source to the reader — put \`aio-ok: ` +
        `<why>\`\n  on its line or the line above.`,
    );
    Deno.exit(1);
  }
  console.log("✓ placeholders: every `${…}` is in a template literal");
}
