// The colour half of the accessibility story.
//
// aio warns about the accessibility of STRUCTURE — an `<img>` with no `alt`,
// an unlabelled `<input>`, a `<div onClick>` with no keyboard handler — and
// said nothing about colour, while shipping a generated colour system. A user
// reported the consequence in their own words: "fix colors, it's gray to dark
// gray and some black text is not visible at all." `deno check`, `deno lint`,
// `aiol`, 31 app tests and `deno task build` were all green on that build.
//
// Two properties are asserted, and the second matters as much as the first: the
// audit must be SILENT where it cannot measure. A contrast checker that
// confidently reports "no problems" on an engine that computes no colours is a
// wrong answer, which is the failure class this project treats as worse than a
// missing feature.
import { assert, assertEquals } from "@std/assert";
import {
  _resetContrastAudit,
  _setContrastCascadeProbe,
  auditContrast,
  canAuditContrast,
  over,
  parseRgb,
} from "../src/air/contrast-audit.ts";
import {
  brokenCascadeProof,
  contrastCascadeNotice,
} from "../src/air/contrast-cascade.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { closeWindow } from "../src/testing/close-window.ts";

/** A DOM whose `getComputedStyle` answers from an inline map — the shape a real
 *  engine reports (always resolved `rgb()`, never a keyword or a var()). */
function fakeDom(
  styles: Record<string, Record<string, string>>,
  html: Array<{ id: string; tag: string; text?: string; children?: string[] }>,
) {
  const byId = new Map<string, Record<string, unknown>>();
  const make = (
    spec: { id: string; tag: string; text?: string; children?: string[] },
  ): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tagName: spec.tag.toUpperCase(),
      _id: spec.id,
      parentElement: null,
      childNodes: spec.text !== undefined
        ? [{ nodeType: 3, nodeValue: spec.text }]
        : [],
      children: [] as unknown[],
      getAttribute: (n: string) => n === "class" ? spec.id : null,
    };
    byId.set(spec.id, el);
    return el;
  };
  for (const spec of html) make(spec);
  for (const spec of html) {
    const el = byId.get(spec.id)!;
    for (const c of spec.children ?? []) {
      const child = byId.get(c)!;
      child.parentElement = el;
      (el.children as unknown[]).push(child);
    }
  }
  const win = {
    getComputedStyle: (e: { _id: string }) => ({
      getPropertyValue: (p: string) => styles[e._id]?.[p] ?? "",
    }),
  };
  for (const el of byId.values()) el.ownerDocument = { defaultView: win };
  return byId;
}

Deno.test("contrast: unreadable body text is reported", () => {
  setDevModeOverride(true);
  _resetContrastAudit();
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (m: string) => warns.push(m);
  try {
    // The measured shape from the field report: near-black ink (#0f1629) that
    // was solved for a LIGHT accent fill, landing on a dark surface. 1.09:1.
    const dom = fakeDom({
      page: { "background-color": "rgb(23, 26, 33)" },
      label: { "color": "rgb(15, 22, 41)", "font-size": "14px" },
    }, [
      { id: "page", tag: "div", children: ["label"] },
      { id: "label", tag: "span", text: "Applied" },
    ]);
    const found = auditContrast(
      dom.get("page") as unknown as Element,
    );
    assertEquals(found, 1, `expected one finding, got: ${warns.join("\n")}`);
    assert(warns[0]!.includes("unreadable"), warns[0]);
    assert(warns[0]!.includes(":1"), "the ratio must be in the message");
  } finally {
    console.warn = real;
  }
});

Deno.test("contrast: a readable pair is not reported", () => {
  setDevModeOverride(true);
  _resetContrastAudit();
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (m: string) => warns.push(m);
  try {
    const dom = fakeDom({
      page: { "background-color": "rgb(255, 255, 255)" },
      label: { "color": "rgb(31, 35, 40)", "font-size": "14px" },
    }, [
      { id: "page", tag: "div", children: ["label"] },
      { id: "label", tag: "span", text: "Applied" },
    ]);
    assertEquals(
      auditContrast(dom.get("page") as unknown as Element),
      0,
      `a 14:1 pair must be silent, got: ${warns.join("\n")}`,
    );
  } finally {
    console.warn = real;
  }
});

Deno.test("contrast: large text is held to 3:1, not 4.5:1", () => {
  setDevModeOverride(true);
  _resetContrastAudit();
  const real = console.warn;
  console.warn = () => {};
  try {
    // ~3.5:1 — fails AA for body text, passes for a heading.
    const styles = {
      page: { "background-color": "rgb(255, 255, 255)" },
      h: {
        "color": "rgb(122, 122, 122)",
        "font-size": "32px",
        "font-weight": "700",
      },
    };
    const big = fakeDom(styles, [
      { id: "page", tag: "div", children: ["h"] },
      { id: "h", tag: "h1", text: "Heading" },
    ]);
    assertEquals(auditContrast(big.get("page") as unknown as Element), 0);
    _resetContrastAudit();
    const small = fakeDom({
      page: styles.page,
      h: { ...styles.h, "font-size": "14px", "font-weight": "400" },
    }, [
      { id: "page", tag: "div", children: ["h"] },
      { id: "h", tag: "span", text: "Body" },
    ]);
    assertEquals(
      auditContrast(small.get("page") as unknown as Element),
      1,
      "the same colour at body size is a finding",
    );
  } finally {
    console.warn = real;
  }
});

Deno.test("contrast: a translucent panel is composited, not guessed", () => {
  setDevModeOverride(true);
  _resetContrastAudit();
  const real = console.warn;
  console.warn = () => {};
  try {
    // A 50% white panel over black is mid-grey. Naively reading the panel's own
    // colour would call white text readable; naively reading the page would
    // call it readable too. Compositing is the only answer that is right.
    const dom = fakeDom({
      page: { "background-color": "rgb(0, 0, 0)" },
      panel: { "background-color": "rgba(255, 255, 255, 0.5)" },
      label: { "color": "rgb(255, 255, 255)", "font-size": "14px" },
    }, [
      { id: "page", tag: "div", children: ["panel"] },
      { id: "panel", tag: "div", children: ["label"] },
      { id: "label", tag: "span", text: "hi" },
    ]);
    assertEquals(
      auditContrast(dom.get("page") as unknown as Element),
      1,
      "white on a 50%-white-over-black panel is 2.6:1 — a real finding that " +
        "either single-layer reading would have missed",
    );
  } finally {
    console.warn = real;
  }
});

Deno.test("contrast: silent — not 'clean' — where colour cannot be measured", () => {
  setDevModeOverride(true);
  _resetContrastAudit();
  // happy-dom's shape: a window exists, every computed value is "".
  const dom = fakeDom({}, [
    { id: "page", tag: "div", children: ["label"] },
    { id: "label", tag: "span", text: "x" },
  ]);
  const root = dom.get("page") as unknown as Element;
  assertEquals(auditContrast(root), 0, "nothing measurable, nothing reported");
  assert(
    canAuditContrast(root),
    "a window IS present — the caller can tell 'no engine' from 'no findings'",
  );
});

Deno.test("contrast: production is untouched", () => {
  setDevModeOverride(false);
  _resetContrastAudit();
  const dom = fakeDom({
    page: { "background-color": "rgb(23, 26, 33)" },
    label: { "color": "rgb(15, 22, 41)", "font-size": "14px" },
  }, [
    { id: "page", tag: "div", children: ["label"] },
    { id: "label", tag: "span", text: "Applied" },
  ]);
  assertEquals(
    auditContrast(dom.get("page") as unknown as Element),
    0,
    "a dev-only observation must cost a production build exactly nothing",
  );
  setDevModeOverride(true);
});

Deno.test("contrast: parseRgb accepts what an engine computes, and only that", () => {
  assertEquals(parseRgb("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
  assertEquals(parseRgb("rgba(1, 2, 3, 0.5)"), { r: 1, g: 2, b: 3, a: 0.5 });
  assertEquals(parseRgb("rgb(1 2 3 / 50%)"), { r: 1, g: 2, b: 3, a: 0.5 });
  // happy-dom — what `testUI` runs on — answers with the authored HEX, so both
  // forms are read. Measured against a real happy-dom window below.
  assertEquals(parseRgb("#0f1629"), { r: 15, g: 22, b: 41, a: 1 });
  assertEquals(parseRgb("#eee"), { r: 238, g: 238, b: 238, a: 1 });
  assertEquals(parseRgb("#00000080")!.a, 128 / 255);
  // hsl()/hsla() too, because the KIT writes one: `<Avatar>` colours its
  // circle `hsl(${hueFor(name)}, 55%, 45%)`. A real browser normalises that
  // to `rgb()` in a computed style; happy-dom hands back what was authored,
  // and `testUI` runs on happy-dom — so the environment this project calls
  // the strictest was the one that could not read it.
  assertEquals(parseRgb("hsl(0,100%,50%)"), { r: 255, g: 0, b: 0, a: 1 });
  assertEquals(parseRgb("hsl(275, 55%, 45%)"), {
    r: 125,
    g: 52,
    b: 178,
    a: 1,
  });
  assertEquals(parseRgb("hsla(120, 100%, 25%, 0.5)"), {
    r: 0,
    g: 128,
    b: 0,
    a: 0.5,
  });
  assertEquals(parseRgb("hsl(120deg 100% 25%)"), { r: 0, g: 128, b: 0, a: 1 });
  // Never guessed: a named colour, a var(), a malformed hex, a colour space
  // this does not read or an empty string is "unknown", and an unknown colour
  // must skip the element rather than be assumed anything.
  for (
    const bad of ["", "transparent", "#12345", "var(--x)", "rebeccapurple"]
  ) {
    assertEquals(parseRgb(bad), null, bad);
  }
  assertEquals(parseRgb("oklch(.5 .2 300)"), null);
});

Deno.test("contrast: a background it CANNOT READ is not a white background", async () => {
  // `parseRgb` answered null for "transparent" and for "I cannot read this"
  // alike, so the climb walked straight past an opaque panel and landed on
  // the white page fallback — and reported white-on-white, 1.00:1, in the
  // framework's loudest dev channel, on markup the app author did not write.
  // Measured on one colour in three spellings: rgb() silent, hsl() and the
  // named form each a false alarm.
  const unreadable = await inHappyDom(
    ".root{background:rebeccapurple}.lab{color:#ffffff;font-size:14px}",
    `<div class="root"><span class="lab">readable in any browser</span></div>`,
  );
  assertEquals(
    unreadable.findings,
    0,
    `a background it cannot read must be skipped, not assumed white: ${
      unreadable.warns.join(" | ")
    }`,
  );
  // …and the audit is not deaf: a REAL violation on a background it CAN read
  // still fires.
  const real = await inHappyDom(
    ".root{background:#ffffff}.lab{color:#eeeeee;font-size:14px}",
    `<div class="root"><span class="lab">unreadable for real</span></div>`,
  );
  assert(real.findings > 0, "the audit must still report a real violation");
  // …including one written in hsl(), which it can read now.
  const viaHsl = await inHappyDom(
    ".root{background:hsl(0,0%,100%)}.lab{color:hsl(0,0%,93%);font-size:14px}",
    `<div class="root"><span class="lab">unreadable, in hsl</span></div>`,
  );
  assert(viaHsl.findings > 0, "hsl() is read, so a violation in it is found");
});

Deno.test("contrast audit: the element is named the way HTML spells it", async () => {
  // `<button class="btn.btn-lg">` matched neither HTML nor a CSS selector, so
  // it pasted into nothing (a field report). Spaces, like the markup.
  const r = await inHappyDom(
    ".root{background:#ffffff}.a{color:#eeeeee;font-size:14px}",
    `<div class="root"><span class="a b c">low contrast</span></div>`,
  );
  assert(
    r.warns.some((w) => w.includes('<span class="a b c">')),
    r.warns.join(" | "),
  );
});

// ── The instrument, against a REAL engine ────────────────────────────────
//
// Every test above drives a hand-built DOM, and a stub that agrees with the
// author is not evidence. These two run the audit over a real happy-dom window
// — the engine `testUI` uses — with a real stylesheet and real inheritance.

async function inHappyDom(
  css: string,
  html: string,
): Promise<{ findings: number; warns: string[] }> {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: "https://x.test" });
  const doc = win.document;
  doc.body.innerHTML = `<style>${css}</style>${html}`;
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (m: string) => warns.push(m);
  try {
    setDevModeOverride(true);
    _resetContrastAudit();
    const findings = auditContrast(
      doc.querySelector(".root") as unknown as Element,
    );
    return { findings, warns };
  } finally {
    console.warn = real;
    await closeWindow(win);
  }
}

Deno.test("contrast: fires on a real happy-dom window", async () => {
  const { findings, warns } = await inHappyDom(
    ".root{background:#171a21}.lab{color:#0f1629;font-size:14px}",
    `<div class="root"><span class="lab">Applied</span></div>`,
  );
  assertEquals(findings, 1, warns.join("\n"));
  assert(warns[0]!.includes("1.0"), `the measured ratio: ${warns[0]}`);
});

Deno.test("contrast: an INHERITED readable colour is silent in happy-dom", async () => {
  // The half that matters for noise: `.root span` has no `color` rule of its
  // own and must be measured with the inherited one, against the panel it sits
  // in. Reading a UA default here would warn on every dark-themed app in every
  // test run, which is how a good check becomes a muted one.
  const { findings, warns } = await inHappyDom(
    ".root{background:#111;color:#eee}",
    `<div class="root"><p><span>inherited text</span></p></div>`,
  );
  assertEquals(findings, 0, warns.join("\n"));
});

Deno.test("contrast: over() composites alpha the way a compositor does", () => {
  assertEquals(
    over({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 }),
    { r: 127.5, g: 127.5, b: 127.5, a: 1 },
  );
});

// ── Report 9 §1: a cascade that is not a browser's ───────────────────────
//
// The walk stands down where the engine applies rules that do not match. The
// testUI half lives in `contrast-audit-untrusted-cascade.test.ts`; these pin
// that the proof CANNOT fire on a browser-faithful engine, which is the half a
// happy-dom test cannot show.

/** A style rule as a CSSOM engine exposes it. */
function rule(selectorText: string, decls: Record<string, string>) {
  const props = Object.keys(decls);
  return {
    constructor: { name: "CSSStyleRule" },
    selectorText,
    style: Object.assign({ ...props }, {
      length: props.length,
      getPropertyValue: (p: string) => decls[p] ?? "",
    }),
  };
}
function group(name: string, rules: unknown[]) {
  return { constructor: { name }, cssRules: rules };
}

/** A document whose root matches `rootMatches` and computes `computedRoot` —
 *  the answers a real browser gives, written out by hand per case. */
function browserDoc(
  rules: unknown[],
  rootMatches: (sel: string) => boolean,
  computedRoot: Record<string, string>,
  inline: Record<string, string> = {},
) {
  const html = {
    tagName: "HTML",
    matches: rootMatches,
    style: { getPropertyValue: (p: string) => inline[p] ?? "" },
  };
  const win = {
    getComputedStyle: (e: unknown) => ({
      getPropertyValue: (p: string) => e === html ? computedRoot[p] ?? "" : "",
    }),
  };
  const doc = {
    defaultView: win,
    documentElement: html,
    styleSheets: [{ cssRules: rules }],
  };
  const el = { ownerDocument: doc, tagName: "DIV" } as unknown as Element;
  return el;
}
const onlyRoot = (sel: string) => sel === ":root";

Deno.test("contrast cascade: a browser's answer to two palettes is not a proof", () => {
  _setContrastCascadeProbe(contrastCascadeNotice);
  const el = browserDoc(
    [
      rule(":root", { "--accent": "#e07a58" }),
      rule(':root[data-palette="contrast"]', { "--accent": "#4a5b78" }),
    ],
    onlyRoot,
    { "--accent": "#e07a58" }, // the matching rule won, as it must
  );
  assertEquals(brokenCascadeProof(el), null);
  assert(canAuditContrast(el), "a real browser keeps its audit");
});

Deno.test("contrast cascade: the engine that applied the non-matching palette is caught", () => {
  _setContrastCascadeProbe(contrastCascadeNotice);
  const el = browserDoc(
    [
      rule(":root", { "--accent": "#e07a58" }),
      rule(':root[data-palette="contrast"]', { "--accent": "#4a5b78" }),
    ],
    onlyRoot,
    { "--accent": "#4a5b78" },
  );
  assertEquals(brokenCascadeProof(el), {
    prop: "--accent",
    value: "#4a5b78",
    selector: ':root[data-palette="contrast"]',
  });
  assertEquals(canAuditContrast(el), false);
});

Deno.test("contrast cascade: every legitimate coincidence stays 'trustworthy'", () => {
  const contrastLast = rule('[data-palette="contrast"]', { "--x": "#000" });
  // The matching value goes through var() — its text is not its value.
  assertEquals(
    brokenCascadeProof(browserDoc(
      [rule(":root", { "--x": "var(--y)", "--y": "#000" }), contrastLast],
      onlyRoot,
      { "--x": "#000", "--y": "#000" },
    )),
    null,
    "var() indirection",
  );
  // The matching value that won sits under @media — the scan cannot know
  // whether it applies, so it does not claim.
  assertEquals(
    brokenCascadeProof(browserDoc(
      [
        rule(":root", { "--x": "#fff" }),
        group("CSSMediaRule", [rule(":root", { "--x": "#000" })]),
        contrastLast,
      ],
      onlyRoot,
      { "--x": "#000" },
    )),
    null,
    "@media",
  );
  // An inline declaration on the root wins over every sheet.
  assertEquals(
    brokenCascadeProof(browserDoc(
      [rule(":root", { "--x": "#fff" }), contrastLast],
      onlyRoot,
      { "--x": "#000" },
      { "--x": "#000" },
    )),
    null,
    "inline style",
  );
  // A registered property has an initial value no declaration shows.
  assertEquals(
    brokenCascadeProof(browserDoc(
      [
        { constructor: { name: "CSSPropertyRule" }, name: "--x" },
        rule(":root", { "--x": "#fff" }),
        contrastLast,
      ],
      onlyRoot,
      { "--x": "#000" },
    )),
    null,
    "@property",
  );
  // A sheet it cannot read may hold the declaration that won.
  const el = browserDoc(
    [rule(":root", { "--x": "#fff" }), contrastLast],
    onlyRoot,
    { "--x": "#000" },
  );
  const doc = (el as unknown as { ownerDocument: { styleSheets: unknown[] } })
    .ownerDocument;
  doc.styleSheets.push({
    get cssRules(): never {
      throw new DOMException("cross-origin", "SecurityError");
    },
  });
  assertEquals(brokenCascadeProof(el), null, "cross-origin sheet");
  // …and `@layer` changes order, not applicability, so it still proves.
  assert(
    brokenCascadeProof(browserDoc(
      [
        group("CSSLayerBlockRule", [rule(":root", { "--x": "#fff" })]),
        contrastLast,
      ],
      onlyRoot,
      { "--x": "#000" },
    )) !== null,
    "@layer",
  );
});

Deno.test("contrast cascade: in a real happy-dom window the walk stands down once, loudly", async () => {
  // What `testUI`/`testComponent` install on every mount.
  _setContrastCascadeProbe(contrastCascadeNotice);
  _resetContrastAudit({ cascadeNotice: true });
  const css = ":root{--ink:#eeeeee;--bg:#111111}" +
    ':root[data-palette="light"]{--ink:#111111;--bg:#ffffff}' +
    ':root[data-palette="print"]{--ink:#ffffff;--bg:#ffffff}' +
    ".root{background-color:var(--bg);color:var(--ink)}";
  const first = await inHappyDom(css, `<div class="root"><span>x</span></div>`);
  assertEquals(first.findings, 0, first.warns.join("\n"));
  assertEquals(first.warns.length, 1, first.warns.join("\n"));
  assert(
    first.warns[0]!.includes("colours could not be resolved here"),
    first.warns[0],
  );
  // Said once: the same engine answers the same way on the next pass.
  const again = await inHappyDom(css, `<div class="root"><span>x</span></div>`);
  assertEquals(again.warns, []);
  // A single palette leaves nothing to disprove, and the walk still measures.
  const single = await inHappyDom(
    ":root{--ink:#eeeeee;--bg:#ffffff}" +
      ".root{background-color:var(--bg);color:var(--ink)}",
    `<div class="root"><span>x</span></div>`,
  );
  assertEquals(single.findings, 1, single.warns.join("\n"));
  _setContrastCascadeProbe(null);
});
