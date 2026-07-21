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

Deno.test("B-6: esbuild imports pin the EXACT deno.json version (no range)", () => {
  const pin = pinnedVersion();
  for (
    const file of [
      "src/server/server-transpile.ts", // computed specifier (lean am install)
      "src/server/lint.ts", // computed specifier
      "src/build/build-bundle.ts", // literal (build needs esbuild eagerly)
    ]
  ) {
    const src = Deno.readTextFileSync(file);
    // Match a literal `import("npm:esbuild@X")` OR the COMPUTED form
    // `["npm:esbuild", "X"]` — server-transpile/lint use the computed specifier
    // so `deno install am` doesn't eagerly fetch the esbuild native binary.
    const versions = [
      ...src.matchAll(/import\(\s*["']npm:esbuild@([^"']+)["']\s*\)/g),
      ...src.matchAll(/["']npm:esbuild["']\s*,\s*["']([^"']+)["']/g),
    ].map((m) => m[1]!);
    assertEquals(
      versions.length > 0,
      true,
      `${file} should reference npm:esbuild`,
    );
    for (const ver of versions) {
      // Exact version only — no `^`, `~`, `*`, or `x` ranges.
      assertEquals(/^[\d.]+$/.test(ver), true, `${file} uses a range "${ver}"`);
      assertEquals(ver, pin, `${file} pin must match deno.json (${pin})`);
    }
  }
});
