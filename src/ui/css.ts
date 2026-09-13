// css.ts — a class name nobody else can collide with.
//
// THE BUG THIS ENDS. aio has one global stylesheet, so class names are global.
// The worst UI bug of one build was a `class="track"` defined in two places:
// every music row clipped to a single line, with no error, a correct DOM and a
// correct component tree — the later rule simply won (report 3 §12.1,
// report 4 §10.3, report 5 §8.5). `aiol` now REPORTS that collision, which is the
// cheap half. This is the other one: a name that cannot collide in the first
// place.
//
// WHY CONTENT-ADDRESSED, and not a counter. The class name is a hash of the
// rule text, so:
//   • the same rule written twice is the SAME class, emitted once — two
//     components that happen to want the same three declarations do not ship
//     two copies of them;
//   • the name is stable between the server and the browser, and between runs.
//     A counter (`aio-1`, `aio-2`) depends on module evaluation ORDER, which is
//     not the same on both sides — so a server-rendered page would hydrate
//     against class names the client had numbered differently, and the styling
//     would be wrong in exactly the way nobody thinks to look for.
//
// NO BUILD STEP, deliberately. A scoping scheme that needs a bundler plugin
// does not work in `deno task dev` (which serves modules one by one, untouched)
// and would be a dev/prod divergence in the one part of an app people judge by
// looking at it. This is a function; it runs the same in both.
//
// UNLAYERED, also deliberately. The generated theme lives in `@layer aio` so an
// app's own CSS always wins; an unlayered rule beats every layered one, so a
// scoped class beats the theme without anybody writing `!important`.

/** FNV-1a, 32-bit, as base36. Short, stable, and dependency-free — the name
 *  only has to be collision-resistant across one app's stylesheets, not
 *  cryptographically unique. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Rules emitted so far, by class name. Also what `collectCss` returns. */
const _rules = new Map<string, string>();
let _styleEl: HTMLStyleElement | null = null;

// ── strings and comments are not structure ────────────────────────────────
//
// Everything below used to run plain regexes over the whole template, which
// meant CSS punctuation inside a QUOTED STRING was read as punctuation:
// `content: ", "` normalised to `content:","` and lost its space — silent,
// visual, and exactly the "correct code, wrong pixels" class this module
// exists to end — while a `{` or `}` inside a string or a comment derailed
// the brace scanner and threw the component's whole rule away.
//
// So literals are lifted out FIRST, replaced by a marker that carries no
// whitespace and none of `{};:,` (so no rule below can see inside one), and
// put back last. Comments go the same way and simply do not come back: a
// comment is not part of the rule, and leaving it in made the same rule hash
// two ways depending on whether someone had annotated it.

/** The marker — `\uE000<n>\uE000`. A private-use code point plus digits: no
 *  whitespace and none of `{};:,`, so every regex below walks straight past
 *  it, and nothing in real CSS is spelt with one. (A control character would
 *  do the same job and trips `no-control-regex`.) */
const LIT = (n: number) => `\uE000${n}\uE000`;
const LIT_RE = /\uE000(\d+)\uE000/g;

/** Drop `/* … *\/` comments, without looking inside strings. */
function stripComments(src: string): string {
  let out = "";
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) out += src[++i];
      else if (ch === q) q = null;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      // An unterminated comment swallows the rest, which is what a browser
      // does with it too.
      i = end === -1 ? src.length : end + 1;
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'") q = ch;
    out += ch;
  }
  return out;
}

/** Replace every quoted string with a marker. Returns the masked text and the
 *  literals, in the order the markers appear. */
function maskLiterals(src: string): { masked: string; lits: string[] } {
  const lits: string[] = [];
  let masked = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch !== '"' && ch !== "'") {
      masked += ch;
      i++;
      continue;
    }
    let j = i + 1;
    let body = "";
    while (j < src.length && src[j] !== ch) {
      if (src[j] === "\\" && j + 1 < src.length) body += src[j++];
      body += src[j++];
    }
    masked += ch + LIT(lits.length) + ch;
    lits.push(body);
    i = j + 1;
  }
  return { masked, lits };
}

/** Put the literals back. */
function unmask(src: string, lits: string[]): string {
  return src.replace(LIT_RE, (_m, n) => lits[Number(n)] ?? "");
}

/** Normalise a template so that two rules differing only in whitespace hash to
 *  one class. Without it, reformatting a file silently doubles the CSS.
 *
 *  Runs on MASKED text only — see the note above. */
function normalize(src: string): string {
  return src.replace(/\s+/g, " ").replace(/\s*([{};:,])\s*/g, "$1").trim()
    // A trailing `;` is legal and invisible to a browser, but it makes the
    // same rule two different STRINGS depending on whether the author typed
    // it — two hashes, two classes, two copies of identical CSS.
    .replace(/;$/, "");
}

/** Normalise a raw template: mask, normalise, restore. This is what the hash
 *  is taken over, so two rules that differ only INSIDE a string are two
 *  classes, as they must be. */
function normalizeSource(src: string): string {
  const { masked, lits } = maskLiterals(stripComments(src));
  return unmask(normalize(masked), lits);
}

/** Expand a rule body into real CSS for `.cls`.
 *
 *  Two shapes, which is everything this needs to be useful:
 *  plain declarations, and NESTED blocks introduced by `&` (`&:hover { … }`,
 *  `& .icon { … }`) or by an at-rule (`@media (…) { … }`, whose body is itself
 *  expanded so `&` inside it still means this class).
 *
 *  Hand-written rather than delegated to a CSS parser: a parser is a
 *  dependency and a much larger promise, and the two shapes above are the ones
 *  a component-scoped class is for. Anything else is a stylesheet, and belongs
 *  in `style.css`. */
export function expandCss(cls: string, rawBody: string): string {
  // Lift strings and comments out before the scanner runs: a `{` or `}` inside
  // either is text, not structure, and reading it as structure threw the
  // component's whole rule away and appended an unbalanced `}` to the one
  // shared stylesheet.
  const { masked, lits } = maskLiterals(stripComments(rawBody));
  return unmask(_expand(cls, masked), lits);
}

/** The scanner, over MASKED text. */
function _expand(cls: string, body: string): string {
  const self = `.${cls}`;
  const decls: string[] = [];
  const blocks: string[] = [];
  let i = 0;
  let buf = "";
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "{") {
      // The buffer holds DECLARATIONS and then a selector: in
      // `color: red; &:hover { … }` everything up to the last `;` belongs to
      // this class and only the tail is the nested rule's prelude. Treating
      // the whole buffer as the selector silently moved leading declarations
      // into it — `color: red; .c:hover{…}` — which no browser applies and
      // nothing reports.
      const semi = buf.lastIndexOf(";");
      const prelude = (semi >= 0 ? buf.slice(semi + 1) : buf).trim();
      if (semi >= 0) {
        const lead = normalize(buf.slice(0, semi + 1));
        if (lead) decls.push(lead);
      }
      buf = "";
      let depth = 1;
      let j = i + 1;
      while (j < body.length && depth > 0) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}") depth--;
        j++;
      }
      const inner = body.slice(i + 1, j - 1);
      i = j;
      if (prelude.startsWith("@")) {
        // An at-rule: expand its body against the same class, so `&` inside a
        // media query still means this component. Recurses into `_expand`,
        // not `expandCss` — the text is already masked, and masking it twice
        // would renumber markers that the outer call is going to restore.
        blocks.push(`${prelude}{${_expand(cls, inner)}}`);
      } else {
        blocks.push(`${prelude.split("&").join(self)}{${normalize(inner)}}`);
      }
      continue;
    }
    buf += ch;
    i++;
  }
  const flat = normalize(buf);
  if (flat) decls.push(flat);
  const own = decls.length > 0 ? `${self}{${decls.join(";")}}` : "";
  return own + blocks.join("");
}

/** Put a rule on the page, once. */
function inject(css: string): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.head || typeof doc.createElement !== "function") return;
  if (!_styleEl?.isConnected) {
    _styleEl = doc.createElement("style");
    _styleEl.setAttribute("data-aio-css", "");
    doc.head.append(_styleEl);
  }
  _styleEl.textContent = (_styleEl.textContent ?? "") + css;
}

/**
 * A scoped class name for these declarations.
 *
 * ```tsx
 * const track = css`
 *   display: flex;
 *   overflow: hidden;
 *   &:hover { background: var(--aio-tint); }
 *   @media (max-width: 600px) { & { display: block; } }
 * `;
 *
 * <div class={track}>…</div>
 * ```
 *
 * The returned name is a hash of the rule, so two components cannot collide
 * however they name things — and two components writing the identical rule
 * share one class rather than shipping it twice.
 *
 * Interpolation works (`css\`color: ${theme.accent};\``) and is part of the
 * hash, so two different values are two different classes, as they must be.
 */
export function css(
  strings: TemplateStringsArray,
  ...values: Array<string | number>
): string {
  let body = "";
  for (let i = 0; i < strings.length; i++) {
    body += strings[i];
    if (i < values.length) body += interpolated(values[i]!);
  }
  const key = normalizeSource(body);
  const cls = `aio-${hash(key)}`;
  if (!_rules.has(cls)) {
    const rule = styleSafe(expandCss(cls, body));
    _rules.set(cls, rule);
    inject(rule);
  }
  return cls;
}

/** One interpolated value, checked.
 *
 *  A braceless value can only ever be part of a declaration. A value carrying
 *  `{` or `}` CLOSES the rule it sits in and opens another, and the generated
 *  stylesheet is one shared `<style>` for the whole page — so
 *  `` css`color: ${c}` `` with `c` = `red} .x{display:none` wrote a rule
 *  against `.x` that the author never authorised, and the component's own
 *  rule vanished (its selector had been consumed as part of the injected
 *  one). Any app interpolating a colour, a hue or a size that came from
 *  state — which is what the docstring below advertises interpolation FOR —
 *  was one untrusted string away from arbitrary global CSS.
 *
 *  Braces are refused rather than escaped because there is no escape: CSS has
 *  no way to write a literal brace in a declaration value. Dev throws and
 *  names the value; production strips the braces and says so, which leaves a
 *  broken declaration (the browser drops it) instead of a rule nobody wrote.
 *  Composing a nested block by interpolation was never supported — the
 *  docstring says a stylesheet belongs in `style.css`. */
function interpolated(v: string | number): string {
  const s = String(v);
  if (!/[{}]|<\//.test(s)) return s;
  // `</` gets the same refusal as a brace, and for the same reason one level
  // out: the generated sheet is served inside a `<style>` element, whose text
  // is RAW — nothing in CSS can escape a closing tag. Measured:
  // `` css`content: "${v}"` `` with v = `</style><img src=x onerror=…>` put a
  // working <img> in the page. A brace escapes the rule; `</` escapes the
  // element.
  const what = /[{}]/.test(s) ? "a brace" : "the sequence `</`";
  const msg = `[aio] css\`\`: an interpolated value contains ${what} — ` +
    `${JSON.stringify(s)}. A value can only be part of a DECLARATION; a ` +
    `brace ends the rule and starts another one in the page's shared ` +
    `stylesheet, and \`</\` ends the <style> element that stylesheet is ` +
    `served in. Put the nested block in the template itself, or move it to ` +
    `a stylesheet.`;
  // The flag is read straight off globalThis, the way every other dev gate in
  // `src/ui/` reads it: `ui` may not import `state` (the folder matrix), and
  // this is the one fact it needs from there.
  if ((globalThis as Record<string, unknown>).__aioDev === true) {
    throw new Error(msg);
  }
  console.error(msg + " It was neutralised.");
  return s.replace(/[{}]/g, "").replace(/<(?=\/)/g, "\\00003c ");
}

/** Make a finished rule safe to put inside a `<style>` element.
 *
 *  The interpolation guard above is the loud half and covers the case anyone
 *  actually hits. This is the quiet half, and it covers the rest: a `</`
 *  written directly in a template (`` css`content: "</style>"` ``) would close
 *  the element just as effectively. `\00003c ` is the CSS escape for `<` — it
 *  renders as `<` inside a string and is inert outside one, so the stylesheet
 *  means exactly what it meant and can no longer end the element early.
 *  Applied once per unique rule, where the rule is stored, so both
 *  `collectCss()` and the injected `<style>` get it. */
function styleSafe(rule: string): string {
  return rule.replace(/<(?=\/)/g, "\\00003c ");
}

/** Compose scoped classes with plain ones, skipping anything falsy.
 *
 *  `class={cx(track, isActive && active)}` — the spelling people reach for,
 *  provided rather than rewritten in every app. */
export function cx(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}

/** Every rule `css` has produced, as one stylesheet.
 *
 *  For `renderToString`: on the server there is no document to inject into, so
 *  the caller puts this in the `<head>` of whatever it is rendering — INSIDE a
 *  `<style>` element. What comes back is CSS, not markup (`.aio-x{color:red}`),
 *  and bare in a `<head>` a browser treats it as text and applies none of it.
 *  Returning it rather than writing it anywhere keeps this module free of an
 *  opinion about how a page is assembled.
 *
 *  ```ts
 *  `<head><style>${collectCss()}</style></head>`
 *  ``` */
export function collectCss(): string {
  return [..._rules.values()].join("");
}

/** @internal Test seam — forget every rule and detach the style element. */
// aio-ok: a test-only seam; a page never un-defines its own classes
export function _resetCss(): void {
  _rules.clear();
  _styleEl?.remove();
  _styleEl = null;
}
