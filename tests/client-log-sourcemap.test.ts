// A forwarded browser error must name the AUTHOR's file, not `app.js:1:22073`.
//
// Two field reports call the renderer-console forwarder the best thing in the
// box, and both showed the same defect: the position on every forwarded line
// was a byte offset into a one-line minified bundle. The map is applied
// SERVER-SIDE — a browser never applies one to the string form of
// `Error.stack` — so this drives the server's log writer, which is where the
// text is actually rendered.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as esbuild from "esbuild";
import {
  _resetClientSourceMap,
  hasClientSourceMap,
  remapClientText,
  setClientSourceMap,
} from "../src/diagnostics/stack-remap.ts";
import {
  flushClientLog,
  initClientLog,
  writeClientLog,
} from "../src/server/client-log.ts";
import { isProtectedPath } from "../src/server/server-static.ts";

/** Build a one-line minified bundle plus its real map, and report where a
 *  marker landed in the generated output. */
async function bundleWithMap(): Promise<
  { map: string; line: number; col: number; srcLine: number }
> {
  const dir = await tempDir("aio-clslog-");
  try {
    const src = [
      "function helper(n) {", //            source line 1
      "  return n * 2;", //                 source line 2
      "}", //                               source line 3
      "export function CRASH_HERE() {", //  source line 4
      '  throw new Error("kaboom");', //    source line 5
      "}", //                               source line 6
      "globalThis.k = [helper, CRASH_HERE];",
      "",
    ].join("\n");
    await Deno.writeTextFile(`${dir}/app.ts`, src);
    const res = await esbuild.build({
      entryPoints: [`${dir}/app.ts`],
      bundle: true,
      minify: true,
      format: "esm",
      write: false,
      sourcemap: "external",
      outfile: "app.js",
      absWorkingDir: dir,
    });
    const map = res.outputFiles!.find((f) => f.path.endsWith(".map"))!.text;
    const js = res.outputFiles!.find((f) => !f.path.endsWith(".map"))!.text;
    const idx = js.indexOf("kaboom");
    assert(idx > 0, "the marker must survive minification");
    const before = js.slice(0, idx);
    return {
      map,
      line: before.split("\n").length,
      col: idx - (before.lastIndexOf("\n") + 1) + 1,
      srcLine: 5,
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name: "a forwarded stack is written with the AUTHOR's position",
  // esbuild runs through a native child that is SHARED by every test file in
  // this process. Calling `esbuild.stop()` here would tear it down under
  // whichever other file is mid-build — measured: four tests in three files
  // failed that way in the full suite and passed alone. So the child is left
  // running and the sanitizers are told why.
  sanitizeOps: false, // aio-ok: esbuild's shared service child
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const { map, line, col, srcLine } = await bundleWithMap();
    const dir = await tempDir("aio-clslog-out-");
    try {
      initClientLog(dir);
      // Before: no map installed — the line is exactly what it always was.
      _resetClientSourceMap();
      assert(!hasClientSourceMap());
      writeClientLog(1, {
        level: "error",
        msg:
          `Error: kaboom\n    at CRASH_HERE (http://x/app.js:${line}:${col})`,
        ts: Date.now(),
        source: `http://x/app.js:${line}:${col}`,
      });
      await flushClientLog();
      const before = await Deno.readTextFile(`${dir}/client.log`);
      assertStringIncludes(before, `app.js:${line}:${col}`);
      assert(
        !before.includes("app.ts:"),
        "without a map there is nothing to improve, and nothing is invented",
      );

      // After: the same frame, the author's file and line.
      await Deno.remove(`${dir}/client.log`);
      setClientSourceMap(map, "app.js");
      assert(hasClientSourceMap());
      writeClientLog(1, {
        level: "error",
        msg:
          `Error: kaboom\n    at CRASH_HERE (http://x/app.js:${line}:${col})`,
        ts: Date.now(),
        source: `http://x/app.js:${line}:${col}`,
      });
      await flushClientLog();
      const after = await Deno.readTextFile(`${dir}/client.log`);
      assertStringIncludes(after, `app.ts:${srcLine}:`);
      assert(
        !after.includes(`app.js:${line}:${col}`),
        `the bundle position is REPLACED, not appended: ${after}`,
      );
      // The message itself is untouched — only positions move.
      assertStringIncludes(after, "Error: kaboom");
      // …and so is the frame's shape, which is what a reader scans for.
      assertStringIncludes(after, "at CRASH_HERE (");
    } finally {
      _resetClientSourceMap();
      await dropTempDir(dir);
    }
  },
});

Deno.test("remapping never throws, and never invents a position", () => {
  _resetClientSourceMap();
  // Identity with no map.
  assertEquals(remapClientText("app.js:1:5"), "app.js:1:5");
  // An unparseable map is an ABSENT map, not a half-installed one.
  setClientSourceMap("{not json", "app.js");
  assert(!hasClientSourceMap());
  assertEquals(remapClientText("app.js:1:5"), "app.js:1:5");
  // A map that covers nothing leaves every position alone.
  setClientSourceMap('{"sources":["a.ts"],"mappings":""}', "app.js");
  assertEquals(remapClientText("app.js:1:5"), "app.js:1:5");
  // Clearing is explicit: a reload that produced no map must not leave the
  // previous bundle's map mapping the new bundle's positions.
  setClientSourceMap(null, "app.js");
  assert(!hasClientSourceMap());
  _resetClientSourceMap();
});

Deno.test("the map is UNREACHABLE over HTTP — a dotfile, at any depth", () => {
  // `.map` is in SHELL_EXT, so a plainly-named `dist/app.js.map` would be
  // served: the app's entire source, unauthenticated. The build writes the
  // dot-prefixed name for exactly this reason, and this is the assertion that
  // keeps the two facts attached to each other.
  assert(isProtectedPath("/.app.js.map"), "the name the build writes");
  assert(isProtectedPath("/sub/.app.js.map"), "at any depth");
  assert(isProtectedPath("/.app.js.map/"), "and with the trailing-slash trick");
  // The naming is load-bearing, so pin the thing it is protecting AGAINST:
  // the plain name really is servable, which is why it must never be written.
  assert(
    !isProtectedPath("/app.js.map"),
    "if this ever becomes protected the dotfile is belt-and-braces, not the " +
      "only thing standing between a build and published source",
  );
});

Deno.test({
  name: "boot: the map is loaded from dist, by the name the build writes",
  // esbuild runs through a native child that is SHARED by every test file in
  // this process. Calling `esbuild.stop()` here would tear it down under
  // whichever other file is mid-build — measured: four tests in three files
  // failed that way in the full suite and passed alone. So the child is left
  // running and the sanitizers are told why.
  sanitizeOps: false, // aio-ok: esbuild's shared service child
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const { installBundleSourceMap } = await import(
      "../src/server/sourcemap-boot.ts"
    );
    const { BUNDLE_MAP } = await import("../src/server/app-files.ts");
    const dir = await tempDir("aio-smboot-");
    try {
      // No map — the normal dev answer, and it must CLEAR rather than keep a
      // previous bundle's map mapping a bundle it no longer describes.
      setClientSourceMap(
        '{"sources":["stale.ts"],"mappings":"AAAA"}',
        "app.js",
      );
      assert(hasClientSourceMap(), "precondition: a stale map is installed");
      assertEquals(await installBundleSourceMap(dir), false);
      assert(!hasClientSourceMap(), "a boot with no map clears the old one");

      // A real map, under the exact name the build writes. If these two ever
      // disagree the feature is silently absent, which is how it first shipped.
      const { map } = await bundleWithMap();
      await Deno.writeTextFile(`${dir}/${BUNDLE_MAP}`, map);
      assertEquals(await installBundleSourceMap(dir), true);
      assert(hasClientSourceMap());

      // "The file was there" and "the map is usable" are different answers.
      await Deno.writeTextFile(`${dir}/${BUNDLE_MAP}`, "{ truncated");
      assertEquals(
        await installBundleSourceMap(dir),
        false,
        "a truncated map reads fine and maps nothing — say so",
      );
    } finally {
      _resetClientSourceMap();
      await dropTempDir(dir);
    }
  },
});
