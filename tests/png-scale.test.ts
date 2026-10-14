// One icon.png is enough for every platform: a square PNG larger than a
// Windows icon image may be (256 px) is cut down by the build itself. Before,
// a 512 or 1024 px icon.png — the size every other target asks for — put the
// generated monogram on the Windows exe, with one warning line in a long log.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  appIconIco,
  ICO_SIZES,
  icoFromPngs,
  pngFromRgba,
} from "../src/build/app-icon.ts";
import {
  boxDownscale,
  decodePng,
  icoFromLargePng,
} from "../src/build/png-scale.ts";
import { icoImages } from "../src/build/pe-icon.ts";
import { writeWindowsIcon } from "../src/build/build-helpers.ts";
import {
  BUILD_NOTES_ENV,
  readSummaryNotes,
  summaryNote,
} from "../src/build/build-say.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** A deterministic byte source (mulberry32). */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A PNG written by this test, not by the encoder under test: any colour
 *  type, each row stored with the scanline filter `filterOf(y)` names, the
 *  pixel data split over two IDAT chunks. `samples` is the unfiltered rows. */
async function png(o: {
  w: number;
  h: number;
  type: number;
  channels: number;
  samples: Uint8Array;
  filterOf?: (y: number) => number;
  depth?: number;
  interlace?: number;
  extra?: Uint8Array[];
}): Promise<Uint8Array> {
  const stride = o.w * o.channels;
  const raw = new Uint8Array(o.h * (stride + 1));
  const at = (x: number, y: number) =>
    x < 0 || y < 0 ? 0 : o.samples[y * stride + x]!;
  for (let y = 0; y < o.h; y++) {
    const f = o.filterOf?.(y) ?? 0;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = at(x - o.channels, y), b = at(x, y - 1);
      const c = at(x - o.channels, y - 1);
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predicted = [
        0,
        a,
        b,
        (a + b) >> 1,
        pa <= pb && pa <= pc ? a : pb <= pc ? b : c,
      ][f]!;
      raw[y * (stride + 1) + 1 + x] = (at(x, y) - predicted) & 0xff;
    }
  }
  const z = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, o.w);
  v.setUint32(4, o.h);
  ihdr[8] = o.depth ?? 8;
  ihdr[9] = o.type;
  ihdr[12] = o.interlace ?? 0;
  const half = z.length >> 1;
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", new TextEncoder().encode("Comment\0skipped")),
    ...(o.extra ?? []),
    chunk("IDAT", z.subarray(0, half)),
    chunk("IDAT", z.subarray(half)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Four quadrants: red, green, blue, and fully transparent (black RGB). */
function quadrants(n: number): Uint8Array {
  const px = new Uint8Array(n * n * 4);
  const colours = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [
    0,
    0,
    0,
    0,
  ]];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      px.set(
        colours[(x < n / 2 ? 0 : 1) + (y < n / 2 ? 0 : 2)]!,
        (y * n + x) * 4,
      );
    }
  }
  return px;
}

const pixel = (rgba: Uint8Array, size: number, x: number, y: number) => [
  ...rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
];

async function decoded(pngBytes: Uint8Array) {
  const img = await decodePng(pngBytes);
  if (typeof img === "string") throw new Error(`not decoded: ${img}`);
  return img;
}

/** The images of an `.ico`, decoded, by side. */
async function icoPixels(ico: Uint8Array): Promise<Map<number, Uint8Array>> {
  const images = icoImages(ico);
  if (typeof images === "string") throw new Error(images);
  const out = new Map<number, Uint8Array>();
  for (const img of images) {
    const d = await decoded(img.data);
    assertEquals(d.w, img.entry[0] || 256, "directory width = image width");
    out.set(d.w, d.rgba);
  }
  return out;
}

Deno.test("decodePng reads back what the repo's PNG encoder wrote, at every size", async () => {
  const next = rng(1);
  for (const size of [1, 2, 3, 7, 16, 33, 64, 257]) {
    const px = Uint8Array.from({ length: size * size * 4 }, next);
    const img = await decoded(await pngFromRgba(px, size));
    assertEquals([img.w, img.h], [size, size]);
    assert(img.rgba.every((b, i) => b === px[i]), `size ${size}`);
  }
});

Deno.test("decodePng reads every colour type and all five scanline filters", async () => {
  const next = rng(2);
  const w = 13, h = 11;
  const palette = Uint8Array.from({ length: 256 * 3 }, next);
  const trns = Uint8Array.from({ length: 100 }, next); // shorter: rest opaque
  const kinds: {
    type: number;
    channels: number;
    extra?: Uint8Array[];
    rgba: (s: Uint8Array) => number[];
  }[] = [
    { type: 0, channels: 1, rgba: (s) => [s[0]!, s[0]!, s[0]!, 255] },
    { type: 2, channels: 3, rgba: (s) => [s[0]!, s[1]!, s[2]!, 255] },
    { type: 4, channels: 2, rgba: (s) => [s[0]!, s[0]!, s[0]!, s[1]!] },
    { type: 6, channels: 4, rgba: (s) => [...s] },
    {
      type: 3,
      channels: 1,
      extra: [chunk("PLTE", palette)],
      rgba: (s) => [...palette.subarray(s[0]! * 3, s[0]! * 3 + 3), 255],
    },
    {
      type: 3,
      channels: 1,
      extra: [chunk("PLTE", palette), chunk("tRNS", trns)],
      rgba: (s) => [
        ...palette.subarray(s[0]! * 3, s[0]! * 3 + 3),
        trns[s[0]!] ?? 255,
      ],
    },
  ];
  assertEquals(kinds.length, 6);
  for (const k of kinds) {
    for (
      const filterOf of [
        ...[0, 1, 2, 3, 4].map((f) => () => f),
        (y: number) => y % 5,
      ]
    ) {
      const samples = Uint8Array.from({ length: w * h * k.channels }, next);
      const img = await decoded(await png({ w, h, ...k, samples, filterOf }));
      const want: number[] = [];
      for (let i = 0; i < w * h; i++) {
        want.push(
          ...k.rgba(samples.subarray(i * k.channels, (i + 1) * k.channels)),
        );
      }
      assertEquals(
        [...img.rgba],
        want,
        `colour type ${k.type}, filter ${filterOf(3)}`,
      );
    }
  }
});

Deno.test("decodePng says why for a PNG it does not read, and never throws", async () => {
  const base = { w: 4, h: 4, type: 6, channels: 4 };
  const samples = Uint8Array.from({ length: 4 * 4 * 8 }, rng(3));
  const good = await png({ ...base, samples });
  const cases: [string, Uint8Array, string][] = [
    [
      "16-bit",
      await png({ ...base, channels: 8, depth: 16, samples }),
      "16-bit",
    ],
    ["interlaced", await png({ ...base, interlace: 1, samples }), "interlaced"],
    ["not a PNG", new TextEncoder().encode("GIF89a, really"), "not a PNG"],
    [
      "colour key",
      await png({
        w: 4,
        h: 4,
        type: 2,
        channels: 3,
        samples,
        extra: [chunk("tRNS", new Uint8Array(6))],
      }),
      "colour key",
    ],
    [
      "no palette",
      await png({ ...base, type: 3, channels: 1, samples }),
      "no palette",
    ],
    ["cut short", good.subarray(0, good.length - 30), "cut short"],
    [
      "wrong length",
      await png({ ...base, h: 5, samples: new Uint8Array(4 * 5 * 4) })
        .then((p) => {
          // IHDR says 4 rows more than the data holds (CRC is not checked).
          new DataView(p.buffer).setUint32(20, 9);
          return p;
        }),
      "wrong length",
    ],
    [
      "bad filter",
      await png({ ...base, samples, filterOf: () => 7 }),
      "scanline filter 7",
    ],
  ];
  for (const [name, bytes, why] of cases) {
    const got = await decodePng(bytes);
    assert(typeof got === "string", `${name}: decoded`);
    assertStringIncludes(got, why, name);
  }
  // Garbage where the zlib stream should be.
  const junk = concat([
    good.subarray(0, 33),
    chunk("IDAT", new Uint8Array(40).fill(0x55)),
    chunk("IEND", new Uint8Array(0)),
  ]);
  assertStringIncludes(await decodePng(junk) as string, "cannot be inflated");
});

Deno.test("a 1024 px and a 512 px icon.png are cut to 256/48/32/16 with the picture's own pixels", async () => {
  for (const n of [1024, 512]) {
    const ico = await icoFromLargePng(await pngFromRgba(quadrants(n), n));
    assert(typeof ico !== "string", `${n}: ${ico}`);
    const images = await icoPixels(ico);
    assertEquals([...images.keys()], [...ICO_SIZES]);
    for (const [size, rgba] of images) {
      const q = size / 4, far = size - q;
      assertEquals(pixel(rgba, size, q, q), [255, 0, 0, 255], `${n}→${size}`);
      assertEquals(pixel(rgba, size, far, q), [0, 255, 0, 255], `${n}→${size}`);
      assertEquals(pixel(rgba, size, q, far), [0, 0, 255, 255], `${n}→${size}`);
      assertEquals(pixel(rgba, size, far, far), [0, 0, 0, 0], `${n}→${size}`);
    }
  }
});

Deno.test("boxDownscale averages the area a pixel covers, a border pixel by its part", () => {
  // 4×4 → 2×2: each output pixel is the mean of one 2×2 block.
  const grey = (values: number[]) =>
    Uint8Array.from(values.flatMap((g) => [g, g, g, 255]));
  const out = boxDownscale(
    grey([0, 100, 10, 30, 100, 200, 50, 70, 1, 1, 255, 255, 1, 1, 255, 255]),
    4,
    4,
    2,
  );
  assertEquals([out[0], out[4], out[8], out[12]], [100, 40, 1, 255]);
  // 3 → 2: the middle source column counts half in each output column.
  const row = boxDownscale(
    grey([0, 90, 240, 0, 90, 240, 0, 90, 240]),
    3,
    3,
    2,
  );
  assertEquals([row[0], row[4]], [30, 190]); // (0+45)/1.5, (45+240)/1.5
});

Deno.test("boxDownscale weights colour by alpha: a transparent neighbour does not darken an edge", () => {
  // One opaque white pixel beside three transparent BLACK ones.
  const px = new Uint8Array(2 * 2 * 4);
  px.set([255, 255, 255, 255], 0);
  const out = boxDownscale(px, 2, 2, 1);
  // White at a quarter coverage — an unweighted mean gives grey 64.
  assertEquals([...out], [255, 255, 255, 64]);
  // Nothing opaque at all: transparent, no NaN.
  assertEquals([...boxDownscale(new Uint8Array(16), 2, 2, 1)], [0, 0, 0, 0]);
});

/** `writeWindowsIcon` for an app dir holding `files`; what it wrote and said. */
async function windowsIcon(
  files: Record<string, Uint8Array>,
): Promise<{ ico: Uint8Array; warned: string[] }> {
  const root = await tempDir("aio-png-scale-");
  try {
    for (const [name, bytes] of Object.entries(files)) {
      await Deno.writeFile(join(root, name), bytes);
    }
    const warned: string[] = [];
    const out = await writeWindowsIcon(join(root, "out", "app.ico"), {
      root,
      appDir: root,
      name: "Wallet Pro",
      id: "wallet",
      warn: (m) => warned.push(m),
    });
    return { ico: await Deno.readFile(out), warned };
  } finally {
    await dropTempDir(root);
  }
}

const MONOGRAM = await appIconIco("Wallet Pro", "wallet");

Deno.test("a 1024 px icon.png becomes the Windows icon, scaled down — not the monogram, and no warning", async () => {
  const big = await pngFromRgba(quadrants(1024), 1024);
  const { ico, warned } = await windowsIcon({ "icon.png": big });
  assertEquals(warned, []);
  assertEquals([...ico], [...await icoFromLargePng(big) as Uint8Array]);
  assert(
    ico.length !== MONOGRAM.length || ico.some((b, i) => b !== MONOGRAM[i]),
    "the exe got the generated monogram, not the app's icon",
  );
  const at256 = (await icoPixels(ico)).get(256)!;
  assertEquals(pixel(at256, 256, 10, 10), [255, 0, 0, 255]);
});

Deno.test("an icon.png the build cannot scale falls back to the monogram and says which file to add", async () => {
  const samples = new Uint8Array(300 * 300 * 8).fill(200);
  const deep = await png({
    w: 300,
    h: 300,
    type: 6,
    channels: 8,
    depth: 16,
    samples,
  });
  const wide = await png({
    w: 600,
    h: 300,
    type: 0,
    channels: 1,
    samples: new Uint8Array(600 * 300),
  });
  for (
    const [bytes, size, why] of [
      [deep, "300×300", "could not be scaled down: 16-bit"],
      [wide, "600×300", "square, at most 256 px"],
      [new TextEncoder().encode("not an image"), "not a PNG", "square"],
    ] as const
  ) {
    const { ico, warned } = await windowsIcon({ "icon.png": bytes });
    assertEquals([...ico], [...MONOGRAM], size);
    assertEquals(warned.length, 1, size);
    assertStringIncludes(warned[0]!, `icon.png is ${size}`);
    assertStringIncludes(warned[0]!, why);
    assertStringIncludes(warned[0]!, "shows the generated monogram instead");
    assertStringIncludes(warned[0]!, "icon.ico to use your own");
  }
});

Deno.test("an icon.png of at most 256 px and an app's own icon.ico are used byte for byte, as before", async () => {
  const small = await pngFromRgba(quadrants(128), 128);
  const big = await pngFromRgba(quadrants(512), 512);
  const asIs = await windowsIcon({ "icon.png": small });
  assertEquals([...asIs.ico], [...icoFromPngs([small])]);
  assertEquals(asIs.warned, []);
  const own = new TextEncoder().encode("the app's own icon.ico, not read");
  const copied = await windowsIcon({ "icon.png": big, "icon.ico": own });
  assertEquals([...copied.ico], [...own]);
  assertEquals(copied.warned, []);
});

Deno.test("a summary note is warned at once and kept for the fleet's closing summary, each once", async () => {
  const dir = await tempDir("aio-notes-");
  const file = join(dir, "notes");
  const before = Deno.env.get(BUILD_NOTES_ENV);
  const real = console.warn;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    assertEquals(readSummaryNotes(file), []);
    Deno.env.delete(BUILD_NOTES_ENV);
    summaryNote("standalone: only warned");
    assertEquals(readSummaryNotes(file), []);
    Deno.env.set(BUILD_NOTES_ENV, file);
    summaryNote("icon.png is 600×300\nadd icon.ico");
    summaryNote("icon.png is 600×300\nadd icon.ico");
    summaryNote("second");
    assertEquals(readSummaryNotes(file), [
      "icon.png is 600×300 add icon.ico",
      "second",
    ]);
    assertEquals(said.length, 4);
    assertStringIncludes(said[0]!, "standalone: only warned");
  } finally {
    console.warn = real;
    if (before === undefined) Deno.env.delete(BUILD_NOTES_ENV);
    else Deno.env.set(BUILD_NOTES_ENV, before);
    await dropTempDir(dir);
  }
});
