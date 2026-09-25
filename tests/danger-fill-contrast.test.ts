// A danger button's label must be readable on its own fill, in BOTH schemes.
//
// The accent fill has always carried a contrast-solved ink (`--aio-on-accent`,
// checked across the hue wheel in app-theme.test.ts). The danger fill did not:
// the theme's `button.danger` and the kit's `.aio-btn--danger` hard-coded
// `color: #fff`, and dark mode LIGHTENS the danger colour so it reads on a
// dark page — white on the dark-mode danger fill measured 3.1:1 (theme) and
// 2.8:1 (kit), below WCAG AA's 4.5:1 and even the 3:1 large-text floor. The
// one button whose label says "Delete" was the unreadable one.
import { assert, assertEquals } from "@std/assert";
import { appThemeCss } from "../src/build/app-theme.ts";
import { UI_CSS } from "../src/ui/styles.ts";

/** sRGB channels 0..1 of `#rgb`, `#rrggbb` or `hsl(H S% L%)`. */
function rgb(c: string): [number, number, number] {
  c = c.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    const x = m[1]!.length === 3
      ? [...m[1]!].map((d) => d + d).join("")
      : m[1]!;
    return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
  }
  m = /^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/.exec(c);
  if (!m) throw new Error(`not a colour this test reads: ${c}`);
  const [h, s, l] = [+m[1]!, +m[2]! / 100, +m[3]! / 100];
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
function lum(c: string): number {
  const [r, g, b] = rgb(c).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Custom properties declared on `:root` in the light block (outside any
 *  prefers-color-scheme media query) or the dark block, dark over light. */
function tokens(css: string, scheme: "light" | "dark"): Map<string, string> {
  const out = new Map<string, string>();
  const dark = css.indexOf("@media (prefers-color-scheme: dark)");
  const darkEnd = css.indexOf("}}", dark) === -1
    ? css.indexOf("}\n}", dark)
    : Math.min(
      ...[css.indexOf("}}", dark), css.indexOf("}\n}", dark)].filter((i) =>
        i !== -1
      ),
    );
  const scopes = [css.slice(0, dark)];
  if (scheme === "dark") scopes.push(css.slice(dark, darkEnd));
  for (const s of scopes) {
    for (const m of s.matchAll(/(--aio-[\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
      out.set(m[1]!, m[2]!.trim());
    }
  }
  return out;
}

/** Resolve `var(--x, fallback)` chains against `vars`. */
function resolve(v: string, vars: Map<string, string>, depth = 0): string {
  assert(depth < 10, `var() chain too deep: ${v}`);
  const m = /^var\((--[\w-]+)\s*(?:,\s*(.*))?\)$/.exec(v.trim());
  if (!m) return v.trim();
  const own = vars.get(m[1]!);
  if (own !== undefined) return resolve(own, vars, depth + 1);
  assert(m[2] !== undefined, `${m[1]} is unset and has no fallback`);
  return resolve(m[2]!, vars, depth + 1);
}

/** The `background` and `color` of the first rule whose selector contains
 *  `sel`. */
function fillAndInk(css: string, sel: string): { bg: string; fg: string } {
  const at = css.indexOf(sel);
  assert(at !== -1, `no rule for ${sel}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const decl = (p: string) => {
    const m = new RegExp(`(?:^|[;\\s])${p}\\s*:\\s*([^;]+)`).exec(body);
    assert(m, `${sel} declares no ${p}`);
    return m[1]!.trim();
  };
  return { bg: decl("background"), fg: decl("color") };
}

/** The ink ON a danger fill, solved from the fill in CSS relative-colour
 *  syntax — the formula both stylesheets must carry, VERBATIM. Checked in real
 *  Chromium: `color(from #d32f2f srgb-linear <INK> <INK> <INK>)` computes
 *  `color(srgb-linear 1 1 1)`, `#ff6b78` computes `0 0 0`. */
const INK = "calc(clamp(0, (1791 - (2126 * r + 7152 * g + 722 * b)) * 10, 1))";
const SUPPORTS =
  "@supports (color: color(from red srgb-linear calc(r * 0.5) g b))";

/** What the formula computes for `fill`: white below the WCAG white/black
 *  crossover (relative luminance 0.1791), black above it. */
const solvedInk = (fill: string) => lum(fill) < 0.1791 ? "#fff" : "#000";

/** Tokens outside the @supports block — what an engine WITHOUT relative
 *  colour reads. */
const legacy = (css: string) => {
  const at = css.indexOf(SUPPORTS);
  if (at === -1) return css;
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      return css.slice(0, at) + css.slice(i + 1);
    }
  }
  throw new Error("unclosed @supports block");
};

Deno.test("danger fill: both stylesheets solve the ink from the fill, in a guarded block", () => {
  for (
    const [name, css, sel, token, from] of [
      [
        "theme",
        appThemeCss("danger-probe"),
        ":where(button.danger)",
        "--aio-on-danger",
        "--aio-danger",
      ],
      [
        "kit",
        UI_CSS,
        ".aio-btn--danger",
        "--aio-ui-on-danger",
        "--aio-ui-danger",
      ],
    ] as const
  ) {
    const at = css.indexOf(SUPPORTS);
    assert(at !== -1, `${name}: no ${SUPPORTS} block`);
    const block = css.slice(at, css.length - legacy(css).length + at);
    const solved = `color(from var(${from}) srgb-linear ${INK} ${INK} ${INK})`;
    const decl = new RegExp(`${token}:\\s*([^;]+);`).exec(block);
    assert(decl, `${name}: the block sets no ${token}`);
    // The kit defers to a theme's own --aio-on-danger first.
    const value = decl[1]!.trim();
    const own = /^var\(--aio-on-danger,\s*(.*)\)$/.exec(value);
    assertEquals(
      own ? own[1] : value,
      solved,
      `${name}: ${token} is not solved from ${from}`,
    );
    // …and the button paints its label with that token, not a fixed colour.
    assertEquals(fillAndInk(css, sel).fg, `var(${token})`, `${name} button`);
  }
});

Deno.test("danger fill: its label reads at AA on the default fills, and on ANY fill an app sets", () => {
  const checked: string[] = [];
  for (let hue = 0; hue < 360; hue += 30) {
    const theme = appThemeCss(`danger-probe-${hue}`);
    for (const scheme of ["light", "dark"] as const) {
      const fill = resolve("var(--aio-danger)", tokens(theme, scheme));
      const kit = resolve("var(--aio-ui-danger)", tokens(UI_CSS, scheme));
      for (const [name, f] of [["theme", fill], ["kit", kit]] as const) {
        const r = ratio(f, solvedInk(f));
        checked.push(name);
        assert(r >= 4.5, `${name} ${scheme} hue ${hue}: ${r.toFixed(2)}:1`);
      }
    }
  }
  assertEquals(checked.length, 12 * 2 * 2);
  // An app's own --aio-danger — the case a fixed dark ink broke (white on
  // #d32f2f was 5.0:1 on 1.0.11 and became 3.65:1). The better of white and
  // black is never under 4.58:1, so every fill passes.
  let fills = 0;
  for (let h = 0; h < 360; h += 15) {
    for (let l = 10; l <= 90; l += 4) {
      const f = `hsl(${h} 80% ${l}%)`;
      fills++;
      assert(ratio(f, solvedInk(f)) >= 4.5, `custom fill ${f}`);
    }
  }
  assert(ratio("#d32f2f", solvedInk("#d32f2f")) >= 4.5);
  assertEquals(fills, 24 * 21);
});

Deno.test("danger fill: an engine without relative colour keeps the white label 1.0.11 had", () => {
  for (const scheme of ["light", "dark"] as const) {
    const theme = legacy(appThemeCss("danger-probe"));
    const { fg } = fillAndInk(theme, ":where(button.danger)");
    assertEquals(resolve(fg, tokens(theme, scheme)), "#fff", `theme ${scheme}`);
    const kit = legacy(UI_CSS);
    const k = fillAndInk(kit, ".aio-btn--danger");
    assertEquals(
      resolve(k.fg, tokens(kit, scheme)),
      "#ffffff",
      `kit ${scheme}`,
    );
  }
});
