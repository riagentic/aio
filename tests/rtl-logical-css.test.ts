// Every stylesheet aio ships is written in LOGICAL properties, so `ui.dir`
// mirrors the whole default UI with one attribute.
//
// This is a ratchet, not a style preference. `margin-left` and `padding-left`
// are correct in English and wrong in Arabic, Hebrew, Farsi and Urdu, and the
// failure is silent: the page renders, the text flows right-to-left, and the
// chrome around it stays stubbornly left-handed. Nobody reviewing a diff
// notices `padding-left: 1.4em` — which is exactly why it must be a gate.
//
// Measured before alpha72: the generated theme was already clean (0 physical),
// the component stylesheet was not (6). One `ui.dir="rtl"` now flips both.
//
// The escape hatch is real but narrow: a rule that is about the PHYSICAL
// viewport rather than the reading order (a scrollbar gutter, a hardware
// notch) says so with `aio-ok:` on the line.
import { assertEquals } from "@std/assert";
import { appThemeCss, appThemeTokensCss } from "../src/build/app-theme.ts";
import { UI_CSS } from "../src/ui/styles.ts";

/** Properties whose name encodes a side of the SCREEN rather than a side of
 *  the text. Each has a logical twin that does the same job in both
 *  directions. */
const PHYSICAL = [
  ["margin-left", "margin-inline-start"],
  ["margin-right", "margin-inline-end"],
  ["padding-left", "padding-inline-start"],
  ["padding-right", "padding-inline-end"],
  ["border-left", "border-inline-start"],
  ["border-right", "border-inline-end"],
  ["border-left-color", "border-inline-start-color"],
  ["border-right-color", "border-inline-end-color"],
  ["border-left-width", "border-inline-start-width"],
  ["border-right-width", "border-inline-end-width"],
  ["border-top-left-radius", "border-start-start-radius"],
  ["border-top-right-radius", "border-start-end-radius"],
  ["border-bottom-left-radius", "border-end-start-radius"],
  ["border-bottom-right-radius", "border-end-end-radius"],
  ["left", "inset-inline-start"],
  ["right", "inset-inline-end"],
] as const;

/** `text-align: left|right` is the same mistake in a different spelling. */
const PHYSICAL_VALUES = [
  [/text-align\s*:\s*(left|right)\b/, "text-align: start | end"],
  [/float\s*:\s*(left|right)\b/, "float: inline-start | inline-end"],
  [/clear\s*:\s*(left|right)\b/, "clear: inline-start | inline-end"],
] as const;

/** Offending declarations in one stylesheet, as readable lines. */
function physicalDeclarations(css: string, label: string): string[] {
  const out: string[] = [];
  const lines = css.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // A rule that is genuinely about the screen says so, on the line.
    if (/\baio-ok\b\s*[:\-—]\s*\S/.test(line)) continue;
    // Comments are prose — `padding-left` in an explanation is not a rule.
    const code = line.replace(/\/\*.*?\*\//g, "");
    for (const [bad, good] of PHYSICAL) {
      // A property name: start of a declaration, not a substring of a longer
      // one (`border-left-color` must not also report `border-left`).
      const re = new RegExp(`(^|[{;\\s])${bad}\\s*:`, "");
      if (re.test(code)) {
        // Skip when a longer property on the same line already matched — the
        // longest match is the real declaration.
        const longer = PHYSICAL.some(([other]) =>
          other !== bad && other.startsWith(bad) &&
          new RegExp(`(^|[{;\\s])${other}\\s*:`).test(code)
        );
        if (longer) continue;
        out.push(`${label}:${i + 1}  ${bad} → ${good}\n      ${code.trim()}`);
      }
    }
    for (const [re, good] of PHYSICAL_VALUES) {
      if (re.test(code)) {
        out.push(`${label}:${i + 1}  → ${good}\n      ${code.trim()}`);
      }
    }
  }
  return out;
}

Deno.test("rtl: every stylesheet aio ships is direction-agnostic", () => {
  const sheets: [string, string][] = [
    ["app-theme (full)", appThemeCss("probe")],
    ["app-theme (tokens)", appThemeTokensCss("probe")],
    ["ui/styles (UI_CSS)", UI_CSS],
  ];
  const offenders = sheets.flatMap(([label, css]) =>
    physicalDeclarations(css, label)
  );
  assertEquals(
    offenders,
    [],
    'a physical property in framework CSS silently breaks `ui.dir="rtl"` —\n' +
      "  the page mirrors and the chrome does not:\n\n  " +
      offenders.join("\n  ") +
      "\n\n  Use the logical twin. If the rule really is about the SCREEN " +
      "(a scrollbar\n  gutter, a hardware notch), say so with `aio-ok:` on " +
      "the line.",
  );
});

Deno.test("rtl: the gate actually catches what it claims to", () => {
  // A gate nobody has seen fail is a gate nobody knows works.
  const bad = `.x { padding-left: 1em; }
.y { margin-right: 2px }
.z { text-align: left }
.w { border-left: 1px solid red }
.v { float: right }`;
  const found = physicalDeclarations(bad, "fixture");
  assertEquals(found.length, 5, found.join("\n"));

  // …and does not fire on the logical spellings, on prose, or on an
  // acknowledged physical rule.
  const good = `.x { padding-inline-start: 1em; }
.y { margin-inline-end: 2px }
.z { text-align: start }
/* padding-left is what this replaces */
.w { border-inline-start: 1px solid red }
.gutter { padding-right: 12px } /* aio-ok: the scrollbar is on the screen, not in the text */`;
  assertEquals(physicalDeclarations(good, "fixture"), []);
});

Deno.test("rtl: `border-left-color` is reported once, not twice", () => {
  // The property-name match must not report the shorthand as well as the
  // longhand, or a real offender arrives with a duplicate beside it and the
  // count in the ratchet stops meaning anything.
  const found = physicalDeclarations(".t { border-left-color: red }", "f");
  assertEquals(found.length, 1, found.join("\n"));
});
