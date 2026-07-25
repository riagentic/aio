// markdown.ts — a small, SAFE Markdown renderer for `aio/ui` (inews).
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

/** True for an href we'll render as a link — http(s), mailto, or a relative /
 *  anchor path. Everything else (javascript:, data:, vbscript:, …) is dropped. */
function safeHref(url: string): boolean {
  const u = url.trim();
  if (u === "") return false;
  if (/^(https?:|mailto:)/i.test(u)) return true;
  // relative / absolute-path / anchor / query — no scheme means same-origin
  if (/^[./#?]/.test(u)) return true;
  // a bare "example.com/x" (no scheme, no leading slash) — treat as relative
  return !/^[a-z][a-z0-9+.-]*:/i.test(u);
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
      if (safeHref(m[2]!)) {
        out.push(h("img", { src: m[2]!, alt: m[1]!, class: "aio-md__img" }));
      } else {
        out.push(m[1]!); // unsafe src → keep the alt text only
      }
      i += m[0].length;
      continue;
    }
    // link [text](href)
    m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      flush();
      if (safeHref(m[2]!)) {
        out.push(
          h("a", {
            href: m[2]!,
            class: "aio-md__a",
            ...(/^https?:/i.test(m[2]!)
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {}),
          }, ...parseInline(m[1]!)),
        );
      } else {
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
