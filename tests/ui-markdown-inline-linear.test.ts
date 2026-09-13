// <Markdown>'s inline parser is linear in the line, and says what the regex
// version said.
//
// It ran an unanchored-in-effect regex per character — `text.slice(i)` and
// then `/^(\*|_)(?!\s)(.+?)(?<!\s)\1/` and friends — so an opener with no
// closer ahead searched to the end of the line at EVERY position. Markdown
// renders user text under SSR: `"*a ".repeat(n)` at 200 KB held the server for
// 10.9 s, and `"[a](".repeat(n)` grew the same way.
//
// The scanner that replaced it is held to two things here: growth (4× the
// input may cost at most 8× the time — linear is 4×, the quadratic parser was
// 16×), and output identical to the regex parser, kept below as the oracle,
// over random lines built from every character the patterns care about.
import { assert, assertEquals } from "@std/assert";
import { Fragment, h, renderToString } from "../src/air/vdom.ts";
import type { VChild } from "../src/air/vdom.ts";
import { Markdown } from "../src/ui/markdown.ts";

const md = (source: string): string => renderToString(Markdown({ source }));

/** Best of three, so one GC pause does not decide the ratio. */
function timeMs(source: string): number {
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    Markdown({ source });
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

const QUADRATIC_BEFORE = [
  "*a ",
  "_a ",
  "**a ",
  "__a ",
  "[a](",
  "![a](",
  "[a]",
  "`",
  "*a *",
  "[a](b ",
];

Deno.test("md inline: an opener with no closer ahead costs linear time, not quadratic", () => {
  for (const unit of QUADRATIC_BEFORE) {
    const small = unit.repeat(Math.ceil(25_000 / unit.length));
    const big = unit.repeat(Math.ceil(100_000 / unit.length));
    timeMs(small); // warm the JIT before either measurement counts
    const a = timeMs(small);
    const b = timeMs(big);
    // A floor absorbs timer noise when both are a few ms; the quadratic
    // parser took ~2.7 s on the 100 KB line.
    assert(
      b <= Math.max(8 * a, 60),
      `${JSON.stringify(unit)}: 25 KB ${a.toFixed(1)} ms → 100 KB ${
        b.toFixed(1)
      } ms`,
    );
  }
});

// ── The oracle: the regex parser this scanner replaced, verbatim in effect
// (hrefs normalized the same way; the dev warning is not part of the output).

function normalizeHref(url: string): string | null {
  const u = url
    .replace(/[\t\n\r]/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  if (u === "") return null;
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[./#?]/.test(u)) return u;
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? null : u;
}

function oracleInline(text: string): VChild[] {
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
    let m = /^`([^`]+)`/.exec(rest);
    if (m) {
      flush();
      out.push(h("code", { class: "aio-md__code" }, m[1]!));
      i += m[0].length;
      continue;
    }
    m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      flush();
      const src = normalizeHref(m[2]!);
      out.push(
        src ? h("img", { src, alt: m[1]!, class: "aio-md__img" }) : m[1]!,
      );
      i += m[0].length;
      continue;
    }
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
          }, ...oracleInline(m[1]!)),
        );
      } else out.push(...oracleInline(m[1]!));
      i += m[0].length;
      continue;
    }
    m = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (m) {
      flush();
      out.push(h("strong", null, ...oracleInline(m[2]!)));
      i += m[0].length;
      continue;
    }
    m = /^(\*|_)(?!\s)(.+?)(?<!\s)\1/.exec(rest);
    if (m) {
      flush();
      out.push(h("em", null, ...oracleInline(m[2]!)));
      i += m[0].length;
      continue;
    }
    plain += text[i];
    i++;
  }
  flush();
  return out;
}

/** Deterministic PRNG, so a failure names a reproducible case. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ch = String.fromCharCode;
// Every character a pattern branches on: the delimiters, `\s` in its ASCII
// and Unicode forms, the line ends `.` refuses (U+2028/U+2029 survive the
// line split), a C0 control, and href shapes on both sides of the check.
const ATOMS = [
  "`",
  "*",
  "**",
  "_",
  "__",
  "[",
  "]",
  "(",
  ")",
  "![",
  "!",
  " ",
  ch(9),
  ch(11),
  ch(0xa0),
  ch(0x2028),
  ch(0x2029),
  ch(0),
  "a",
  "a b",
  "http://e.com",
  "javascript:x",
  "/p",
  "#",
  ".",
];

Deno.test("md inline: the scanner renders exactly what the regex parser did", () => {
  const rnd = mulberry32(0x3d1);
  for (let k = 0; k < 40_000; k++) {
    // "x" first: one paragraph line, so the block parser hands the whole
    // source to the inline parser.
    let source = "x";
    const n = 1 + Math.floor(rnd() * 24);
    for (let q = 0; q < n; q++) {
      source += ATOMS[Math.floor(rnd() * ATOMS.length)];
    }
    const want = renderToString(
      h(
        "div",
        { class: "aio-md" },
        h(
          Fragment,
          null,
          h("p", { class: "aio-md__p" }, ...oracleInline(source)),
        ),
      ),
    );
    assertEquals(md(source), want, `case ${k}: ${JSON.stringify(source)}`);
  }
});
