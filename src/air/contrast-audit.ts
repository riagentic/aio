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
  // `hsl()`/`hsla()`, because the kit itself writes one: `<Avatar>` colours
  // its circle `hsl(${hueFor(name)}, 55%, 45%)`. A real browser normalises
  // that to `rgb()` in a computed style, happy-dom hands back what was
  // authored, and `testUI` runs on happy-dom — so the environment this
  // project calls the strictest was the one that could not read it.
  const hsl =
    /^hsla?\(\s*([-\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.%]+))?\s*\)$/
      .exec(t);
  if (hsl) {
    const h = ((Number(hsl[1]) % 360) + 360) % 360;
    const sat = Number(hsl[2]) / 100;
    const li = Number(hsl[3]) / 100;
    const a = hsl[4] === undefined
      ? 1
      : hsl[4].endsWith("%")
      ? Number(hsl[4].slice(0, -1)) / 100
      : Number(hsl[4]);
    if (![h, sat, li, a].every(Number.isFinite)) return null;
    // The standard conversion, written out rather than pulled in.
    const c = (1 - Math.abs(2 * li - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const mm = li - c / 2;
    const seg = Math.floor(h / 60) % 6;
    const [r1, g1, b1] = seg === 0
      ? [c, x, 0]
      : seg === 1
      ? [x, c, 0]
      : seg === 2
      ? [0, c, x]
      : seg === 3
      ? [0, x, c]
      : seg === 4
      ? [x, 0, c]
      : [c, 0, x];
    return {
      r: Math.round((r1 + mm) * 255),
      g: Math.round((g1 + mm) * 255),
      b: Math.round((b1 + mm) * 255),
      a,
    };
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

/** Does this computed value MEAN "paints nothing"?
 *
 *  The empty string (no rule applies), and the keywords a UA can hand back for
 *  a background that is not a colour. Everything else that `parseRgb` refuses
 *  is a colour we could not read, which is not the same answer. */
function isTransparent(v: string | null | undefined): boolean {
  const t = (v ?? "").trim().toLowerCase();
  return t === "" || t === "transparent" || t === "none" || t === "initial" ||
    t === "inherit" || t === "unset" || t === "revert";
}

/** The first ANCESTOR background that actually paints, composited down.
 *
 *  Climbing to the first non-transparent background is not enough: a
 *  half-opaque panel over a dark page is neither of its two colours, and
 *  reporting either would be a confident wrong answer. Layers are composited in
 *  paint order until one is opaque; the page falls back to white, which is what
 *  a UA canvas is when nothing says otherwise.
 *
 *  `null` when a layer cannot be READ, which is a different thing from
 *  transparent and used to be treated as the same thing. `parseRgb` answers
 *  `rgb()`/`rgba()`/hex and nothing else, so an `hsl()`, a named colour or an
 *  `oklch()` returned null, the loop climbed straight past an opaque panel and
 *  landed on the white page fallback — and reported white-on-white, 1.00:1,
 *  in the framework's own dev console. Measured on one colour in three
 *  spellings: `rgb(114,52,178)` silent, `hsl(275,55%,45%)` and
 *  `rebeccapurple` each a false alarm. It fires on the kit's own `<Avatar>`,
 *  which writes `hsl(...)` — markup the app author did not write and cannot
 *  fix. This file's docstring says reporting "could not look" as "no findings"
 *  is a confident wrong answer; this was the louder mirror image. */
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
    const style = win.getComputedStyle(node);
    // A `background-image` (a gradient, a `url()`) paints OVER the colour, and
    // under a gradient the colour is usually `transparent` — so reading the
    // colour alone composited straight through to the panel behind and
    // reported the gradient's ink as dark-on-dark, 1.03:1, in every theme of
    // a field app whose cursor row is a gradient. A layer we cannot sample is
    // "could not look", the same answer as an unreadable colour.
    if (!isTransparent(style.getPropertyValue("background-image"))) return null;
    const raw = style.getPropertyValue("background-color");
    const bg = parseRgb(raw);
    if (!bg && !isTransparent(raw)) return null; // a layer we cannot read
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
  if (!canAuditContrast(root)) {
    // "Could not look" said as such, never passed off as "no findings" —
    // and only where there IS a window, whose computed colours would
    // otherwise have been believed.
    const why = windowOf(root) ? _cascadeProbe?.(root) : null;
    if (why && !_saidCannotResolve) {
      _saidCannotResolve = true;
      console.warn(why);
    }
    return 0;
  }
  const win = windowOf(root)!;
  const moving = colourInMotion(root);

  let scanned = 0;
  let found = 0;
  let measuredAny = false;
  const walk = (el: Element): void => {
    if (scanned >= MAX_ELEMENTS || _findings >= MAX_FINDINGS) return;
    scanned++;
    if (hasOwnText(el) && !(moving && isMoving(el, moving.targets))) {
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
  if (moving?.finished.length && !_rerunPending) {
    // What was skipped is looked at once it has landed — otherwise a theme
    // switch with no later commit would leave those elements never audited.
    // An infinite animation never settles, and its elements stay unmeasured:
    // correct, since no single frame of it is THE colour.
    // Paced by the same throttle as a commit: the re-run lands at most once
    // per THROTTLE_MS, so nothing an engine reports can make it spin.
    _rerunPending = true;
    Promise.allSettled(moving.finished).then(() =>
      setTimeout(() => {
        _rerunPending = false;
        try {
          auditContrast(root);
        } catch {
          // aio-ok: a dev-only observation must never throw out of a timer;
          // every finding it makes is reported where it is made.
        }
      }, THROTTLE_MS)
    );
  }
  // `measuredAny === false` means the engine reported nothing we could read —
  // report zero findings, but do not let the caller mistake that for a pass.
  return measuredAny ? found : 0;
}

/** The properties whose computed value this audit reads. */
const COLOUR_PROPS = new Set([
  "color",
  "background",
  "background-color",
  "background-image",
]);

type Anim = {
  playState?: string;
  effect?: {
    target?: unknown;
    getKeyframes?(): Record<string, unknown>[];
    getComputedTiming?(): { endTime?: number };
  };
  finished?: Promise<unknown>;
};

/** Does this animation move a colour the audit reads? An unreadable keyframe
 *  set counts as yes: skipping an element is safe, measuring one mid-flight
 *  is a false alarm. */
function touchesColour(a: Anim): boolean {
  try {
    return (a.effect?.getKeyframes?.() ?? []).some((k) =>
      Object.keys(k).some((p) =>
        COLOUR_PROPS.has(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
      )
    );
  } catch {
    return true;
  }
}

/** The elements whose colour is mid-animation right now, or null when none.
 *
 *  `getComputedStyle` answers with the CURRENT frame of a transition, so a
 *  theme switch measured at t≈0 reported every transitioned property at its
 *  OLD value and every other one at its NEW value — twelve findings on a
 *  field app's light variant, none real, each pairing a dark ink with a light
 *  panel. Asked once per pass, of the document, so the common case (nothing
 *  moving) costs one call. An engine with no `getAnimations` (happy-dom)
 *  has no transitions to be caught in either. */
function colourInMotion(
  root: Element,
): { targets: Set<unknown>; finished: Promise<unknown>[] } | null {
  const doc = (root as unknown as {
    ownerDocument?: { getAnimations?(): Anim[] };
  }).ownerDocument;
  if (typeof doc?.getAnimations !== "function") return null;
  const targets = new Set<unknown>();
  const finished: Promise<unknown>[] = [];
  for (const a of doc.getAnimations()) {
    // A finished animation holding its end value (`fill: forwards`) is still
    // listed, but its colour is settled — measurable, and nothing to wait on.
    if (a.playState === "finished") continue;
    if (!a.effect?.target || !touchesColour(a)) continue;
    targets.add(a.effect.target);
    // Only a FINITE animation is worth waiting on: an infinite one (a pulsing
    // skeleton) never settles, and waiting on it would hold the one pending
    // re-run forever — the next theme switch would never be looked at again.
    let end = Infinity;
    try {
      end = a.effect.getComputedTiming?.().endTime ?? Infinity;
    } catch { /* aio-ok: unknown timing is treated as never-ending */ }
    if (a.finished && Number.isFinite(end)) finished.push(a.finished);
  }
  return targets.size ? { targets, finished } : null;
}

/** True when `el` or an ancestor is animating a colour — an ancestor's
 *  `color` is inherited and its background is composited under `el`. */
function isMoving(el: Element, targets: Set<unknown>): boolean {
  for (let n: Element | null = el, hops = 0; n && hops < 80; hops++) {
    if (targets.has(n)) return true;
    n = n.parentElement;
  }
  return false;
}

/** One deferred re-audit at a time, however many passes found motion. */
let _rerunPending = false;

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
  return windowOf(root) !== null && !(root && _cascadeProbe?.(root));
}

/** Why this engine's computed colours cannot be believed, or null.
 *
 *  A HOOK, installed by the test harness, rather than an import: the probe
 *  (`contrast-cascade.ts`) walks the CSSOM to prove a cascade broken, and a
 *  real browser never needs it — happy-dom, which `testUI` runs on, does
 *  (report 9 §1). Imported here it would put ~0.9 KB gz on every production
 *  page for a test DOM's defect. The harness installs it on every mount, so
 *  every test that renders through `testUI`/`testComponent` is covered. */
let _cascadeProbe: ((root: Element) => string | null) | null = null;

/** @internal Install (or clear, with null) the cascade probe. */
export function _setContrastCascadeProbe(
  probe: ((root: Element) => string | null) | null,
): void {
  _cascadeProbe = probe;
}

/** Said once per process: the same engine answers the same way every pass,
 *  and a line per test would bury the one finding a reader needs. */
let _saidCannotResolve = false;

/** @internal Test seam — forget what has been reported. `cascadeNotice`
 *  also forgets that "could not be resolved" was said; `testUI` calls this on
 *  every mount WITHOUT it, so that line stays once per process. */
export function _resetContrastAudit(
  opts: { cascadeNotice?: boolean } = {},
): void {
  _reported.clear();
  _lastRun = 0;
  _findings = 0;
  _rerunPending = false;
  if (opts.cascadeNotice) _saidCannotResolve = false;
}
