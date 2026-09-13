// Is this engine's style cascade a browser's? — the contrast audit's other
// "could not look".
//
// A window with `getComputedStyle` is not enough. happy-dom 17.6.3 — what
// `testUI` runs on — answers computed styles WITHOUT a working cascade: any
// selector that begins with `:root` is taken to match, whatever follows it
// (`:root[data-palette="contrast"]`, `:root:not(…)`, even `:root .card`), so a
// custom property comes back as the LAST such declaration in the sheet. Report
// 9 §1 measured both halves on a 3-palette × 6-accent theme: impossible
// findings (`#000000` ink from one palette on `#4a5b78` from another accent —
// two mutually exclusive selectors) and eleven real sub-AA pairs it could not
// see, one at 2.95:1, all found at once by the same walk in a real browser.
// Its own `element.matches()` is right, which is what makes this checkable.
//
// THE PROOF, and why it cannot fire in a browser. On the root element a
// custom property can only get its value from a rule whose selector matches
// it (nothing to inherit from), from its inline style, or from an `@property`
// initial value. So when the root's computed `--x` equals what a NON-matching
// rule declares, while the rules that DO match declare `--x` with a different
// literal, the engine applied a rule that does not apply. Every way a browser
// could legitimately produce that coincidence is excluded before the claim:
// an inline `--x`, an `@property --x`, a matching declaration that goes
// through `var()` (it resolves, so its text is not its value), and a matching
// declaration under `@media`/`@supports`/`@container`/`@import` (it may not
// apply), and a nested rule (its selector is relative). A sheet the scan
// cannot read (cross-origin) or a scan cut short by its budget ends in "no
// proof", because what it did not see could be the declaration that won. The
// one case left is a property registered from JS (`CSS.registerProperty`,
// invisible to a sheet scan) whose initial value happens to equal a
// non-matching declaration — and its cost is this audit standing down with a
// message, never a wrong finding. Everything that is not a proof answers
// "trustworthy", so the audit keeps working in real browsers.
//
// NOT imported by the renderer: the test harness installs it through
// `_setContrastCascadeProbe` (contrast-audit.ts), so production pages do not
// download a CSSOM walk that only a test DOM needs.

/** The slice of a window this file uses. */
type Win = {
  getComputedStyle(e: Element): { getPropertyValue(p: string): string };
};

/** Style rules scanned per verdict. A dev nicety must stay cheap on big sheets. */
const MAX_PROBE_RULES = 4000;

type CssRuleLike = {
  selectorText?: string;
  name?: string;
  style?: {
    length: number;
    [i: number]: string;
    getPropertyValue(p: string): string;
  };
  cssRules?: ArrayLike<CssRuleLike>;
  styleSheet?: { cssRules?: ArrayLike<CssRuleLike> } | null;
  constructor?: { name?: string };
};
type SheetLike = { cssRules?: ArrayLike<CssRuleLike> };
type DocLike = {
  documentElement?: Element & {
    style?: { getPropertyValue(p: string): string };
  };
  styleSheets?: ArrayLike<SheetLike>;
  adoptedStyleSheets?: ArrayLike<SheetLike>;
};

/** What proved the cascade broken, for the message — or null. */
type CascadeProof = { prop: string; value: string; selector: string };

const _verdicts = new WeakMap<
  object,
  { sig: string; proof: CascadeProof | null }
>();

/** Every sheet that can style the root: `<style>`/`<link>` and adopted ones. */
function sheetsOf(doc: DocLike): SheetLike[] {
  const out: SheetLike[] = [];
  for (const list of [doc.styleSheets, doc.adoptedStyleSheets]) {
    for (let i = 0; i < (list?.length ?? 0); i++) out.push(list![i]!);
  }
  return out;
}

/** The document's sheets, summarised cheaply: a verdict is re-derived only when
 *  a sheet or a top-level rule is added or removed. */
function sheetSignature(sheets: SheetLike[]): string {
  let rules = 0;
  for (const sheet of sheets) {
    try {
      rules += sheet?.cssRules?.length ?? 0;
    } catch {
      rules += 0.5; // unreadable — still part of the signature
    }
  }
  return `${sheets.length}:${rules}`;
}

/** @internal A proof that this engine's cascade applies rules that do not
 *  match, or null when there is none (a real browser, or nothing to test). */
export function brokenCascadeProof(
  root: Element | null | undefined,
): CascadeProof | null {
  const doc = (root as unknown as { ownerDocument?: DocLike })?.ownerDocument;
  const html = doc?.documentElement;
  const win = (doc as { defaultView?: Win } | undefined)?.defaultView;
  if (
    !doc || !html || typeof win?.getComputedStyle !== "function" ||
    typeof html.matches !== "function"
  ) return null;
  const sheets = sheetsOf(doc);
  const sig = sheetSignature(sheets);
  const cached = _verdicts.get(doc);
  if (cached && cached.sig === sig) return cached.proof;
  const proof = deriveProof(html, win, sheets);
  _verdicts.set(doc, { sig, proof });
  return proof;
}

function deriveProof(
  html: NonNullable<DocLike["documentElement"]>,
  win: Win,
  sheets: SheetLike[],
): CascadeProof | null {
  // prop → literal values declared by rules that MATCH the root; props some
  // declaration makes inconclusive; prop → value → a NON-matching selector.
  const matching = new Map<string, Set<string>>();
  const inconclusive = new Set<string>();
  const nonMatching = new Map<string, Map<string, string>>();
  let budget = MAX_PROBE_RULES;
  // Anything unseen could hold the declaration that legitimately won, so a
  // sheet it cannot read or a budget it runs out of ends in "no proof".
  let complete = true;

  const customProps = (r: CssRuleLike): string[] => {
    const out: string[] = [];
    for (let k = 0; k < (r.style?.length ?? 0); k++) {
      const p = r.style![k];
      if (typeof p === "string" && p.startsWith("--")) out.push(p);
    }
    return out;
  };
  const visit = (
    rules: ArrayLike<CssRuleLike> | undefined,
    conditional: boolean,
    nested: boolean,
  ): void => {
    for (let i = 0; i < (rules?.length ?? 0); i++) {
      if (--budget < 0) {
        complete = false;
        return;
      }
      const r = rules![i]!;
      const kind = r.constructor?.name ?? "";
      if (kind === "CSSPropertyRule") {
        // A registered property has an initial value and a normalised
        // computed form — neither is a declaration this scan can compare.
        if (typeof r.name === "string") inconclusive.add(r.name);
        continue;
      }
      if (kind === "CSSImportRule") {
        let imported: ArrayLike<CssRuleLike> | undefined;
        try {
          imported = r.styleSheet?.cssRules;
        } catch {
          complete = false;
          return;
        }
        if (!imported) {
          complete = false;
          return;
        }
        visit(imported, true, nested);
        continue;
      }
      if (typeof r.selectorText === "string" && r.style) {
        const props = customProps(r);
        // A nested rule's selector is relative (`&[data-x]`) — it cannot be
        // asked of the root, so what it declares proves nothing either way.
        let hit: boolean | null = null;
        if (!nested && props.length > 0) {
          try {
            hit = html.matches(r.selectorText);
          } catch {
            hit = null; // a selector this engine cannot evaluate
          }
        }
        for (const p of props) {
          const v = r.style.getPropertyValue(p).trim();
          if (hit === null) inconclusive.add(p);
          else if (hit) {
            // `var()` resolves, so its text is not its value; a conditional
            // block may not apply. Either way, no comparison is sound.
            if (conditional || v.includes("var(")) inconclusive.add(p);
            else {
              (matching.get(p) ?? matching.set(p, new Set()).get(p)!).add(v);
            }
          } else {
            const m = nonMatching.get(p) ??
              nonMatching.set(p, new Map()).get(p)!;
            if (!m.has(v)) m.set(v, r.selectorText);
          }
        }
        if (r.cssRules?.length) visit(r.cssRules, conditional, true);
        continue;
      }
      // A grouping rule. `@layer` changes ORDER, never whether a rule applies;
      // everything else (`@media`, `@supports`, `@container`, `@scope`, …) may
      // not apply at all.
      if (r.cssRules) {
        visit(
          r.cssRules,
          conditional || kind !== "CSSLayerBlockRule",
          nested,
        );
      }
    }
  };
  for (const sheet of sheets) {
    let rules: ArrayLike<CssRuleLike> | undefined;
    try {
      rules = sheet?.cssRules;
    } catch {
      return null; // cross-origin: unseen, so possibly the winner
    }
    visit(rules, false, false);
    if (!complete) return null;
  }

  const computed = win.getComputedStyle(html);
  for (const [prop, values] of nonMatching) {
    const declared = matching.get(prop);
    if (!declared || inconclusive.has(prop)) continue;
    if (html.style?.getPropertyValue(prop)) continue; // inline wins, legitimately
    const got = computed.getPropertyValue(prop).trim();
    if (got === "" || declared.has(got)) continue;
    const selector = values.get(got);
    if (selector !== undefined) return { prop, value: got, selector };
  }
  return null;
}

/** The contrast audit's line for an engine this proves broken, or null.
 *  Installed by the test harness through `_setContrastCascadeProbe`. */
export function contrastCascadeNotice(
  root: Element | null | undefined,
): string | null {
  const proof = brokenCascadeProof(root);
  return proof &&
    `[aio-dev] colours could not be resolved here — run the app to check ` +
      `them. This DOM's style cascade is not a browser's: \`${proof.prop}\` ` +
      `came back as \`${proof.value}\`, which only \`${proof.selector}\` ` +
      `declares, and that selector does not match the root element. The ` +
      `contrast walk is skipped here rather than report colours the app ` +
      `cannot paint and miss the ones it does (happy-dom, which testUI runs ` +
      `on, does this).`;
}
