// A dev-time check that the app's own CSS is aimed at elements that exist.
//
// THE FINDING. aio mounts into `<div id="root">`. Nothing said so. An app's
// stylesheet did what any web developer's would —
//
//     html, body, #app { height: 100% }
//
// — where `#app` was the author's own wrapper name, so the height chain broke
// at the top: the layout grid fell back to min-content, a 322-row list stretched
// the page to 6 886 px, and the canvas inside it was sized by its own
// ResizeObserver to 1824 × 13772. The 3D view was vertically stretched tenfold
// FOR HOURS. FPS and triangle counts stayed healthy the whole time, which made
// the author trust the renderer and distrust their own geometry — they "fixed"
// the camera maths twice. It was found only by reading the pixel dimensions of
// a screenshot.
//
// The report's own verdict is the reason this file exists: "The framework's
// stated first principle is *fail loud, never silent*. This is a silent,
// detectable divergence." It is detectable in one line, and every `am` command
// reported perfect health right through it.
//
// WHY A WARNING AND NOT A DEFAULT. `html, body, #root { height: 100% }` in the
// shell would fix this one app and change the layout of every app that already
// ships, including the ones that deliberately let the body grow. A diagnostic
// costs nobody anything and catches the whole class — including the next
// variant, which will be `#app-root` or `#shell` rather than `#app`.
import { isDevMode } from "../state/dev-flag.ts";

const _said = new Set<string>();

/** Ids named by any `#id` selector in the document's own stylesheets.
 *
 *  Reading `cssRules` throws on a cross-origin sheet (a CDN font, an analytics
 *  widget) — those are skipped, not reported: an unreadable sheet is not
 *  evidence of anything, and guessing from one is how a diagnostic starts
 *  lying. */
export function idsInStyleSheets(doc: Document): Set<string> {
  const out = new Set<string>();
  const visit = (rules: CSSRuleList | undefined): void => {
    if (!rules) return;
    for (const rule of Array.from(rules)) {
      const sel = (rule as CSSStyleRule).selectorText;
      if (typeof sel === "string") {
        for (const m of sel.matchAll(/#([A-Za-z_][\w-]*)/g)) out.add(m[1]!);
      }
      // @media / @supports wrap their own rule list.
      const inner = (rule as unknown as { cssRules?: CSSRuleList }).cssRules;
      if (inner) visit(inner);
    }
  };
  let sheets: StyleSheetList | undefined;
  try {
    sheets = doc.styleSheets;
  } catch {
    return out;
  }
  for (const sheet of Array.from(sheets ?? [])) {
    try {
      visit((sheet as CSSStyleSheet).cssRules);
    } catch {
      // aio-ok: a cross-origin stylesheet (a CDN font, an embedded widget)
      // throws on `cssRules` BY DESIGN — the browser is refusing, not failing.
      // An unreadable sheet is not evidence of anything, and reporting it, or
      // guessing at its contents, is how a diagnostic starts lying.
    }
  }
  return out;
}

/**
 * Warn once for each `#id` the app styles that exists in no element.
 *
 * `rootId` is the id AIR actually mounted into, and naming it is the whole
 * value: "`#app` matches nothing" is a puzzle, "`#app` matches nothing — the
 * app mounts into `#root`" is a one-line fix.
 *
 * Returns how many it reported, so a test can assert on the finding rather than
 * on console output.
 */
export function auditIdSelectors(
  doc: Document | null | undefined,
  rootId: string,
): number {
  if (!isDevMode() || !doc) return 0;
  let found = 0;
  for (const id of idsInStyleSheets(doc)) {
    if (id === rootId) continue;
    let exists = true;
    try {
      exists = doc.getElementById(id) !== null;
    } catch {
      continue;
    }
    if (exists) continue;
    const key = `id-selector:${id}`;
    if (_said.has(key)) continue;
    _said.add(key);
    found++;
    console.warn(
      `[aio-dev] your stylesheet styles #${id}, and no element has that id. ` +
        `aio mounts the app into #${rootId} — if #${id} was meant to be the ` +
        `app's root (a height chain, a grid, a flex container), it is styling ` +
        `nothing and the rules silently do not apply. Style #${rootId}, or ` +
        `render an element with id="${id}".`,
    );
  }
  return found;
}

/** @internal Test seam. */
export function _resetSelectorAudit(): void {
  _said.clear();
}
