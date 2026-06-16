// B-6 regression: dev transpile (server-transpile.ts) and prod bundle
// (build-bundle.ts) must load the SAME esbuild that deno.json pins. A `^0.24`
// range could resolve a different build than the project tested. This asserts
// the runtime-loaded esbuild version equals the deno.json import-map pin and
// that neither source file uses a drift-prone range specifier.
import { assertEquals } from "@std/assert";

function pinnedVersion(): string {
  const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));
  const spec = denoJson.imports?.esbuild as string; // "npm:esbuild@0.24.2"
  const m = spec.match(/esbuild@([\d.]+)$/);
  if (!m) {
    throw new Error(`deno.json esbuild pin is not an exact version: ${spec}`);
  }
  return m[1]!;
}

Deno.test("B-6: loaded esbuild version matches deno.json pin", async () => {
  const expected = pinnedVersion();
  // deno-lint-ignore no-import-prefix
  const esbuild = await import("npm:esbuild@0.24.2");
  assertEquals(esbuild.version, expected);
});

Deno.test("B-6: dynamic esbuild imports pin an exact version (no range)", () => {
  for (const file of ["src/server-transpile.ts", "src/build-bundle.ts"]) {
    const src = Deno.readTextFileSync(file);
    const imports = [
      ...src.matchAll(/import\(["']npm:esbuild@([^"']+)["']\)/g),
    ];
    assertEquals(imports.length > 0, true, `${file} should import npm:esbuild`);
    for (const m of imports) {
      const ver = m[1]!;
      // Exact version only — no `^`, `~`, `*`, or `x` ranges.
      assertEquals(/^[\d.]+$/.test(ver), true, `${file} uses range "${ver}"`);
      assertEquals(ver, pinnedVersion(), `${file} pin must match deno.json`);
    }
  }
});
