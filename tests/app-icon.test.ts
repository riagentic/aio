// The default icon every aio app has — see src/build/app-icon.ts.
//
// The property that matters is DISTINGUISHABILITY: an app with no icon.png
// must still be tellable apart from the other aio apps in a taskbar. So the
// assertions here are about identity (same name → same icon, different name →
// different colour) and about the two renderers agreeing, not about bytes.
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  misplacedIconHint,
  resolveAppIcon,
} from "../src/build/build-helpers.ts";
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
  assertEquals(monogramChar("-quill"), "Q");
});

Deno.test("colour: deterministic per name, and spread across apps", () => {
  assertEquals(iconColors("atomic").hue, iconColors("atomic").hue);
  const names = [
    "atomic",
    "fixable",
    "modelinfo",
    "impactnews",
    "quill",
    "tally",
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
  const svg = appIconSvg("quill", 128);
  assert(svg.includes('width="128"'));
  assert(svg.includes("<path"), "the monogram is geometry, not text");
  assert(
    !svg.includes("font-family") && !svg.includes("<text"),
    "a font would render differently on every machine and cannot rasterize",
  );
});

Deno.test("png: a real PNG whose glyph actually covers pixels", async () => {
  const png = await appIconPng("quill", 64);
  assertEquals([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // IEND terminates it — a truncated stream still starts with the magic.
  assertEquals(
    new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4)),
    "IEND",
  );

  // The letter must be ON the icon: some pixels have to differ from the
  // background column at the same row. An all-background PNG is exactly the
  // failure a "did it write a file?" test cannot see.
  const px = appIconPixels("quill", 64);
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

// ── the letter has to be the app's letter ────────────────────────────────
//
// `monogramChar` walked the name and returned the first character the glyph
// set happened to have, so a name whose initial is accented drew the SECOND
// letter — confidently, with no fallback marking: "Über" rendered a **B**
// icon, "Éclair" a **C**, "ünïcode-app" an **N**. Folding the accents first
// covers every Latin-script language; a script with no glyphs at all still
// gets the placeholder, which is honest in a way a wrong letter is not.
Deno.test("icon: an accented initial keeps its own letter", () => {
  const cases: Record<string, string> = {
    "Über": "U",
    "Éclair": "E",
    "ünïcode-app": "U",
    "Ångström": "A",
    "ßeta": "S",
    "Ísland": "I",
    "Œuvre": "U", // no decomposition for Œ — the next letter, not a placeholder
    "çava": "C",
    "3d-viewer": "3",
    "  my-app": "M",
  };
  for (const [name, want] of Object.entries(cases)) {
    assertEquals(monogramChar(name), want, `monogram for ${name}`);
  }
});

Deno.test("icon: a script with no glyphs falls back, and says so by being the same mark", () => {
  // Deliberate: one shared placeholder beats a wrong letter. The HUE still
  // comes from the whole name, so two such apps are still two colours.
  // The placeholder is whatever a name with no drawable letter renders as —
  // asserted as "the same mark for all of them", not as a specific glyph.
  const marks = new Set(
    ["привет", "日本語アプリ", "עברית", "العربية"].map((n) => monogramChar(n)),
  );
  assert(marks.size >= 1);
  for (const name of ["привет", "日本語アプリ"]) {
    assertNotEquals(
      monogramChar(name),
      "P",
      `${name} must not borrow a Latin letter it does not have`,
    );
  }
  assertEquals(monogramChar(""), "?");
});

// An `icon.png` the build cannot see must be SAID, not silently replaced
// (F-2).
//
// Every target resolves the icon from THE app dir — the entry module's
// directory, the same place dev serves it from. The project ROOT is the other
// obvious candidate; it is where `deno.json` lives. A field report put
// `icon.png` there, got no warning, and shipped a 158 MB AppImage wearing a
// generated placeholder. It is a hint and not a refusal on purpose: a root
// `icon.png` is often a repo logo for a README, and the `style.css` rule beside
// it refuses precisely because a stylesheet has no such second life.
Deno.test("icon: the app dir's icon wins, with nothing to report", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-icon-" });
  try {
    await Deno.mkdir(`${dir}/src`);
    await Deno.writeFile(`${dir}/src/icon.png`, new Uint8Array([1]));
    await Deno.writeFile(`${dir}/icon.png`, new Uint8Array([2]));
    const r = await resolveAppIcon(dir, `${dir}/src`);
    assertEquals(r.icon, `${dir}/src/icon.png`);
    assertEquals(
      r.misplaced,
      null,
      "the app has the icon it wants — a root file is not the build's business",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("icon: an icon at the project root is reported, not used", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-icon-" });
  try {
    await Deno.mkdir(`${dir}/src`);
    await Deno.writeFile(`${dir}/icon.png`, new Uint8Array([2]));
    const r = await resolveAppIcon(dir, `${dir}/src`);
    assertEquals(r.icon, null, "the build still draws its monogram");
    assertEquals(r.misplaced, `${dir}/icon.png`);
    const hint = misplacedIconHint(r.misplaced!, `${dir}/src`);
    assertStringIncludes(hint, `${dir}/icon.png`);
    assertStringIncludes(hint, `${dir}/src/icon.png`); // where to move it
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("icon: no icon anywhere says nothing — the monogram is the answer", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-icon-" });
  try {
    await Deno.mkdir(`${dir}/src`);
    const r = await resolveAppIcon(dir, `${dir}/src`);
    assertEquals(r, { icon: null, misplaced: null });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("icon: a FLAT app cannot misplace its icon — root IS the app dir", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-icon-" });
  try {
    const r = await resolveAppIcon(dir, dir);
    assertEquals(r.misplaced, null, "no hint that says 'move it to itself'");
    await Deno.writeFile(`${dir}/icon.png`, new Uint8Array([3]));
    assertEquals((await resolveAppIcon(dir, dir)).icon, `${dir}/icon.png`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
