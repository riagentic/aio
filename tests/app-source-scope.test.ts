// "What is this app's source" — ONE decider for `am pin`, `am migrate` and
// aiol's scan hint (report 9 §2b, §4). The app already says what is not its
// code, in files it already has: deno.json `exclude` / `fmt.exclude` and
// `.gitignore`. These pin how each spelling is read, without a filesystem.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { appSourceFiles, sourceScopeFrom } from "../src/am/app-source-scope.ts";

Deno.test("scope: deno.json exclude and fmt.exclude, every spelling of a directory", () => {
  const s = sourceScopeFrom(
    { exclude: ["./vendor/"], fmt: { exclude: ["examples", "gen/**"] } },
    null,
  );
  assertEquals(s.excludedBy("vendor", true), "deno.json exclude");
  assertEquals(s.excludedBy("vendor/a/b.ts", false), "deno.json exclude");
  assertEquals(
    s.excludedBy("examples/opencode/x.ts", false),
    "deno.json fmt.exclude",
  );
  assertEquals(s.excludedBy("gen/out.ts", false), "deno.json fmt.exclude");
  // A prefix is not a directory: `examples-kit/` is the app's own.
  assertEquals(s.excludedBy("examples-kit/x.ts", false), null);
  assertEquals(s.excludedBy("src/cell.ts", false), null);
});

Deno.test("scope: deno.json globs and a `!` re-include", () => {
  const s = sourceScopeFrom(
    { exclude: ["**/*.gen.ts", "third_party", "!third_party/ours"] },
    null,
  );
  assertEquals(s.excludedBy("src/api.gen.ts", false), "deno.json exclude");
  assertEquals(
    s.excludedBy("third_party/theirs/x.ts", false),
    "deno.json exclude",
  );
  assertEquals(s.excludedBy("third_party/ours/x.ts", false), null);
});

Deno.test("scope: .gitignore — anchored, unanchored, directory-only, negated, comments", () => {
  const s = sourceScopeFrom(
    null,
    [
      "# vendored for reference",
      "/examples/",
      "scratch",
      "logs/",
      "docs/generated",
      "!scratch/keep.ts",
      "",
    ].join("\n"),
  );
  assertEquals(s.excludedBy("examples/a.ts", false), ".gitignore");
  // `/examples/` is root-anchored: a nested one is the app's.
  assertEquals(s.excludedBy("src/examples/a.ts", false), null);
  // An unanchored name matches at any depth.
  assertEquals(s.excludedBy("src/scratch/a.ts", false), ".gitignore");
  // `logs/` names directories only — a FILE called logs is not ignored.
  assertEquals(s.excludedBy("src/logs", false), null);
  assertEquals(s.excludedBy("src/logs/x.ts", false), ".gitignore");
  // An inner slash anchors the pattern.
  assertEquals(s.excludedBy("docs/generated/x.ts", false), ".gitignore");
  assertEquals(s.excludedBy("src/docs/generated/x.ts", false), null);
  assertEquals(s.excludedBy("scratch/keep.ts", false), null);
});

Deno.test("scope: nothing declared → nothing excluded (a malformed entry is ignored, never a wildcard)", () => {
  const s = sourceScopeFrom(
    { exclude: "examples", fmt: { exclude: [1, ""] } },
    "",
  );
  assertEquals(s.excludedBy("examples/x.ts", false), null);
  assertEquals(s.excludedBy("src/x.ts", false), null);
});

Deno.test("appSourceFiles: walks the app, skips deps/build/dot-dirs and what the app excludes", async () => {
  const dir = await tempDir("aio-scope-");
  try {
    const files = [
      "src/cell.ts",
      "src/App.tsx",
      "examples/vendored/a.ts",
      "dep/aio/mod.ts",
      "node_modules/x/y.ts",
      ".aio/z.ts",
      "tools/gen.ts",
    ];
    for (const f of files) {
      await Deno.mkdir(join(dir, f, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, f), "export {};\n");
    }
    await Deno.writeTextFile(
      join(dir, "deno.jsonc"),
      `{ // comments are fine\n  "fmt": { "exclude": ["examples/"] }\n}\n`,
    );
    await Deno.writeTextFile(join(dir, ".gitignore"), "tools/\n");
    const seen = (await Array.fromAsync(appSourceFiles(dir)))
      .map((p) => p.slice(dir.length + 1).replaceAll("\\", "/"))
      .sort();
    assertEquals(seen, ["src/App.tsx", "src/cell.ts"]);
  } finally {
    await dropTempDir(dir);
  }
});
