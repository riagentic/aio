// A dev-time colour check on the COMMITTED DOM.
//
// THE HOLE THIS FILLS. aio checks the accessibility of STRUCTURE — `<img>`
// without `alt`, an unlabelled `<input>`, a `<div onClick>` with no keyboard
// handler — and says nothing about COLOUR, while shipping a generated colour
// system. That asymmetry let a real defect reach a real user through five green
// gates. The report, verbatim: "fix colors, it's gray to dark gray and some
// black text is not visible at all." `deno check`, `deno lint`, `aiol`, 31
// tests and `deno task build` were all green on that build.
//
// WHY THE EXISTING TEST COULD NOT SEE IT. `tests/app-theme.test.ts` checks
// `--aio-on-accent` against `--aio-accent` across the whole hue wheel, and that
// pair passes AA — 4.92:1. What nothing asked is whether the ink still makes
// sense against the surface it ACTUALLY landed on once an app built its own
// layout from the tokens. A pair correct in isolation, wrong in place, is
// exactly the class a static check cannot reach and a walk of the real tree
// can: this reads the colours the browser computed, on the elements that exist.
//
// SCOPE, deliberately narrow. Dev only, never in a production build. It reads;
// it never writes. It cannot fail a build. It warns once per distinct
// colour-pair-and-place, because the same pair on 300 rows is one finding. And
// it is silent wherever it cannot MEASURE — no `getComputedStyle`, or a
// computed value it cannot parse (happy-dom returns empty strings for most of
// this) — because a colour audit that guesses is worse than none.
import { isDevMode } from "../state/dev-flag.ts";

/** WCAG AA for body text. Large text (>=24px, or >=18.66px bold) needs 3:1. */
const AA_NORMAL = 4.5;
const AA_LARGE = 3;

/** Elements scanned per pass. A cap, not a budget: this is a dev nicety and it
 *  must never be the reason a big page feels slow. */
const MAX_ELEMENTS = 600;
/** Distinct findings reported per session. Past this the message has landed. */
const MAX_FINDINGS = 12;
/** Minimum gap between passes — a commit storm must not restart the walk. */
const THROTTLE_MS = 750;

const _reported = new Set<string>();
let _lastRun = 0;
let _findings = 0;

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const la = luminance(a.r, a.g, a.b);
  const lb = luminance(b.r, b.g, b.b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

type RGBA = { r: number; g: number; b: number; a: number };

/** The slice of a window this file uses — a real `Window`, or happy-dom's. */
type Win = {
  getComputedStyle(e: Element): { getPropertyValue(p: string): string };
};

/** Parse the `rgb()` / `rgba()` form every engine reports computed colours in.
 *
 *  Deliberately ONE form. A computed style is always resolved — a browser does
 *  not hand back `hsl()`, a keyword or a custom property here — so accepting
 *  more shapes would only add ways to be wrong about a value we did not
 *  actually understand. Anything else returns null and the element is skipped. */
export function parseRgb(v: string | null | undefined): RGBA | null {
  if (!v) return null;
  const t = v.trim();
  // TWO forms, measured rather than assumed: a real browser always answers
  // `rgb()`/`rgba()`, and happy-dom — what `testUI` runs on — answers with the
  // authored HEX (`#0f1629`), inheriting `color` correctly and returning `""`
  // where no rule applies. Reading only the browser form left this audit dark
  // in exactly the environment this project insists is the strictest.
  // `tests/contrast-audit.test.ts` drives a real happy-dom window to prove it.
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(t);
  if (hex) {
    const h = hex[1]!;
    const dup = (c: string) => parseInt(c + c, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: dup(h[0]!),
        g: dup(h[1]!),
        b: dup(h[2]!),
        a: h.length === 4 ? dup(h[3]!) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null; // #12345 and #1234567 are not colours
  }
  const m =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/
      .exec(t);
  if (!m) return null;
  const alpha = m[4] === undefined
    ? 1
    : m[4].endsWith("%")
    ? Number(m[4].slice(0, -1)) / 100
    : Number(m[4]);
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![r, g, b, alpha].every(Number.isFinite)) return null;
  return { r, g, b, a: alpha };
}

/** `fg` composited over `bg`, so a translucent ink is measured as it LOOKS.
 *  A 40%-opacity muted label is a real readability question and the naive
 *  reading (ignore alpha) answers the wrong one. */
export function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/** The first ANCESTOR background that actually paints, composited down.
 *
 *  Climbing to the first non-transparent background is not enough: a
 *  half-opaque panel over a dark page is neither of its two colours, and
 *  reporting either would be a confident wrong answer. Layers are composited in
 *  paint order until one is opaque; the page falls back to white, which is what
 *  a UA canvas is when nothing says otherwise. */
function effectiveBackground(
  el: Element,
  win: {
    getComputedStyle(e: Element): { getPropertyValue(p: string): string };
  },
): RGBA | null {
  const layers: RGBA[] = [];
  let node: Element | null = el;
  let hops = 0;
  while (node && hops++ < 40) {
    const bg = parseRgb(
      win.getComputedStyle(node).getPropertyValue("background-color"),
    );
    if (bg && bg.a > 0) {
      layers.push(bg);
      if (bg.a >= 0.999) break;
    }
    node = node.parentElement;
  }
  let out: RGBA = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i]!, out);
  return out;
}

/** A short, stable place-name for the message: tag plus its class list. Not a
 *  selector — the reader needs to recognise the element, not query it. */
function placeOf(el: Element): string {
  const cls = (el.getAttribute?.("class") ?? "").trim().split(/\s+/)
    .filter(Boolean).slice(0, 3).join(".");
  return cls
    ? `<${el.tagName.toLowerCase()} class="${cls}">`
    : `<${el.tagName.toLowerCase()}>`;
}

/** True when this element has text of its OWN (not just a descendant's) —
 *  those are the ones whose `color` is actually painted as glyphs. */
function hasOwnText(el: Element): boolean {
  for (const n of Array.from(el.childNodes ?? [])) {
    if ((n as { nodeType?: number }).nodeType === 3) {
      if (((n as { nodeValue?: string }).nodeValue ?? "").trim() !== "") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Walk the committed tree and warn about text that cannot be read.
 *
 * Returns the number of findings — the tests assert on that; the console is for
 * the developer. A no-op outside dev mode and wherever the environment cannot
 * measure, which is checked rather than assumed: an unparseable computed
 * `color` on the FIRST element with text is taken as "this engine does not
 * compute colours" and the pass ends, rather than silently reporting nothing
 * and looking like a clean bill of health.
 */
export function auditContrast(root: Element | null | undefined): number {
  if (!isDevMode() || !root) return 0;
  if (_findings >= MAX_FINDINGS) return 0;
  const now = Date.now();
  if (now - _lastRun < THROTTLE_MS) return 0;
  _lastRun = now;

  // ONE decider for "can this environment be measured at all", shared with the
  // exported `canAuditContrast` — so a caller asking the question and the audit
  // acting on it can never answer it differently. That difference is the whole
  // point of having the predicate: "no findings" and "could not look" are not
  // the same answer, and reporting the second as the first is the wrong-answer
  // shape this file exists to remove.
  if (!canAuditContrast(root)) return 0;
  const win = windowOf(root)!;

  let scanned = 0;
  let found = 0;
  let measuredAny = false;
  const walk = (el: Element): void => {
    if (scanned >= MAX_ELEMENTS || _findings >= MAX_FINDINGS) return;
    scanned++;
    if (hasOwnText(el)) {
      let cs: { getPropertyValue(p: string): string };
      try {
        cs = win.getComputedStyle(el);
      } catch {
        return; // an engine that refuses to compute is one we cannot audit
      }
      const fgRaw = parseRgb(cs.getPropertyValue("color"));
      const bg = fgRaw ? effectiveBackground(el, win) : null;
      if (fgRaw && bg) {
        measuredAny = true;
        // Fully transparent text is a deliberate technique (sr-only, icon
        // fonts, a clipped gradient headline) and not a contrast question.
        if (fgRaw.a > 0.05) {
          const fg = over(fgRaw, bg);
          const size = parseFloat(cs.getPropertyValue("font-size")) || 16;
          const weight = parseInt(cs.getPropertyValue("font-weight"), 10) ||
            400;
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const need = large ? AA_LARGE : AA_NORMAL;
          const ratio = contrast(fg, bg);
          if (ratio < need) {
            const place = placeOf(el);
            const id = `${Math.round(fg.r)},${Math.round(fg.g)},${
              Math.round(fg.b)
            }|${Math.round(bg.r)},${Math.round(bg.g)},${
              Math.round(bg.b)
            }|${place}`;
            if (!_reported.has(id)) {
              _reported.add(id);
              _findings++;
              found++;
              console.warn(
                `[aio-dev] ${place} text is unreadable on its background: ` +
                  `${ratio.toFixed(2)}:1, WCAG AA needs ${need}:1 for ` +
                  `${large ? "large" : "body"} text. ` +
                  `color rgb(${Math.round(fg.r)} ${Math.round(fg.g)} ${
                    Math.round(fg.b)
                  }) on rgb(${Math.round(bg.r)} ${Math.round(bg.g)} ${
                    Math.round(bg.b)
                  }). ` +
                  `If this is the app's own palette, the two values disagree; ` +
                  `if it is a --aio-* token, the pair was solved for the other ` +
                  `colour scheme.`,
              );
            }
          }
        }
      }
    }
    for (const child of Array.from(el.children ?? [])) walk(child as Element);
  };
  try {
    walk(root);
  } catch {
    return found; // a hostile DOM must never break a render
  }
  // `measuredAny === false` means the engine reported nothing we could read —
  // report zero findings, but do not let the caller mistake that for a pass.
  return measuredAny ? found : 0;
}

/** The window that would compute styles for `root`, or null. */
function windowOf(root: Element | null | undefined): Win | null {
  const doc = (root as unknown as { ownerDocument?: unknown })?.ownerDocument as
    | { defaultView?: unknown }
    | undefined;
  const win = doc?.defaultView as Win | undefined;
  return typeof win?.getComputedStyle === "function" ? win : null;
}

/** True when the environment can actually measure colour.
 *
 *  `auditContrast` guards on this too, which is the point: a caller asking
 *  "could you look?" and the audit deciding whether to look must not be able to
 *  answer differently. "No findings" and "could not look" are different
 *  answers, and reporting the second as the first is a confident wrong one. */
export function canAuditContrast(root: Element | null | undefined): boolean {
  return windowOf(root) !== null;
}

/** @internal Test seam — forget what has been reported. */
export function _resetContrastAudit(): void {
  _reported.clear();
  _lastRun = 0;
  _findings = 0;
}
