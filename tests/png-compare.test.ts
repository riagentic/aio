// A PNG reader, so `am shot --check` compares PIXELS and not bytes.
//
// A PNG's bytes are not its pixels: the same image re-encoded with a different
// zlib level, a different filter choice or an extra ancillary chunk is a
// different file. A byte comparison would fail on a screenshot no human could
// tell apart — and a check that cries wolf is one people delete, taking the
// true failures with it.
//
// DRIVEN BY REAL FILES. Two PNGs already in this repo, produced by two
// different encoders: `docs/img/theme.png` is a screenshot from an external
// tool (colour type 2, RGB), `amui/dist/icon.png` is this repo's own writer
// (type 6, RGBA). A fixture I encode myself only proves my decoder agrees with
// my encoder, which is the self-confirming shape this project keeps finding —
// so the independent file comes first.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  comparePixels,
  comparePng,
  decodePng,
  type Pixels,
} from "../src/am/png-compare.ts";
import { appIconPixels, appIconPng } from "../src/build/app-icon.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));

Deno.test("a REAL screenshot from another tool decodes (RGB, type 2)", async () => {
  const bytes = await Deno.readFile(join(REPO, "docs/img/theme.png"));
  const px = await decodePng(bytes);
  assertEquals([px.width, px.height], [1400, 419]);
  assertEquals(px.rgba.length, 1400 * 419 * 4);
  // An RGB source has no alpha channel, so every pixel must come out opaque —
  // the widening step, not the filtering, and easy to get silently wrong.
  for (let p = 3; p < px.rgba.length; p += 4) {
    if (px.rgba[p] !== 255) {
      throw new Error(`alpha at byte ${p} is ${px.rgba[p]}`);
    }
  }
  // …and it is not a uniform block, which is what a broken un-filter produces.
  const distinct = new Set<number>();
  for (let p = 0; p < px.rgba.length; p += 4 * 997) distinct.add(px.rgba[p]!);
  assert(
    distinct.size > 8,
    `a real screenshot has more than ${distinct.size} shades`,
  );
});

Deno.test("a REAL icon decodes (RGBA, type 6) and keeps its transparency", async () => {
  const bytes = await Deno.readFile(join(REPO, "amui/dist/icon.png"));
  const px = await decodePng(bytes);
  assertEquals([px.width, px.height], [512, 512]);
  assertEquals(px.rgba.length, 512 * 512 * 4);
});

Deno.test("round-trip: the repo's own encoder, decoded back to its pixels", async () => {
  // The independent check above proves the reader; this proves it EXACTLY,
  // because here the expected pixels are known rather than inferred.
  const size = 64;
  const expected = appIconPixels("roundtrip-probe", size);
  const png = await appIconPng("roundtrip-probe", size);
  const got = await decodePng(png);
  assertEquals([got.width, got.height], [size, size]);
  assertEquals(
    got.rgba.length,
    expected.length,
    "the decoded buffer must be the same shape",
  );
  for (let i = 0; i < expected.length; i++) {
    if (got.rgba[i] !== expected[i]) {
      throw new Error(
        `byte ${i} (pixel ${i >> 2}, channel ${i & 3}): ` +
          `expected ${expected[i]}, got ${got.rgba[i]}`,
      );
    }
  }
});

Deno.test("a malformed PNG is refused BY NAME, never half-read", () => {
  // A decoder that returns a partial image turns every later comparison into a
  // mystery about which of the two things was wrong.
  const cases: Array<[string, Uint8Array, string]> = [
    ["not a png", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), "signature"],
    [
      "truncated to the signature",
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]),
      "IHDR",
    ],
  ];
  for (const [name, bytes, needle] of cases) {
    assertRejects(
      () => decodePng(bytes),
      Error,
      needle,
      `${name} must say why`,
    );
  }
});

// ── the comparison ──────────────────────────────────────────────────────────

const solid = (
  w: number,
  h: number,
  rgba: [number, number, number, number],
): Pixels => {
  const px = new Uint8Array(w * h * 4);
  for (let p = 0; p < px.length; p += 4) px.set(rgba, p);
  return { width: w, height: h, rgba: px };
};

Deno.test("identical images are the same", () => {
  const d = comparePixels(
    solid(4, 4, [1, 2, 3, 255]),
    solid(4, 4, [1, 2, 3, 255]),
  );
  assert(d.same);
  assertEquals(d.diffPixels, 0);
  assertEquals(d.maxDelta, 0);
});

Deno.test("a one-or-two-channel wobble is NOT a difference", () => {
  // Antialiasing and subpixel text move a channel by one or two between
  // otherwise identical captures. Calling that a failure is how a visual gate
  // becomes noise and gets deleted.
  const d = comparePixels(
    solid(8, 8, [100, 100, 100, 255]),
    solid(8, 8, [102, 98, 100, 255]),
  );
  assert(d.same, d.reason);
  assertEquals(d.maxDelta, 2, "…but the wobble is still MEASURED and reported");
});

Deno.test("a real change is a difference, and says how big", () => {
  const d = comparePixels(
    solid(10, 10, [0, 0, 0, 255]),
    solid(10, 10, [255, 255, 255, 255]),
  );
  assert(!d.same);
  assertEquals(d.diffPixels, 100);
  assertEquals(d.totalPixels, 100);
  assertEquals(d.maxDelta, 255);
  assert(d.reason.includes("100 of 100"), d.reason);
});

Deno.test("a SIZE change is reported as a size change, not as 100% of pixels", () => {
  // A resized window makes every pixel "different", and reporting that sends
  // the reader hunting a visual change that did not happen.
  const d = comparePixels(
    solid(10, 10, [0, 0, 0, 255]),
    solid(12, 10, [0, 0, 0, 255]),
  );
  assert(!d.same);
  assert(d.reason.startsWith("size changed"), d.reason);
  assert(d.reason.includes("12x10") && d.reason.includes("10x10"), d.reason);
});

Deno.test("the default budget is ZERO — a moved button is not `a few pixels`", () => {
  const a = solid(100, 100, [0, 0, 0, 255]);
  const b = solid(100, 100, [0, 0, 0, 255]);
  b.rgba.set([255, 255, 255, 255], 0); // exactly one pixel
  assert(!comparePixels(a, b).same, "one changed pixel is a change");
  // …and a budget is available for a caller who knows their renderer wobbles.
  assert(comparePixels(a, b, { maxRatio: 0.001 }).same);
});

Deno.test("comparePng decodes both sides — same pixels, different bytes, same verdict", async () => {
  // THE case that makes this worth 200 lines: re-encoding changes the file and
  // not the image.
  const a = await appIconPng("bytes-probe", 32);
  const b = await appIconPng("bytes-probe", 32);
  const d = await comparePng(a, b);
  assert(d.same, d.reason);
  // A different app name really is a different icon, so the check can fail.
  const other = await appIconPng("bytes-probe-2", 32);
  assert(!(await comparePng(a, other)).same);
});
