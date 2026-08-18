// app-icon.ts — the icon every aio app has, whether or not anyone drew one.
//
// An app without an `icon.png` used to get a flat blue square with a
// sans-serif letter in it, generated only at package time. Run three such apps
// and the taskbar shows three identical blue squares: the icon carried no
// information, so it could not be used to navigate. That is the whole problem
// this module solves — a DEFAULT icon is not decoration, it is the app's name
// rendered where a name does not fit.
//
// Two properties make it work, and both are why the glyphs are drawn here
// rather than set in a font:
//
//   1. **Deterministic.** Colour comes from a hash of the app name, so one app
//      is one colour forever, on every machine, in every target. Two apps
//      collide only if their names hash together.
//   2. **Identical everywhere.** `<text font-family="sans-serif">` renders as
//      a different shape on every OS, and cannot be rasterized at all without
//      a font stack — so the SVG favicon and the PNG window icon would drift
//      apart by construction. A stroked geometric alphabet defined in code has
//      no such dependency: ONE glyph model emits the SVG and rasterizes the
//      PNG, so the browser tab and the taskbar show the same mark.
//
// Pure and I/O-free (the writers live in build-helpers.ts), so the geometry is
// unit-testable and the module is safe to import from the server, which serves
// the favicon.

/** Pen width of the monogram, in the 0–100 cap-height glyph space. */
const STROKE = 11;
/** Fraction of the icon's edge the cap height occupies. */
const CAP_RATIO = 0.46;
/** Corner radius as a fraction of the icon's edge. */
const RADIUS_RATIO = 0.22;

// ── the alphabet ───────────────────────────────────────────────────
//
// A compact command language, parsed once into polylines and shared by the SVG
// emitter and the rasterizer — the two CANNOT disagree, because there is only
// one geometry.
//
//   M x y                    move (start a subpath)
//   L x y                    line to
//   B c1x c1y c2x c2y x y    cubic bezier to
//   C cx cy rx ry a0 a1      elliptical arc, degrees, own subpath
//
// Space: x grows right from 0, y grows DOWN from 0 (cap top) to 100 (baseline).
// Widths differ per glyph; every glyph is centred by its own bounding box at
// render time, so the table never has to agree on one width.
const GLYPHS: Record<string, string> = {
  A: "M 0 100 L 38 0 L 76 100 | M 11 70 L 65 70",
  B: "M 0 0 L 0 100 | C 0 25 46 25 -90 90 | C 0 75 52 25 -90 90",
  C: "C 40 50 40 50 40 320",
  D: "M 0 0 L 0 100 | C 0 50 66 50 -90 90",
  E: "M 62 0 L 0 0 L 0 100 L 62 100 | M 0 50 L 50 50",
  F: "M 62 0 L 0 0 L 0 100 | M 0 50 L 50 50",
  G: "C 40 50 40 50 30 320 | M 74.6 75 L 74.6 50 L 48 50",
  H: "M 0 0 L 0 100 | M 64 0 L 64 100 | M 0 50 L 64 50",
  I: "M 0 0 L 0 100",
  J: "M 60 0 L 60 72 | C 30 72 30 28 0 180",
  K: "M 0 0 L 0 100 | M 60 0 L 4 52 | M 22 36 L 62 100",
  L: "M 0 0 L 0 100 L 56 100",
  M: "M 0 100 L 0 0 L 38 55 L 76 0 L 76 100",
  N: "M 0 100 L 0 0 L 66 100 L 66 0",
  O: "C 40 50 40 50 0 360",
  P: "M 0 0 L 0 100 | C 0 28 48 28 -90 90",
  Q: "C 40 50 40 50 0 360 | M 50 68 L 82 104",
  R: "M 0 0 L 0 100 | C 0 28 48 28 -90 90 | M 22 56 L 66 100",
  S: "M 62 16 B 58 -2 4 -2 4 28 B 4 50 62 48 62 72 B 62 100 8 102 2 84",
  T: "M 0 0 L 64 0 | M 32 0 L 32 100",
  U: "M 0 0 L 0 62 | C 32 62 32 38 0 180 | M 64 62 L 64 0",
  V: "M 0 0 L 34 100 L 68 0",
  W: "M 0 0 L 22 100 L 46 26 L 70 100 L 92 0",
  X: "M 0 0 L 64 100 | M 64 0 L 0 100",
  Y: "M 0 0 L 32 52 L 64 0 | M 32 52 L 32 100",
  Z: "M 0 0 L 64 0 L 0 100 L 64 100",
  "0": "C 32 50 32 50 0 360",
  "1": "M 0 22 L 24 0 L 24 100",
  "2": "M 2 24 B 2 -4 60 -6 60 26 B 60 52 24 68 0 100 L 62 100",
  "3": "M 4 18 B 8 -4 58 -6 58 24 B 58 44 38 52 24 52 " +
    "B 44 52 62 60 62 78 B 62 106 8 106 2 84",
  "4": "M 46 100 L 46 0 L 0 70 L 62 70",
  "5": "M 58 0 L 10 0 L 4 44 B 30 32 62 44 62 70 B 62 96 26 108 2 90",
  "6": "M 56 4 B 20 6 6 34 6 66 B 6 88 22 100 34 100 " +
    "B 52 100 62 86 62 70 B 62 54 48 44 34 44 B 18 44 6 56 6 66",
  "7": "M 0 0 L 62 0 L 22 100",
  "8": "C 30 26 26 26 0 360 | C 30 74 32 26 0 360",
  "9": "M 8 96 B 44 94 58 66 58 34 B 58 12 42 0 30 0 " +
    "B 12 0 2 14 2 30 B 2 46 16 56 30 56 B 46 56 58 44 58 34",
};

/** Drawn when the name's first character has no glyph — a CJK, Cyrillic or
 *  emoji app name still gets its own COLOUR, which is most of the value. A
 *  diamond rather than a ring: a ring is the letter O, and an icon that reads
 *  as the wrong letter is worse than one that reads as no letter. */
const FALLBACK = "M 34 10 L 64 50 L 34 90 L 4 50 L 34 10";

type Pt = readonly [number, number];

/** Parse one glyph's command string into polylines. */
function polylines(src: string): Pt[][] {
  const out: Pt[][] = [];
  for (const sub of src.split("|")) {
    const t = sub.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    let cur: Pt[] = [];
    const num = () => Number(t[i++]);
    while (i < t.length) {
      const cmd = t[i++];
      if (cmd === "M") {
        if (cur.length > 1) out.push(cur);
        cur = [[num(), num()]];
      } else if (cmd === "L") {
        cur.push([num(), num()]);
      } else if (cmd === "B") {
        const [x0, y0] = cur[cur.length - 1] ?? [0, 0];
        const c1x = num(), c1y = num(), c2x = num(), c2y = num();
        const x = num(), y = num();
        for (let k = 1; k <= 16; k++) {
          const u = k / 16, v = 1 - u;
          cur.push([
            v * v * v * x0 + 3 * v * v * u * c1x + 3 * v * u * u * c2x +
            u * u * u * x,
            v * v * v * y0 + 3 * v * v * u * c1y + 3 * v * u * u * c2y +
            u * u * u * y,
          ]);
        }
      } else if (cmd === "C") {
        if (cur.length > 1) out.push(cur);
        const cx = num(), cy = num(), rx = num(), ry = num();
        const a0 = num(), a1 = num();
        cur = [];
        const steps = Math.max(8, Math.round(Math.abs(a1 - a0) / 6));
        for (let k = 0; k <= steps; k++) {
          const a = (a0 + (a1 - a0) * (k / steps)) * Math.PI / 180;
          cur.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
        }
      }
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

/** The character a name is drawn with: its first glyph-able character, so
 *  "  my-app" and "3d-viewer" both land somewhere sensible. */
export function monogramChar(name: string): string {
  for (const ch of (name || "").trim()) {
    const up = ch.toUpperCase();
    if (up in GLYPHS) return up;
  }
  return name.trim()[0]?.toUpperCase() ?? "?";
}

/** FNV-1a over the name — a stable hue per app, on every machine and target.
 *  Exported as {@linkcode appHue} so the default THEME can tint an app in the
 *  same colour as its icon: one name, one identity, everywhere. */
export function appHue(name: string): number {
  return hueOf(name);
}

function hueOf(name: string): number {
  let h = 0x811c9dc5;
  // `|| "app"` — a build path that never resolved a title/binaryName must get
  // A default icon, not a TypeError that fails the whole bundle. (The e2e
  // bundle-smoke harness builds with a hand-rolled BuildConfig and hit exactly
  // that: an icon crashing a build is strictly worse than no icon.)
  const s = (name || "app").trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

/** Foreground lightness that clears WCAG AA against this hue's pastel body.
 *
 *  HSL lightness is not perceptual luminance: `hsl(h 70% 26%)` is a comfortable
 *  dark on a blue, and barely separates from the background on a yellow-green,
 *  where the same L is far brighter. Darkening until the measured contrast
 *  ratio clears 4.5 keeps every letter equally readable instead of every letter
 *  equally SPECIFIED. */
function fgLightness(hue: number): number {
  const lum = ([r, g, b]: [number, number, number]) => {
    const c = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  // Measured against the DARKER end of the gradient — the harder half.
  const bg = lum(hsl((hue + 24) % 360, 0.62, 0.68)) + 0.05;
  // 4.6, not 4.5: the ladder measures 8-bit rounded channels, so a value that
  // lands exactly on the AA threshold here can compute as 4.49 from the
  // unrounded colour a test (or a contrast checker) reads out of the SVG.
  for (let l = 30; l >= 8; l--) {
    if (bg / (lum(hsl(hue, 0.70, l / 100)) + 0.05) >= 4.6) return l;
  }
  return 8;
}

/** The colours of an app's default icon. Pastel body, deep monogram — legible
 *  on a light desktop and a dark one, which a single flat fill is not. */
export function iconColors(name: string): {
  hue: number;
  bg0: string;
  bg1: string;
  fg: string;
} {
  const hue = hueOf(name);
  return {
    hue,
    bg0: `hsl(${hue} 68% 82%)`,
    bg1: `hsl(${(hue + 24) % 360} 62% 68%)`,
    fg: `hsl(${hue} 70% ${fgLightness(hue)}%)`,
  };
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

/** Glyph polylines placed in a `size`×`size` icon: cap-height scaled, centred
 *  on the glyph's own bounding box. ONE placement for SVG and PNG alike. */
function placed(name: string, size: number): { pts: Pt[][]; width: number } {
  const raw = polylines(GLYPHS[monogramChar(name)] ?? FALLBACK);
  const scale = (size * CAP_RATIO) / 100;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const line of raw) {
    for (const [x, y] of line) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const dx = size / 2 - ((minX + maxX) / 2) * scale;
  const dy = size / 2 - ((minY + maxY) / 2) * scale;
  return {
    pts: raw.map((line) =>
      line.map(([x, y]) => [x * scale + dx, y * scale + dy] as Pt)
    ),
    width: STROKE * scale,
  };
}

/** The app's default icon as an SVG document.
 *
 *  Self-contained and font-free: it renders identically in a browser tab, a
 *  `.desktop` entry and a README. */
export function appIconSvg(name: string, size = 512): string {
  const { bg0, bg1, fg } = iconColors(name);
  const { pts, width } = placed(name, size);
  const d = pts
    .map((line) =>
      line
        .map(([x, y], i) =>
          `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`
        )
        .join(" ")
    )
    .join(" ");
  const r = (size * RADIUS_RATIO).toFixed(2);
  const id = `g${hueOf(name)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${bg0}"/><stop offset="1" stop-color="${bg1}"/>
  </linearGradient></defs>
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#${id})"/>
  <path d="${d}" fill="none" stroke="${fg}" stroke-width="${
    width.toFixed(2)
  }" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

// ── rasterizer ─────────────────────────────────────────────────────

/** Squared distance from a point to a segment. */
function segDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len));
  const dx = wx - t * vx, dy = wy - t * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Signed distance to a rounded box centred in a `size` square. */
function roundedBoxDist(px: number, py: number, size: number, r: number) {
  const qx = Math.abs(px - size / 2) - (size / 2 - r);
  const qy = Math.abs(py - size / 2) - (size / 2 - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Coverage from a signed distance — 1 inside, 0 outside, antialiased across
 *  one pixel. Distance fields are why this rasterizer is ~30 lines instead of
 *  a scanline/active-edge engine, and why the edges are smooth at any size. */
const cover = (d: number) => Math.max(0, Math.min(1, 0.5 - d));

/** Render the default icon as RGBA pixels. Exported for the PNG writer and for
 *  tests, which assert on coverage rather than on file bytes. */
export function appIconPixels(name: string, size: number): Uint8Array {
  const { bg0, bg1, fg } = iconColors(name);
  const hue = hueOf(name);
  const c0 = hsl(hue, 0.68, 0.82);
  const c1 = hsl((hue + 24) % 360, 0.62, 0.68);
  const cf = hsl(hue, 0.70, fgLightness(hue) / 100);
  void bg0, void bg1, void fg;
  const { pts, width } = placed(name, size);
  const half = width / 2;
  const px = new Uint8Array(size * size * 4);
  const r = size * RADIUS_RATIO;
  // Only the glyph's neighbourhood needs the distance loop; everything else is
  // background. On a 512px icon that is ~4x fewer segment tests.
  let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
  for (const line of pts) {
    for (const [x, y] of line) {
      if (x < gx0) gx0 = x;
      if (x > gx1) gx1 = x;
      if (y < gy0) gy0 = y;
      if (y > gy1) gy1 = y;
    }
  }
  gx0 -= half + 2, gx1 += half + 2, gy0 -= half + 2, gy1 += half + 2;
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const br = c0[0] + (c1[0] - c0[0]) * t;
    const bg = c0[1] + (c1[1] - c0[1]) * t;
    const bb = c0[2] + (c1[2] - c0[2]) * t;
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      const boxA = cover(roundedBoxDist(cx, cy, size, r));
      let glyphA = 0;
      if (boxA > 0 && cx >= gx0 && cx <= gx1 && cy >= gy0 && cy <= gy1) {
        let best = Infinity;
        for (const line of pts) {
          for (let i = 1; i < line.length; i++) {
            const a = line[i - 1]!, b = line[i]!;
            const d = segDist(cx, cy, a[0], a[1], b[0], b[1]);
            if (d < best) best = d;
          }
        }
        glyphA = cover(best - half);
      }
      const o = (y * size + x) * 4;
      px[o] = Math.round(br + (cf[0] - br) * glyphA);
      px[o + 1] = Math.round(bg + (cf[1] - bg) * glyphA);
      px[o + 2] = Math.round(bb + (cf[2] - bb) * glyphA);
      px[o + 3] = Math.round(boxA * 255);
    }
  }
  return px;
}

// ── PNG container ──────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The app's default icon as a PNG.
 *
 *  Written here rather than shelled out to a converter because the icon must
 *  exist on every build host, including one with no ImageMagick, no `rsvg`,
 *  and no network. `CompressionStream("deflate")` emits a zlib stream, which
 *  is exactly what an IDAT chunk carries. */
export async function appIconPng(
  name: string,
  size = 512,
): Promise<Uint8Array> {
  const px = appIconPixels(name, size);
  const stride = size * 4;
  const raw = new Uint8Array(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const zlib = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The default icon as base64 PNG — for the places that take an icon as bytes
 *  rather than a path (Electron's `nativeImage.createFromDataURL`, a `data:`
 *  URL in generated HTML). Chunked, because spreading a 40 KB byte array into
 *  `String.fromCharCode` is an argument-count crash waiting for a bigger
 *  icon. */
export async function appIconPngBase64(
  name: string,
  size = 256,
): Promise<string> {
  const png = await appIconPng(name, size);
  let s = "";
  for (let i = 0; i < png.length; i += 0x8000) {
    s += String.fromCharCode(...png.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
