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

/** Parse inline markdown in one line of text → an array of VChild. Order of
 *  the alternatives matters (code first so `*` inside code isn't italicized). */
function parseInline(text: string): VChild[] {
  const out: VChild[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push(plain);
      plain = "";
    }
  };
  while (i < text.length) {
    const rest = text.slice(i);

    // inline code `...`
    let m = /^`([^`]+)`/.exec(rest);
    if (m) {
      flush();
      out.push(h("code", { class: "aio-md__code" }, m[1]!));
      i += m[0].length;
      continue;
    }
    // image ![alt](src)
    m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      flush();
      const src = normalizeHref(m[2]!);
      if (src) {
        out.push(h("img", { src, alt: m[1]!, class: "aio-md__img" }));
      } else {
        warnDroppedHref(m[2]!);
        out.push(m[1]!); // unsafe src → keep the alt text only
      }
      i += m[0].length;
      continue;
    }
    // link [text](href)
    m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      flush();
      const href = normalizeHref(m[2]!);
      if (href) {
        out.push(
          h("a", {
            href,
            class: "aio-md__a",
            ...(/^https?:/i.test(href)
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {}),
          }, ...parseInline(m[1]!)),
        );
      } else {
        warnDroppedHref(m[2]!);
        out.push(...parseInline(m[1]!)); // drop the href, keep the text
      }
      i += m[0].length;
      continue;
    }
    // bold **...** or __...__
    m = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (m) {
      flush();
      out.push(h("strong", null, ...parseInline(m[2]!)));
      i += m[0].length;
      continue;
    }
    // italic *...* or _..._
    m = /^(\*|_)(?!\s)(.+?)(?<!\s)\1/.exec(rest);
    if (m) {
      flush();
      out.push(h("em", null, ...parseInline(m[2]!)));
      i += m[0].length;
      continue;
    }

    plain += text[i];
    i++;
  }
  flush();
  return out;
}

// ── Block parsing ───────────────────────────────────────────────────────────

/** Parse markdown source → an array of block VNodes. */
function parseBlocks(src: string): VChild[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: VChild[] = [];
  let i = 0;

  const listItems = (ordered: boolean): VNode => {
    const items: VNode[] = [];
    const re = ordered ? /^(\s*)\d+\.\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/;
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
    // fenced code ```lang … ```
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
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
            fence[1] ? { "data-lang": fence[1] } : null,
            code.join("\n"),
          ),
        ),
      );
      continue;
    }
    // heading # … ######
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      blocks.push(
        h(`h${head[1]!.length}`, null, ...parseInline(head[2]!.trim())),
      );
      i++;
      continue;
    }
    // horizontal rule
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push(h("hr", { class: "aio-md__hr" }));
      i++;
      continue;
    }
    // blockquote (one level)
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        h(
          "blockquote",
          { class: "aio-md__quote" },
          ...parseBlocks(quote.join("\n")),
        ),
      );
      continue;
    }
    // lists
    if (/^\s*[-*+]\s+/.test(line)) {
      blocks.push(listItems(false));
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      blocks.push(listItems(true));
      continue;
    }
    // paragraph — gather consecutive non-blank, non-block lines
    const para: string[] = [];
    while (
      i < lines.length && lines[i]!.trim() !== "" &&
      !/^(#{1,6}\s|>|```|\s*[-*+]\s|\s*\d+\.\s|---+\s*$|\*\*\*+\s*$)/.test(
        lines[i]!,
      )
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
