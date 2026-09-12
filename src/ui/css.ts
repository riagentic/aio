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

/** Normalise a template so that two rules differing only in whitespace hash to
 *  one class. Without it, reformatting a file silently doubles the CSS. */
function normalize(src: string): string {
  return src.replace(/\s+/g, " ").replace(/\s*([{};:,])\s*/g, "$1").trim()
    // A trailing `;` is legal and invisible to a browser, but it makes the
    // same rule two different STRINGS depending on whether the author typed
    // it — two hashes, two classes, two copies of identical CSS.
    .replace(/;$/, "");
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
export function expandCss(cls: string, body: string): string {
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
        // media query still means this component.
        blocks.push(`${prelude}{${expandCss(cls, inner)}}`);
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
    if (i < values.length) body += String(values[i]);
  }
  const key = normalize(body);
  const cls = `aio-${hash(key)}`;
  if (!_rules.has(cls)) {
    const rule = expandCss(cls, body);
    _rules.set(cls, rule);
    inject(rule);
  }
  return cls;
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
 *  the caller puts this in the `<head>` of whatever it is rendering. Returning
 *  it rather than writing it anywhere keeps this module free of an opinion
 *  about how a page is assembled. */
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
