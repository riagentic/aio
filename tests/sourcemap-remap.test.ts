// The forwarded stack says `app.js:1:22073`. This is what turns it back.
//
// DRIVEN BY A REAL esbuild MAP, never a hand-written one. A fixture map I
// encode myself only proves my decoder agrees with my encoder — the exact
// shape of self-confirming test this repo keeps finding. So the test BUILDS a
// file with esbuild (minified, one line, the bundle's real shape), asks for the
// position of a string it can find in the output, and requires the answer to be
// the line that string was written on in the source.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals } from "@std/assert";
import * as esbuild from "esbuild";
import {
  decodeVlq,
  mapPosition,
  parseSourceMap,
  remapStack,
} from "../src/diagnostics/sourcemap.ts";

Deno.test("decodeVlq: the sign bit is a SIGN, and -0 is the largest negative", () => {
  // `A` = 0. `C` = 2 → +1. `D` = 3 → -1. `B` = 1 → sign set, magnitude 0:
  // the "-0" encoding, which the reference decoder (mozilla base64-vlq) maps
  // to the largest negative so a map round-trips instead of silently reading
  // as 0 and shifting every later column in the segment.
  assertEquals(decodeVlq("A"), [0]);
  assertEquals(decodeVlq("C"), [1]);
  assertEquals(decodeVlq("D"), [-1]);
  assertEquals(decodeVlq("B"), [-0x80000000]);
  // Multi-digit continuation: `gB` = 16 continued + 0 → 16.
  assertEquals(decodeVlq("gB"), [16]);
  // A character outside the alphabet ENDS the segment — an unparseable map
  // must yield less, never throw into the error channel it serves.
  assertEquals(decodeVlq("A#C"), [0]);
  assertEquals(decodeVlq(""), []);
});

Deno.test("parseSourceMap: unusable input is null, once, for every shape", () => {
  assertEquals(parseSourceMap("not json"), null);
  assertEquals(parseSourceMap("{}"), null);
  assertEquals(parseSourceMap('{"sources":[]}'), null);
  assertEquals(parseSourceMap('{"mappings":"AAAA"}'), null);
  assert(parseSourceMap('{"sources":["a.ts"],"mappings":"AAAA"}') !== null);
});

Deno.test({
  name: "a REAL esbuild map maps a minified position back to its source line",
  // esbuild runs through a native child that is SHARED by every test file in
  // this process. Calling `esbuild.stop()` here would tear it down under
  // whichever other file is mid-build — measured: four tests in three files
  // failed that way in the full suite and passed alone. So the child is left
  // running and the sanitizers are told why.
  sanitizeOps: false, // aio-ok: esbuild's shared service child
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const dir = await tempDir("aio-srcmap-");
    try {
      const src = [
        "export function alpha() {",
        '  return "ALPHA_MARKER";',
        "}",
        "export function beta() {",
        '  throw new Error("BETA_MARKER");',
        "}",
        "globalThis.x = [alpha, beta];",
        "",
      ].join("\n");
      const file = `${dir}/entry.ts`;
      await Deno.writeTextFile(file, src);
      const res = await esbuild.build({
        entryPoints: [file],
        bundle: true,
        minify: true, // one line, thousands of segments — the real shape
        format: "esm",
        write: false,
        sourcemap: "external",
        absWorkingDir: dir,
        outfile: "entry.js", // external maps need a name, even with write:false
      });
      const mapFile = res.outputFiles!.find((f) => f.path.endsWith(".map"))!;
      const jsFile = res.outputFiles!.find((f) => !f.path.endsWith(".map"))!;
      const map = parseSourceMap(mapFile.text);
      assert(map, "esbuild's own map must parse");

      // The generated position of a marker we can locate without guessing.
      const js = jsFile.text;
      const idx = js.indexOf("BETA_MARKER");
      assert(idx > 0, `marker must survive minification: ${js.slice(0, 200)}`);
      const before = js.slice(0, idx);
      const line = before.split("\n").length;
      const column = idx - (before.lastIndexOf("\n") + 1) + 1;

      const pos = mapPosition(map, line, column);
      assert(pos, "a position inside real code must map");
      assert(
        pos.source.endsWith("entry.ts"),
        `the source file, not the bundle: ${pos.source}`,
      );
      assertEquals(
        pos.line,
        5,
        `BETA_MARKER is written on source line 5, got ${pos.line}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "remapStack: rewrites positions, keeps the frame, scopes by filename",
  // esbuild runs through a native child that is SHARED by every test file in
  // this process. Calling `esbuild.stop()` here would tear it down under
  // whichever other file is mid-build — measured: four tests in three files
  // failed that way in the full suite and passed alone. So the child is left
  // running and the sanitizers are told why.
  sanitizeOps: false, // aio-ok: esbuild's shared service child
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const dir = await tempDir("aio-srcmap2-");
    try {
      const file = `${dir}/app.ts`;
      await Deno.writeTextFile(
        file,
        ["const a = 1;", "const b = 2;", "export const boom = () => a + b;", ""]
          .join("\n"),
      );
      const res = await esbuild.build({
        entryPoints: [file],
        bundle: true,
        minify: true,
        format: "esm",
        write: false,
        sourcemap: "external",
        absWorkingDir: dir,
        outfile: "app.js",
      });
      const map = parseSourceMap(
        res.outputFiles!.find((f) => f.path.endsWith(".map"))!.text,
      )!;
      const js = res.outputFiles!.find((f) => !f.path.endsWith(".map"))!.text;
      const idx = js.indexOf("boom");
      const col = idx + 1;

      const stack = `Error: nope\n    at boom (https://x/app.js:1:${col})\n` +
        `    at other (https://x/vendor.js:1:${col})`;
      const out = remapStack(stack, map, { only: /(^|\/)app\.js$/ });

      assert(out.includes("Error: nope"), "the message survives");
      assert(out.includes("at boom ("), "the frame shape survives");
      assert(
        /app\.ts:\d+:\d+/.test(out),
        `the app frame is rewritten to its source: ${out}`,
      );
      assert(
        out.includes(`vendor.js:1:${col}`),
        `a frame outside the bundle is left alone: ${out}`,
      );
      // A null map is the identity — the whole point of best-effort.
      assertEquals(remapStack(stack, null), stack);
    } finally {
      await dropTempDir(dir);
    }
  },
});
