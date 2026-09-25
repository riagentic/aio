// A dev-time check for the one theme trap an app cannot see on its own
// machine unless the OS is dark: "dark OS, light page".
//
// THE TRAP. Under `ui.theme: "tokens"` (the default), `"auto"` once the app
// ships its own `style.css`, and `"none"`, the `--aio-*` tokens and the kit's
// `:root` block switch to their dark variant on the raw
// `prefers-color-scheme: dark` — but nothing paints the page. The canvas stays
// white (color-scheme `normal`), so the kit's light ink lands on white:
// measured 1.15:1, unreadable. No CSS-only fix is safe — it would repaint
// 1.0.11 apps that paint their own dark page without declaring color-scheme —
// so the framework says it, once, in dev, and names the one-line fixes.
//
// OBSERVE-ONLY (category (a) of the dev==prod rule): it reads computed styles
// and warns; it never writes. It rides the dev chunk, so production carries
// none of it. Silent wherever it cannot measure.
import { isDevMode } from "../state/dev-flag.ts";
import { over, parseRgb } from "./contrast-audit.ts";

type RGBA = NonNullable<ReturnType<typeof parseRgb>>;

const lum = (c: RGBA) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

/**
 * The pure decision: is this a dark-OS page whose tokens went dark while the
 * page itself stayed light? Inputs are computed values, so a test can supply
 * them without an engine that computes colours.
 *
 * - `ink`: the computed kit/token ink (`--aio-ui-ink`, else `--aio-text`).
 *   Light ink means the tokens are in their dark variant. Unreadable → false.
 * - `backgrounds`: computed `background-color` of body, then html. Layers are
 *   composited in paint order; a transparent root falls through to the canvas,
 *   which is dark only when the root's `color-scheme` lets it be.
 */
export function isDarkOsLightPage(p: {
  prefersDark: boolean;
  ink: string;
  backgrounds: string[];
  colorScheme: string;
}): boolean {
  if (!p.prefersDark) return false;
  const ink = parseRgb(p.ink);
  if (!ink || lum(ink) < 0.5) return false;
  const layers: RGBA[] = [];
  for (const raw of p.backgrounds) {
    const t = raw.trim();
    if (t === "" || t === "transparent") continue;
    const c = parseRgb(t);
    if (!c) return false; // a layer we cannot read: could not look
    if (c.a <= 0) continue;
    layers.push(c);
    if (c.a >= 0.999) break;
  }
  const canvasDark = /\bdark\b/.test(p.colorScheme);
  let page: RGBA = canvasDark
    ? { r: 18, g: 18, b: 18, a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) page = over(layers[i]!, page);
  return lum(page) > 0.5;
}

export const DARK_OS_LIGHT_PAGE_WARNING =
  "[aio] Dark OS, light page: the --aio-* tokens switched to their dark " +
  "variant (light text) but this page's background is still light, so kit " +
  'text is unreadable. Fix with one of: `ui.theme: "auto"` (or ' +
  '"full") so aio paints the page; `:root { color-scheme: light dark }` in ' +
  "your CSS so the canvas follows the OS; or paint the page yourself for " +
  "dark mode (`@media (prefers-color-scheme: dark) { body { background: " +
  "var(--aio-bg); color: var(--aio-text) } }`). See docs/ui/theme.md.";

let _warned = false;

/** Measure the live document once; warn at most once per page. */
export function checkDarkOsLightPage(): boolean {
  if (_warned || !isDevMode()) return false;
  const g = globalThis as unknown as {
    document?: Document;
    matchMedia?: (q: string) => { matches: boolean };
    getComputedStyle?: (e: Element) => CSSStyleDeclaration;
  };
  const doc = g.document;
  if (!doc?.documentElement || !doc.body || !g.getComputedStyle) return false;
  const root = g.getComputedStyle(doc.documentElement);
  const hit = isDarkOsLightPage({
    prefersDark: !!g.matchMedia?.("(prefers-color-scheme: dark)").matches,
    ink: root.getPropertyValue("--aio-ui-ink").trim() ||
      root.getPropertyValue("--aio-text").trim(),
    backgrounds: [
      g.getComputedStyle(doc.body).getPropertyValue("background-color"),
      root.getPropertyValue("background-color"),
    ],
    colorScheme: root.getPropertyValue("color-scheme"),
  });
  if (hit) {
    _warned = true;
    console.warn(DARK_OS_LIGHT_PAGE_WARNING);
  }
  return hit;
}

/** Dev-chunk installer: check once the page has its styles, and again when
 *  the OS scheme flips (a light-OS session turning dark is the common way to
 *  meet this trap). Idempotent; a no-op outside dev mode. */
export function _installDarkOsLightPageCheck(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__aioDarkOsCheckInstalled || !isDevMode()) return;
  g.__aioDarkOsCheckInstalled = true;
  const w = globalThis as unknown as {
    document?: Document;
    addEventListener?: (t: string, f: () => void) => void;
    matchMedia?: (q: string) => {
      addEventListener?: (t: string, f: () => void) => void;
    };
  };
  const run = () => {
    try {
      checkDarkOsLightPage();
    } catch {
      // aio-ok: a dev-only observation must never break the page.
    }
  };
  if (w.document?.readyState === "complete") run();
  else w.addEventListener?.("load", run);
  w.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.(
    "change",
    run,
  );
}

/** @internal test seam */
export function _resetDarkOsLightPage(): void { // aio-ok: test seam
  _warned = false;
}
