// markdown.ts — a small, SAFE Markdown renderer for `aio/ui`.
//
// Every content app hand-rolls a sanitized markdown renderer. This one is safe
// BY CONSTRUCTION: it parses to AIR VNodes (never an HTML string), so all text
// is auto-escaped by the renderer and there is no raw-HTML passthrough — the
// classic markdown-XSS vector simply doesn't exist here. The only attacker-
// controlled attribute, a link `href`, is scheme-checked (http/https/mailto/
// relative only; `javascript:` etc. are dropped).
//
// Scope: a deliberately-basic common subset (headings, bold/italic, inline +
// fenced code, links, images, lists, blockquote, hr, paragraphs). For full
// CommonMark, mount a library as a React island — this covers the 90% that
// otherwise gets re-rolled unsafely.

import { Fragment, h } from "../air/vdom.ts";
import type { VChild, VNode } from "../air/vdom.ts";

/** Props for {@link Markdown}. */
export interface MarkdownProps {
  /** The markdown source. */
  source: string;
  /** Extra class on the wrapper. */
  class?: string;
}

/** The href a browser will actually navigate to, for an href this renderer is
 *  willing to emit — http(s), mailto, or a relative / anchor path — or `null`
 *  when the scheme is one we drop (javascript:, data:, vbscript:, …).
 *
 *  It returns the string to EMIT, not just a verdict, because the check and the
 *  value have to be the same string. `.trim()` alone was not: the WHATWG URL
 *  parser — the one every browser uses to resolve an `href` — REMOVES leading
 *  and trailing C0 controls and spaces, and removes tab/LF/CR from anywhere in
 *  the URL, before it looks at the scheme. `String.prototype.trim` removes
 *  whitespace but not C0 controls, so a single NUL in front of a scheme made
 *  the two disagree:
 *
 *      safeHref("\u0000javascript:alert(1)")  → true   (no leading [a-z], so
 *                                                       "not a scheme")
 *      new URL("\u0000javascript:alert(1)")   → javascript:alert(1)
 *
 *  — i.e. exactly the vector this module's "safe by construction" claim is
 *  about, in the one place it takes attacker-controlled input. Every C0 control
 *  U+0001–U+001F works the same way, and `[^)\s]+` in the link/image patterns
 *  happily captures them (`\s` covers tab/LF/CR/FF/VT, not the rest).
 *
 *  So the string is normalized the way the parser will normalize it, the
 *  decision is made on THAT, and that is also what gets written into the
 *  attribute. One string, one answer. */
function normalizeHref(url: string): string | null {
  const u = url
    // Removed from anywhere in a URL by the parser.
    .replace(/[\t\n\r]/g, "")
    // Leading/trailing C0 control or space. The control characters are the
    // POINT here — they are exactly what the URL parser discards and what the
    // old check did not — so the lint rule is disabled deliberately.
    // deno-lint-ignore no-control-regex
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  if (u === "") return null;
  if (/^(https?:|mailto:)/i.test(u)) return u;
  // relative / absolute-path / anchor / query — no scheme means same-origin
  if (/^[./#?]/.test(u)) return u;
  // a bare "example.com/x" (no scheme, no leading slash) — treat as relative
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? null : u;
}

/** Hrefs already reported, so a re-render does not re-report them. Bounded:
 *  the source is untrusted, and an unbounded set of attacker strings is a leak.
 *  @internal test seam via {@linkcode _resetMarkdownWarnings}. */
const _warnedHrefs = new Set<string>();

/** A dropped link is a VISIBLE hole in the page (the text stays, the link is
 *  gone) with no cause anywhere — say what happened, once per href, in dev.
 *  Observe-only: prod drops exactly the same href, silently. */
function warnDroppedHref(url: string): void {
  if ((globalThis as Record<string, unknown>).__aioDev !== true) return;
  if (_warnedHrefs.has(url)) return;
  if (_warnedHrefs.size >= 50) _warnedHrefs.clear();
  _warnedHrefs.add(url);
  console.warn(
    `[aio:ui] <Markdown> dropped a link/image target with an unsupported ` +
      `scheme: ${
        JSON.stringify(url.slice(0, 120))
      }. Only http(s), mailto and ` +
      `relative paths are rendered — the link text is kept, the target is not.`,
  );
}

/** @internal test isolation — forget which dropped hrefs were reported. The
 *  dedup above is per-process, so a test that asserts the report has to re-arm
 *  it; nothing in src/ resets warn dedup. */
// aio-ok: a test-only seam, deliberately unreachable from the product.
export function _resetMarkdownWarnings(): void {
  _warnedHrefs.clear();
}

// ── Inline parsing (bold, italic, code, links, images) ──────────────────────

/** `nextAt(from)` — the first index ≥ `from` that `find` reports, remembered.
 *
 *  The inline parser asks "where is the next closer?" at every position, and a
 *  closer that is not there was searched for to the end of the line EVERY time:
 *  `"*a ".repeat(n)` or `"[a](".repeat(n)` cost O(n²) — a 200 KB comment held
 *  an SSR render for 11 s. The answer for `from` also answers every later
 *  `from` up to the index it found (nothing matched in between), and "none" (−1)
 *  answers every later `from` at all. The parser's positions only move forward,
 *  so each stretch of the line is searched once. A query behind the remembered
 *  one is searched afresh — slower, never wrong. */
function ahead(find: (from: number) => number): (from: number) => number {
  let lo = Infinity;
  let res = -1;
  return (from) => {
    if (from >= lo && (res === -1 || from <= res)) return res;
    lo = from;
    return (res = find(from));
  };
}

/** `\s` as the block patterns and `(?!\s)` read it — Unicode spaces included. */
const SPACE = /\s/;
/** What `.` does not match without the `s` flag. A line split on "\n" can
 *  still hold "\r"-less U+2028/U+2029. */
const LINE_END = /[\n\r\u2028\u2029]/g;
/** Where an `(href)` stops: `[^)\s]+` runs to the first `)` or space. */
const HREF_END = /[)\s]/g;

/** First index ≥ `from` matching the global `re`, or −1. */
function searchFrom(text: string, re: RegExp, from: number): number {
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : -1;
}

/** Parse inline markdown in one line of text → an array of VChild. Order of
 *  the alternatives matters (code first so `*` inside code isn't italicized).
 *
 *  A scanner, not a regex per position: each alternative is the anchored
 *  pattern named above it, decided by looking up the one closer that pattern
 *  can end on (every `(.+?)` and `[^x]+` here ends at the FIRST candidate), and
 *  every lookup goes through {@link ahead}. `ui-markdown-inline-linear.test.ts`
 *  holds it to the regex version on random input and to linear growth. */
function parseInline(text: string): VChild[] {
  const out: VChild[] = [];
  const n = text.length;
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push(plain);
      plain = "";
    }
  };
  const nextOf = (s: string) => ahead((from) => text.indexOf(s, from));
  const nextTick = nextOf("`");
  const nextBracketClose = nextOf("]");
  const nextBold = { "**": nextOf("**"), __: nextOf("__") };
  const nextLineEnd = ahead((from) => searchFrom(text, LINE_END, from));
  const nextHrefEnd = ahead((from) => searchFrom(text, HREF_END, from));
  // A `*`/`_` closer is one NOT preceded by a space — `(?<!\s)\1`.
  const italicCloser = (c: string) =>
    ahead((from) => {
      for (
        let k = text.indexOf(c, from);
        k !== -1;
        k = text.indexOf(c, k + 1)
      ) {
        if (!SPACE.test(text[k - 1]!)) return k;
      }
      return -1;
    });
  const nextItalic = { "*": italicCloser("*"), _: italicCloser("_") };
  // `(.+?)` from `start` closing at `close`: at least one character, none of
  // them a line end.
  const dotRun = (start: number, close: number) =>
    close > start && !(nextLineEnd(start) !== -1 && nextLineEnd(start) < close);
  // `\]\(([^)\s]+)\)` at `j` (the `]`): the href's end, or −1.
  const hrefAt = (j: number): number => {
    if (text[j + 1] !== "(") return -1;
    const end = nextHrefEnd(j + 2);
    return end > j + 2 && text[end] === ")" ? end : -1;
  };

  while (i < n) {
    const c = text[i]!;

    // inline code `...` — /^`([^`]+)`/
    if (c === "`") {
      const close = nextTick(i + 1);
      if (close > i + 1) {
        flush();
        out.push(
          h("code", { class: "aio-md__code" }, text.slice(i + 1, close)),
        );
        i = close + 1;
        continue;
      }
    }
    // image ![alt](src) — /^!\[([^\]]*)\]\(([^)\s]+)\)/
    if (c === "!" && text[i + 1] === "[") {
      const j = nextBracketClose(i + 2);
      const end = j === -1 ? -1 : hrefAt(j);
      if (end !== -1) {
        flush();
        const alt = text.slice(i + 2, j);
        const raw = text.slice(j + 2, end);
        const src = normalizeHref(raw);
        if (src) {
          out.push(h("img", { src, alt, class: "aio-md__img" }));
        } else {
          warnDroppedHref(raw);
          out.push(alt); // unsafe src → keep the alt text only
        }
        i = end + 1;
        continue;
      }
    }
    // link [text](href) — /^\[([^\]]+)\]\(([^)\s]+)\)/
    if (c === "[") {
      const j = nextBracketClose(i + 1);
      const end = j > i + 1 ? hrefAt(j) : -1;
      if (end !== -1) {
        flush();
        const label = text.slice(i + 1, j);
        const raw = text.slice(j + 2, end);
        const href = normalizeHref(raw);
        if (href) {
          out.push(
            h("a", {
              href,
              class: "aio-md__a",
              ...(/^https?:/i.test(href)
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {}),
            }, ...parseInline(label)),
          );
        } else {
          warnDroppedHref(raw);
          out.push(...parseInline(label)); // drop the href, keep the text
        }
        i = end + 1;
        continue;
      }
    }
    // bold **...** or __...__ — /^(\*\*|__)(.+?)\1/
    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const close = nextBold[c === "*" ? "**" : "__"](i + 3);
      if (close !== -1 && dotRun(i + 2, close)) {
        flush();
        out.push(h("strong", null, ...parseInline(text.slice(i + 2, close))));
        i = close + 2;
        continue;
      }
    }
    // italic *...* or _..._ — /^(\*|_)(?!\s)(.+?)(?<!\s)\1/
    if ((c === "*" || c === "_") && i + 1 < n && !SPACE.test(text[i + 1]!)) {
      const close = nextItalic[c](i + 2);
      if (close !== -1 && dotRun(i + 1, close)) {
        flush();
        out.push(h("em", null, ...parseInline(text.slice(i + 1, close))));
        i = close + 1;
        continue;
      }
    }

    plain += c;
    i++;
  }
  flush();
  return out;
}

// ── Block parsing ───────────────────────────────────────────────────────────

// ONE set of block patterns, read by both deciders: the dispatcher below ("which
// block is this line?") and the paragraph loop ("does this line end the
// paragraph?"). They used to be two spellings of the same question — the
// paragraph loop had its own looser regex — and wherever they disagreed a line
// was neither: "```js title=\"x\"" started a block for the paragraph loop
// (prefix "```") and not for the fence parser (which wanted only `\w*` after the
// backticks), so the loop consumed zero lines, pushed an empty <p>, and went
// round again forever — an out-of-memory crash, on the server under SSR, from
// one line of user-supplied text. The paragraph also always consumes its first
// line now, so no future disagreement can stop the parse from advancing.

/** Opening code fence: three or more backticks, then an info string. The info
 *  string may not contain a backtick (CommonMark) — "```a`b" is inline code in a
 *  paragraph, not a fence. */
const FENCE = /^(`{3,})([^`]*)$/;
/** `.` does not match U+2028/U+2029, and a line split on "\n" can still hold
 *  them — the `s` flag keeps "# a\u2028b" a heading instead of a non-match. */
const HEADING = /^(#{1,6})\s+(.*)$/s;
const HR = /^(---+|\*\*\*+|___+)\s*$/;
const QUOTE = /^>\s?/;
const UL = /^(\s*)[-*+]\s+(.*)$/s;
const OL = /^(\s*)\d+\.\s+(.*)$/s;

/** How deep blockquotes nest before the rest is read as paragraph text. Each
 *  level is a recursive parse of the quote's body, so `">".repeat(20000)` was
 *  20000 frames deep — a stack overflow from one line. No reader follows 32
 *  levels of quoting. */
const MAX_QUOTE_DEPTH = 32;

/** Does `line` start a block other than a paragraph, at this quote depth? */
function startsBlock(line: string, depth: number): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) ||
    (depth < MAX_QUOTE_DEPTH && QUOTE.test(line)) || UL.test(line) ||
    OL.test(line);
}

/** Parse markdown source → an array of block VNodes. */
function parseBlocks(src: string, depth = 0): VChild[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: VChild[] = [];
  let i = 0;

  const listItems = (ordered: boolean): VNode => {
    const items: VNode[] = [];
    const re = ordered ? OL : UL;
    while (i < lines.length) {
      const m = re.exec(lines[i]!);
      if (!m) break;
      items.push(h("li", null, ...parseInline(m[2]!)));
      i++;
    }
    return h(ordered ? "ol" : "ul", { class: "aio-md__list" }, ...items);
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }
    // fenced code ```lang … ``` — closed by a fence at least as long as the
    // opener (so a ```` block can show a ``` inside it); unclosed runs to the end
    const fence = FENCE.exec(line);
    if (fence) {
      const ticks = fence[1]!.length;
      const lang = fence[2]!.trim().split(/\s+/)[0] ?? "";
      i++;
      const code: string[] = [];
      while (i < lines.length) {
        const close = /^(`{3,})\s*$/.exec(lines[i]!);
        if (close && close[1]!.length >= ticks) break;
        code.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      blocks.push(
        h(
          "pre",
          { class: "aio-md__pre" },
          h(
            "code",
            lang ? { "data-lang": lang } : null,
            code.join("\n"),
          ),
        ),
      );
      continue;
    }
    // heading # … ######
    const head = HEADING.exec(line);
    if (head) {
      blocks.push(
        h(`h${head[1]!.length}`, null, ...parseInline(head[2]!.trim())),
      );
      i++;
      continue;
    }
    // horizontal rule
    if (HR.test(line)) {
      blocks.push(h("hr", { class: "aio-md__hr" }));
      i++;
      continue;
    }
    // blockquote — nested up to MAX_QUOTE_DEPTH
    if (depth < MAX_QUOTE_DEPTH && QUOTE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        quote.push(lines[i]!.replace(QUOTE, ""));
        i++;
      }
      blocks.push(
        h(
          "blockquote",
          { class: "aio-md__quote" },
          ...parseBlocks(quote.join("\n"), depth + 1),
        ),
      );
      continue;
    }
    // lists
    if (UL.test(line)) {
      blocks.push(listItems(false));
      continue;
    }
    if (OL.test(line)) {
      blocks.push(listItems(true));
      continue;
    }
    // paragraph — this line (no block claimed it), then every following
    // non-blank line that does not start a block
    const para: string[] = [line];
    i++;
    while (
      i < lines.length && lines[i]!.trim() !== "" &&
      !startsBlock(lines[i]!, depth)
    ) {
      para.push(lines[i]!);
      i++;
    }
    // a single soft newline inside a paragraph becomes a <br>.
    const inline: VChild[] = [];
    para.forEach((l, idx) => {
      if (idx > 0) inline.push(h("br", null));
      inline.push(...parseInline(l));
    });
    blocks.push(h("p", { class: "aio-md__p" }, ...inline));
  }
  return blocks;
}

/** Render markdown `source` as safe AIR nodes — no raw HTML, link hrefs
 *  scheme-checked. A deliberately-basic common subset (headings, bold/italic,
 *  code, links, images, lists, blockquote, hr). */
export function Markdown(props: MarkdownProps): VNode {
  return h(
    "div",
    { class: props.class ? `aio-md ${props.class}` : "aio-md" },
    h(Fragment, null, ...parseBlocks(props.source ?? "")),
  );
}
