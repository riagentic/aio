// Task2 Steps A/B — a compiled binary must not carry the TypeScript compiler,
// esbuild, or appimagetool; and the audit that says so reads REAL artifact
// bytes, not intent.
//
// The end-to-end half of Step A is in `build-e2e.test.ts` (it builds a binary
// and scans it). This file pins the mechanism: the dev-closure classification
// that keeps `typescript` out, the `build.keepPackages` escape hatch, and the
// scanner both halves share.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  buildToolHitsIn,
  needlePackage,
  scanArtifactForBuildTools,
} from "../src/build/artifact-audit.ts";
import {
  keepPackagesDeclared,
  withDevExcluded,
} from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** A minimal `.deno` layout with one real dep (`immer`) and one dev-only dep
 *  (`typescript`), symlinked the way deno writes them. */
async function fakeNodeModules(root: string): Promise<string> {
  const nm = join(root, "node_modules");
  const deno = join(nm, ".deno");
  for (const entry of ["immer@10.2.0", "typescript@5.6.3"]) {
    const pkg = entry.slice(0, entry.lastIndexOf("@"));
    const dir = join(deno, entry, "node_modules", pkg);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "index.js"), "export default 1;\n");
  }
  for (const entry of ["immer@10.2.0", "typescript@5.6.3"]) {
    const pkg = entry.slice(0, entry.lastIndexOf("@"));
    await Deno.symlink(
      `.deno/${entry}/node_modules/${pkg}`,
      join(nm, pkg),
    );
  }
  return nm;
}

Deno.test("artifact audit: matches embedded VFS file NAMES, not raw text", () => {
  // Two real leak records + the escaping journal noise that poisoned the first
  // (raw-byte) cut: the module's own needle text and a node_modules link entry.
  const leak = `{"File":{"n":"file:///a/node_modules/.deno/typescript@5.6.3/` +
    `node_modules/typescript/lib/tsc.js","o":[1,2]}}` +
    `{"File":{"n":"file:///a/node_modules/.deno/esbuild@0.24.2/` +
    `node_modules/esbuild/bin/esbuild","o":[3,4]}}`;
  assertEquals(buildToolHitsIn(new TextEncoder().encode(leak)), [
    "/typescript/lib/tsc.js",
    "/esbuild/bin/esbuild",
  ]);

  // Noise that is NOT a File record must not read as a leak: the audit module's
  // own source (which contains these words), and node_modules link bookkeeping.
  const noise = new TextEncoder().encode(
    'export const BUILD_TOOL_NEEDLES = ["/typescript/lib/tsc.js", ' +
      '"/esbuild/bin/esbuild"];' +
      '{"path":".bin/tsc","target":"../.deno/typescript@5.6.3/' +
      'node_modules/typescript/bin/tsc","isDir":false}',
  );
  assertEquals(buildToolHitsIn(noise), []);
});

Deno.test("artifact audit: needle → package, so keepPackages silences only its own", () => {
  assertEquals(needlePackage("/typescript/lib/tsc.js"), "typescript");
  assertEquals(needlePackage("/typescript/lib/typescript.js"), "typescript");
  assertEquals(needlePackage("/esbuild/bin/esbuild"), "esbuild");
  assertEquals(needlePackage("/@esbuild/win32-x64/esbuild.exe"), "esbuild");
  assertEquals(needlePackage("/appimagetool-x86_64-"), "appimagetool");
  // A needle with no known package maps to itself (nothing is ever silently
  // un-filterable).
  assertEquals(needlePackage("something-else"), "something-else");
});

Deno.test("artifact audit: streams a real file, even across a chunk seam", async () => {
  const tmp = await tempDir("artifact-audit-");
  try {
    const record = '{"File":{"n":"/x/typescript/lib/tsc.js","o":[1,2]}}';
    // Put the whole record across the boundary of a tiny chunk.
    const pad = "A".repeat(20);
    const p = join(tmp, "blob.bin");
    await Deno.writeTextFile(p, pad + record + pad);
    assertEquals(await scanArtifactForBuildTools(p, 17), [
      "/typescript/lib/tsc.js",
    ]);
    const clean = join(tmp, "clean.bin");
    await Deno.writeTextFile(
      clean,
      '{"File":{"n":"/x/app.ts","o":[1,2]}}' + pad,
    );
    assertEquals(await scanArtifactForBuildTools(clean, 5), []);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("dev closure excludes typescript; build.keepPackages brings it back", async () => {
  const tmp = await tempDir("keep-packages-");
  try {
    const nm = await fakeNodeModules(tmp);

    let excluded: string[] = [];
    await withDevExcluded(nm, (e) => {
      excluded = e;
      return Promise.resolve(true);
    });
    assert(
      excluded.some((e) => e.endsWith("typescript@5.6.3")),
      `typescript must be excluded by default, got: ${excluded.join(", ")}`,
    );
    assert(
      !excluded.some((e) => e.endsWith("immer@10.2.0")),
      "a real dependency must never be excluded",
    );
    // The symlink is restored after the callback.
    assertEquals(
      await Deno.readLink(join(nm, "typescript")),
      ".deno/typescript@5.6.3/node_modules/typescript",
    );

    let keptExcluded: string[] = [];
    await withDevExcluded(
      nm,
      (e) => {
        keptExcluded = e;
        return Promise.resolve(true);
      },
      undefined,
      ["typescript"],
    );
    assert(
      !keptExcluded.some((e) => e.endsWith("typescript@5.6.3")),
      `build.keepPackages must keep typescript, got: ${
        keptExcluded.join(", ")
      }`,
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("build.keepPackages: absent → [], valid parsed, bad shapes refused", async () => {
  const tmp = await tempDir("keep-decl-");
  try {
    assertEquals(await keepPackagesDeclared(tmp), []);

    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { keepPackages: ["typescript", " esbuild "] } }),
    );
    assertEquals(await keepPackagesDeclared(tmp), ["typescript", "esbuild"]);

    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { keepPackages: "typescript" } }),
    );
    await assertRejects(
      () => keepPackagesDeclared(tmp),
      Error,
      "must be an array",
    );

    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { keepPackages: [""] } }),
    );
    await assertRejects(
      () => keepPackagesDeclared(tmp),
      Error,
      "non-empty package name",
    );
  } finally {
    await dropTempDir(tmp);
  }
});
