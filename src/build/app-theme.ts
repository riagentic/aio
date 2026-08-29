// app-theme.ts — the stylesheet every aio app has until someone writes one.
//
// An aio app was two files away from working and a stylesheet away from
// looking like anything. Nothing shipped a `style.css`, so every app rendered
// as raw user-agent HTML: Times New Roman, blue underlined links, grey bevel
// buttons. The framework's own baseline fixed the two worst defaults (box
// model, body margin) and stopped there, on the reasonable ground that a
// framework should not have opinions about colour.
//
// That reasoning is right about IMPOSITION and wrong about DEFAULTS. The
// choice is never "aio's opinion vs the author's" — the author's always wins.
// It is "aio's opinion vs the 1996 user-agent stylesheet", and there is no
// version of that where the browser's defaults are the better product.
//
// Three properties make it safe to ship:
//
//   1. **It cannot fight you.** Every rule lives in `@layer aio`. An unlayered
//      rule — i.e. any rule in the app's own CSS — beats every layered rule
//      regardless of specificity, so `button { background: red }` in
//      `style.css` wins without `!important`, without ordering games, and
//      without knowing this file exists.
//   2. **It is the app's colour, not aio's.** The accent hue comes from the
//      same hash as the default icon (`appHue`), so an app is one colour in
//      its taskbar icon, its title bar and its buttons the first time it runs.
//      Two aio apps side by side look like two products.
//   3. **It is three variables deep, and they are named.** `--aio-accent` is
//      the fill; `--aio-on-accent` is the ink that sits ON it; `--aio-accent-ink`
//      is the accent as TEXT on the page. Only `--aio-ring` and `--aio-tint`
//      derive (`color-mix`) — the two inks are contrast-solved here, against
//      the GENERATED hue, so overriding the fill alone leaves them behind. A
//      rebrand sets the trio; `docs/ui/theme.md` says the same thing.
//
// Pure and I/O-free — the server inlines the string into the shell.

import { appHue } from "./app-icon.ts";

/** sRGB relative luminance of an HSL triple (h in deg, s/l in 0..1). */
function luminance(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const ch = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(8) + 0.0722 * ch(4);
}

/** An HSL triple as `#rrggbb` — for values that need an alpha suffix, where a
 *  `hsl(…)` function cannot carry one. Same maths as {@linkcode luminance}'s
 *  channel walk, kept beside it so the two cannot drift. */
function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const ch = (nn: number) => {
    const k = (nn + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, "0");
  };
  return `#${ch(0)}${ch(8)}${ch(4)}`;
}

const contrast = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The accent FILL for a hue, plus the ink that sits on it.
 *
 *  Two rules, and the order matters. Try the vivid colour with dark ink first:
 *  forcing white text on every hue is what turns yellows and limes into olive
 *  sludge, because the only way to carry white is to darken until the colour
 *  is gone. A yellow app should look yellow, so the INK moves instead of the
 *  hue. Blues, purples and deep reds cannot carry dark ink at any lightness —
 *  those take white, and they stay saturated at the lightness white needs. */
function accentFill(hue: number): { accent: string; onAccent: string } {
  const ink = `hsl(${hue} 45% 11%)`;
  const inkLum = luminance(hue, 0.45, 0.11);
  for (let l = 64; l >= 50; l--) {
    if (contrast(luminance(hue, 0.82, l / 100), inkLum) >= 4.6) {
      return { accent: `hsl(${hue} 82% ${l}%)`, onAccent: ink };
    }
  }
  const white = luminance(0, 0, 1);
  for (let l = 52; l >= 20; l--) {
    if (contrast(luminance(hue, 0.72, l / 100), white) >= 4.6) {
      return { accent: `hsl(${hue} 72% ${l}%)`, onAccent: "#fff" };
    }
  }
  return { accent: `hsl(${hue} 72% 20%)`, onAccent: "#fff" };
}

/** The accent as TEXT on `bgLum` — links, badge labels, active nav.
 *
 *  A separate token from the fill, because they answer different questions: a
 *  fill is measured against its own label, text is measured against the page.
 *  Using one value for both is the standard way an accessible-looking palette
 *  ships unreadable links — a bright lime button is correct and bright lime
 *  link text on white is not. `dark` walks lightness the other way. */
function accentInk(hue: number, bgLum: number, dark: boolean): string {
  const range = dark
    ? Array.from({ length: 45 }, (_, i) => 48 + i)
    : Array.from({ length: 45 }, (_, i) => 52 - i);
  for (const l of range) {
    if (contrast(luminance(hue, 0.68, l / 100), bgLum) >= 4.6) {
      return `hsl(${hue} 68% ${l}%)`;
    }
  }
  return dark ? `hsl(${hue} 68% 92%)` : `hsl(${hue} 68% 8%)`;
}

/** The default stylesheet for `name`, as one `@layer aio { … }` block. */
/** The theme's INERT half: the `--aio-*` custom properties (light + dark), and
 *  nothing that paints or sizes anything.
 *
 *  A custom property nothing references renders nothing, which is what makes
 *  this safe to emit next to an app's own stylesheet: it cannot move a box or
 *  repaint a pixel on its own. It is what `ui.theme: "auto"` keeps once the
 *  app brings its own CSS — so `ui.chrome: "themed"`'s title bar (which reads
 *  `var(--aio-…, fallback)`) stays coherent, and an app can reference a token
 *  deliberately, while every VISUAL default steps aside. */
export function appThemeTokensCss(name: string): string {
  return sliceTokens(appThemeCss(name));
}

/** The `:root` blocks of a theme stylesheet — everything up to the first
 *  visual rule, which is marked by the `canvas` banner. Derived from the ONE
 *  stylesheet rather than duplicated, so the two can never drift into two
 *  palettes. */
function sliceTokens(css: string): string {
  const cut = css.indexOf(TOKENS_END);
  // No marker (someone edited the banner out) → keep the variables ONLY if we
  // can prove where they end. Falling back to the whole sheet would silently
  // restyle every app that asked for tokens; emitting nothing loses the
  // palette the title bar reads. Refuse loudly instead: this is a build-time
  // invariant of a file in this repo, not a runtime condition.
  if (cut === -1) {
    throw new Error(
      "[aio] app-theme.ts: the token/visual boundary marker is gone — " +
        `appThemeTokensCss cannot tell the inert half from the visual one. ` +
        `Restore the "${TOKENS_END.trim()}" banner.`,
    );
  }
  return css.slice(0, cut).trimEnd() + "\n}\n";
}

/** The banner that separates the inert `:root` tokens from the first rule that
 *  paints. Load-bearing — {@linkcode sliceTokens} cuts here. */
const TOKENS_END = "/* ── canvas ";

export function appThemeCss(name: string): string {
  const hue = appHue(name);
  const { accent, onAccent } = accentFill(hue);
  const inkLight = accentInk(hue, luminance(hue, 0.004, 0.99), false);
  const inkDark = accentInk(hue, luminance(hue, 0.14, 0.09), true);
  // Neutrals carry a few degrees of the accent's hue. A pure grey next to a
  // saturated accent reads as two unrelated palettes; a hue-tinted neutral
  // reads as one designed thing, and the tint is far too low to notice as
  // colour.
  // `s * 100` on a 0.14 literal is 14.000000000000002 in binary floating point,
  // and that lands verbatim in a stylesheet `am theme adopt` hands to the user.
  // Round to one decimal: far finer than any perceivable step in saturation.
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const n = (l: number, s = 0.06) => `hsl(${hue} ${pct(s)} ${l}%)`;
  // The SHADOW colour, as #rrggbb, because a shadow needs an alpha suffix and
  // `hsl(…)14` is not a colour — it is a token sequence a custom property will
  // happily hold and `box-shadow` will refuse at computed-value time, which is
  // exactly how the light theme shipped with no elevation at all from alpha61
  // to alpha63 (dark mode used literal hex and was fine). Measured in Chromium:
  // `getComputedStyle(card).boxShadow === "none"`. `tests/app-theme.test.ts`
  // now resolves every token against its consumer, so this cannot recur.
  const shadowHex = hslHex(hue, 0.14, 0.12);
  return `@layer aio {
:root{
  --aio-hue:${hue};
  --aio-accent:${accent};
  --aio-on-accent:${onAccent};
  --aio-accent-ink:${inkLight};
  --aio-bg:${n(99, 0.4)};
  --aio-surface:#fff;
  --aio-surface-2:${n(97, 0.3)};
  --aio-text:${n(12, 0.14)};
  --aio-muted:${n(42, 0.08)};
  --aio-border:${n(88, 0.12)};
  --aio-danger:hsl(2 72% 45%);
  --aio-ok:hsl(152 62% 32%);
  --aio-warn:hsl(38 82% 38%);
  --aio-r-1:6px; --aio-r-2:10px; --aio-r-3:14px; --aio-r-4:20px;
  --aio-page:72rem;
  --aio-s-1:.25rem; --aio-s-2:.5rem; --aio-s-3:.75rem;
  --aio-s-4:1rem; --aio-s-5:1.5rem; --aio-s-6:2.5rem;
  --aio-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,
    "Helvetica Neue",Arial,sans-serif;
  --aio-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,
    "Liberation Mono",monospace;
  --aio-shadow-1:0 1px 2px ${shadowHex}14;
  --aio-shadow-2:0 6px 24px -8px ${shadowHex}2e,0 1px 2px ${shadowHex}14;
  --aio-ring:0 0 0 3px color-mix(in oklab, var(--aio-accent) 35%, transparent);
  --aio-tint:color-mix(in oklab, var(--aio-accent) 10%, var(--aio-surface));
}
@media (prefers-color-scheme: dark){:root{
  --aio-accent-ink:${inkDark};
  --aio-bg:${n(9, 0.14)};
  --aio-surface:${n(13, 0.12)};
  --aio-surface-2:${n(17, 0.1)};
  --aio-text:${n(94, 0.1)};
  --aio-muted:${n(64, 0.08)};
  --aio-border:${n(26, 0.1)};
  --aio-danger:hsl(2 78% 66%);
  --aio-ok:hsl(152 52% 58%);
  --aio-warn:hsl(38 84% 62%);
  --aio-shadow-1:0 1px 2px #0006;
  --aio-shadow-2:0 8px 28px -10px #0009,0 1px 2px #0006;
}}

/* ── canvas ─────────────────────────────────────────────────────── */
/* color-scheme is the first thing that PAINTS, so it lives here and not
   among the tokens: it repaints the UA canvas, the default text colour, form
   controls and scrollbars on a dark-mode machine. Emitting it with the "inert"
   half turned an app that never asked for a theme into a dark-mode app whose
   own light panels kept white text — measured white-on-white. A custom
   property renders nothing; this is not one. */
:root{color-scheme: light dark}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--aio-bg); color:var(--aio-text);
  font-family:var(--aio-font); font-size:16px; line-height:1.6;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}
::selection{background:color-mix(in oklab,var(--aio-accent) 26%,transparent)}
:where(a,button,input,select,textarea,summary,[tabindex]):focus-visible{
  outline:2px solid var(--aio-accent); outline-offset:2px; border-radius:var(--aio-r-1);
}
@media (prefers-reduced-motion:no-preference){
  :where(a,button,input,select,textarea,summary,.card){
    transition:background-color .15s ease,border-color .15s ease,
      color .15s ease,box-shadow .15s ease,transform .15s ease;
  }
}

/* Writing <main> is the whole opt-in for a page shell: apps that want the
   full bleed (a canvas, a map, a game) simply do not use it. */
:where(main){
  display:block; max-width:var(--aio-page); margin-inline:auto;
  padding:var(--aio-s-5) var(--aio-s-4);
}
/* A full-bleed bar whose CONTENT lines up with <main>. Two elements sharing a
   max-width but not a parent otherwise disagree by exactly the scrollbar, and
   a header that starts one pixel left of the page under it is the first thing
   an eye catches. */
/* #root as well as body: aio mounts the app into the root div, so an app
   whose top level is header/main/footer has none of them as a direct child of
   body. Matching only body> styled the shell nobody writes and skipped the
   one everybody does. */
:where(body>header,body>footer,#root>header,#root>footer){
  padding-block:var(--aio-s-4);
  padding-inline:max(
    var(--aio-s-4),
    calc((100% - var(--aio-page)) / 2 + var(--aio-s-4))
  );
}
:where(body>header,#root>header){border-bottom:1px solid var(--aio-border)}
:where(body>footer,#root>footer){
  border-top:1px solid var(--aio-border); color:var(--aio-muted); font-size:.9em;
}

/* ── type ───────────────────────────────────────────────────────── */
:where(h1,h2,h3,h4,h5,h6){
  margin:0 0 var(--aio-s-3); line-height:1.2; font-weight:650;
  letter-spacing:-.018em; text-wrap:balance;
}
:where(h1){font-size:clamp(1.7rem,1.2rem + 1.6vw,2.4rem)}
:where(h2){font-size:1.5rem}
:where(h3){font-size:1.2rem}
:where(p,ul,ol,dl,pre,blockquote,table,figure){margin:0 0 var(--aio-s-4)}
:where(p){text-wrap:pretty}
:where(small){color:var(--aio-muted)}
:where(strong,b){font-weight:650}
:where(a){
  color:var(--aio-accent-ink); text-decoration:none;
  text-underline-offset:.18em; text-decoration-thickness:.08em;
}
:where(a:hover){text-decoration:underline}
:where(hr){
  border:0; height:1px; background:var(--aio-border); margin:var(--aio-s-5) 0;
}
:where(ul,ol){padding-inline-start:1.35em}
:where(li){margin-bottom:var(--aio-s-1)}
:where(blockquote){
  padding-inline-start:var(--aio-s-4); border-inline-start:3px solid var(--aio-accent);
  color:var(--aio-muted);
}

/* ── code ───────────────────────────────────────────────────────── */
:where(code,kbd,samp,pre){font-family:var(--aio-mono); font-size:.9em}
:where(code):not(pre code){
  background:var(--aio-surface-2); border:1px solid var(--aio-border);
  border-radius:var(--aio-r-1); padding:.12em .38em;
}
:where(pre){
  background:var(--aio-surface-2); border:1px solid var(--aio-border);
  border-radius:var(--aio-r-2); padding:var(--aio-s-4); overflow:auto;
}
:where(kbd){
  background:var(--aio-surface); border:1px solid var(--aio-border);
  border-bottom-width:2px; border-radius:var(--aio-r-1); padding:.1em .4em;
}

/* ── controls ───────────────────────────────────────────────────── */
:where(button,input,select,textarea){font:inherit; color:inherit}
:where(button,[type=button],[type=submit],[type=reset]){
  display:inline-flex; align-items:center; justify-content:center; gap:.5em;
  padding:.5em 1em; border:1px solid var(--aio-border);
  border-radius:var(--aio-r-2); background:var(--aio-surface);
  box-shadow:var(--aio-shadow-1); cursor:pointer; font-weight:550;
  line-height:1.2;
}
:where(button,[type=button],[type=submit]):hover:not(:disabled){
  background:var(--aio-surface-2);
}
:where(button,[type=button],[type=submit]):active:not(:disabled){
  transform:translateY(1px);
}
:where(button,input,select,textarea):disabled{opacity:.55; cursor:not-allowed}
/* The one accent control: .primary (and a submit button, which always is
   one). Everything else stays quiet — that is what makes it read as one. */
:where(button.primary,[type=submit],.btn.primary){
  background:var(--aio-accent); color:var(--aio-on-accent);
  border-color:transparent;
}
:where(button.primary,[type=submit]):hover:not(:disabled){
  background:color-mix(in oklab,var(--aio-accent) 88%,#000);
}
:where(button.ghost){background:transparent; border-color:transparent; box-shadow:none}
:where(button.ghost):hover:not(:disabled){background:var(--aio-surface-2)}
:where(button.danger){
  background:var(--aio-danger); color:#fff; border-color:transparent;
}
:where(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file]){
  width:100%; padding:.5em .7em; background:var(--aio-surface);
  border:1px solid var(--aio-border); border-radius:var(--aio-r-2);
}
:where(input,select,textarea):hover:not(:disabled){
  border-color:color-mix(in oklab,var(--aio-accent) 40%,var(--aio-border));
}
:where(input,select,textarea):focus{
  outline:none; border-color:var(--aio-accent); box-shadow:var(--aio-ring);
}
:where(input,textarea)::placeholder{color:var(--aio-muted)}
:where(textarea){min-height:6em; resize:vertical}
:where([type=checkbox],[type=radio]){accent-color:var(--aio-accent); width:1.05em; height:1.05em}
:where(label){display:inline-block; margin-bottom:var(--aio-s-1); font-weight:550}
:where(fieldset){
  border:1px solid var(--aio-border); border-radius:var(--aio-r-2);
  padding:var(--aio-s-4); margin:0 0 var(--aio-s-4);
}
:where(legend){padding-inline:var(--aio-s-2); font-weight:600}
:where(progress){accent-color:var(--aio-accent); width:100%; height:.5rem}

/* ── data ───────────────────────────────────────────────────────── */
:where(table){border-collapse:collapse; width:100%}
:where(th,td){
  padding:.55em .7em; text-align:start;
  border-bottom:1px solid var(--aio-border);
}
:where(thead th){
  font-size:.82em; letter-spacing:.05em; text-transform:uppercase;
  color:var(--aio-muted); font-weight:600;
}
:where(tbody tr):hover{background:var(--aio-surface-2)}
:where(img,video,canvas,svg){max-width:100%; height:auto}
:where(dialog){
  border:1px solid var(--aio-border); border-radius:var(--aio-r-3);
  background:var(--aio-surface); color:var(--aio-text);
  box-shadow:var(--aio-shadow-2); padding:var(--aio-s-5);
}
:where(dialog)::backdrop{background:#0007; backdrop-filter:blur(2px)}
:where(details){
  border:1px solid var(--aio-border); border-radius:var(--aio-r-2);
  padding:var(--aio-s-3) var(--aio-s-4); margin-bottom:var(--aio-s-3);
}
:where(summary){cursor:pointer; font-weight:600}

/* ── the six classes worth having ───────────────────────────────── */
:where(.card){
  background:var(--aio-surface); border:1px solid var(--aio-border);
  border-radius:var(--aio-r-3); padding:var(--aio-s-4);
  box-shadow:var(--aio-shadow-1);
}
:where(.stack){display:flex; flex-direction:column; gap:var(--aio-s-3)}
:where(.row){display:flex; align-items:center; gap:var(--aio-s-3); flex-wrap:wrap}
:where(.grid){
  display:grid; gap:var(--aio-s-4);
  grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));
}
:where(.muted){color:var(--aio-muted)}
:where(.badge){
  display:inline-flex; align-items:center; gap:.35em;
  padding:.12em .6em; border-radius:var(--aio-r-4);
  background:var(--aio-tint); color:var(--aio-accent-ink);
  font-size:.82em; font-weight:600;
}

/* ── the three environments a stylesheet must not ignore ────────── */
/*
   Everything above answers "what does this app look like". These three answer
   "does it still work for someone whose machine is set up differently", and
   until alpha72 the theme answered none of them. A default stylesheet that
   only works on the author's monitor is not a default worth shipping.
*/

/* 1. A COARSE POINTER. aio builds Android APKs, and a 24px button that is
      comfortable with a mouse is a miss with a thumb. WCAG 2.5.8 asks for
      24px minimum and every platform guideline says 44. Only under
      "pointer:coarse", so a dense desktop table is not inflated for a mouse
      that does not need it. min-height + inline padding rather than a fixed
      height: the control still grows with its content. */
@media (pointer:coarse){
  :where(button,[role="button"],input[type="button"],input[type="submit"],
         input[type="reset"],select,summary,a.button,.aio-btn){
    min-height:44px;
  }
  :where(input,textarea){min-height:44px}
  /* A checkbox/radio is the one control a browser will not grow: give the
     TAP TARGET the size instead of the box, so the visual stays 16px. */
  :where(input[type="checkbox"],input[type="radio"]){
    min-width:24px; min-height:24px;
  }
}

/* 2. "prefers-contrast: more". A user who asked their OS for more contrast is
      telling every app the same thing, and a theme built on soft borders and
      muted secondary text is exactly what they are asking to be turned off.
      Borders go to the ink colour, muted text stops being muted, and the
      focus ring gets thick enough to find. */
@media (prefers-contrast:more){
  :root{
    --aio-border:var(--aio-text);
    --aio-muted:var(--aio-text);
    --aio-shadow-1:none;
    --aio-shadow-2:none;
  }
  :where(a,button,input,select,textarea,summary,[tabindex]):focus-visible{
    outline-width:3px; outline-offset:3px;
  }
  :where(.card,dialog,details,input,select,textarea,button){border-width:2px}
}

/* 3. FORCED COLORS (Windows high contrast, and "forced-colors: active"
      anywhere). The OS replaces every colour with its own palette, so custom
      backgrounds and borders are discarded and anything that carried meaning
      ONLY through colour disappears. Two things must be restored by hand: a
      border where a background used to do the separating, and a focus ring in
      the system's own highlight colour — the default one is drawn with our
      accent, which is one of the colours that just vanished. */
@media (forced-colors:active){
  :where(.card,dialog,details,.badge,input,select,textarea,button){
    border:1px solid CanvasText;
  }
  :where(a,button,input,select,textarea,summary,[tabindex]):focus-visible{
    outline:3px solid Highlight; outline-offset:2px;
  }
  /* An SVG icon drawn with currentColor follows the system ink; one with a
     baked fill does not. Ask the UA to adjust ours. */
  :where(svg){forced-color-adjust:auto}
  :where(.badge){background:Canvas; color:CanvasText}
}
}
`;
}
