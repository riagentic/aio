// The default icon every aio app has — see src/build/app-icon.ts.
//
// The property that matters is DISTINGUISHABILITY: an app with no icon.png
// must still be tellable apart from the other aio apps in a taskbar. So the
// assertions here are about identity (same name → same icon, different name →
// different colour) and about the two renderers agreeing, not about bytes.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  appIconPixels,
  appIconPng,
  appIconPngBase64,
  appIconSvg,
  iconColors,
  monogramChar,
} from "../src/build/app-icon.ts";

Deno.test("monogram: the first character that HAS a glyph", () => {
  assertEquals(monogramChar("zebra"), "Z");
  assertEquals(monogramChar("  my-app"), "M");
  assertEquals(monogramChar("7days"), "7");
  // A leading separator is not a letter — skip to one that is.
  assertEquals(monogramChar("-quant"), "Q");
});

Deno.test("colour: deterministic per name, and spread across apps", () => {
  assertEquals(iconColors("atomic").hue, iconColors("atomic").hue);
  const names = [
    "atomic",
    "fixable",
    "modelinfo",
    "impactnews",
    "quant",
    "t2v",
  ];
  const hues = new Set(names.map((n) => iconColors(n).hue));
  // The whole point is that N running apps look like N different icons.
  assertEquals(hues.size, names.length, "every app got its own hue");
});

Deno.test("colour: the monogram clears WCAG AA on every hue", () => {
  const lum = (c: string) => {
    const m = c.match(/hsl\((\d+) ([\d.]+)% ([\d.]+)%\)/)!;
    const [h, s, l] = [+m[1]!, +m[2]! / 100, +m[3]! / 100];
    const a = s * Math.min(l, 1 - l);
    const ch = (n: number) => {
      const k = (n + h / 30) % 12;
      const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(0) + 0.7152 * ch(8) + 0.0722 * ch(4);
  };
  for (let hue = 0; hue < 360; hue += 7) {
    const c = iconColors(`hue${hue}`);
    const ratio = (lum(c.bg1) + 0.05) / (lum(c.fg) + 0.05);
    assert(
      ratio >= 4.5,
      `hue ${c.hue}: contrast ${ratio.toFixed(2)} is below AA`,
    );
  }
});

Deno.test("svg: self-contained, font-free, correctly sized", () => {
  const svg = appIconSvg("quant", 128);
  assert(svg.includes('width="128"'));
  assert(svg.includes("<path"), "the monogram is geometry, not text");
  assert(
    !svg.includes("font-family") && !svg.includes("<text"),
    "a font would render differently on every machine and cannot rasterize",
  );
});

Deno.test("png: a real PNG whose glyph actually covers pixels", async () => {
  const png = await appIconPng("quant", 64);
  assertEquals([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // IEND terminates it — a truncated stream still starts with the magic.
  assertEquals(
    new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4)),
    "IEND",
  );

  // The letter must be ON the icon: some pixels have to differ from the
  // background column at the same row. An all-background PNG is exactly the
  // failure a "did it write a file?" test cannot see.
  const px = appIconPixels("quant", 64);
  const mid = 32;
  let ink = 0;
  for (let x = 0; x < 64; x++) {
    const o = (mid * 64 + x) * 4;
    const edge = (mid * 64 + 1) * 4;
    if (Math.abs(px[o]! - px[edge]!) > 24) ink++;
  }
  assert(ink > 0, "the monogram left no ink on the icon's middle row");
});

Deno.test("png: differs between apps, identical for one app", async () => {
  const a = await appIconPngBase64("atomic", 32);
  const b = await appIconPngBase64("fixable", 32);
  assertNotEquals(a, b);
  assertEquals(a, await appIconPngBase64("atomic", 32));
});

Deno.test("glyphs: every A–Z and 0–9 renders ink, and so does a fallback", () => {
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
    const px = appIconPixels(ch + "x", 48);
    // Compare the centre band against the corner, which is always background.
    let ink = 0;
    for (let y = 12; y < 36; y++) {
      for (let x = 12; x < 36; x++) {
        const o = (y * 48 + x) * 4;
        if (Math.abs(px[o]! - px[(2 * 48 + 24) * 4]!) > 24) ink++;
      }
    }
    assert(ink > 20, `glyph ${ch} rendered almost nothing (${ink} px)`);
  }
  // A name whose first character has no glyph still gets a mark and a colour.
  const svg = appIconSvg("日本語");
  assert(svg.includes("<path"), "an unglyphable name still gets a mark");
});
