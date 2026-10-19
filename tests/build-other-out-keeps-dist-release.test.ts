// dist/ is every target's staging, emptied whatever `out` is. An app with
// `"out": "dist"` keeps its last release there — so a test build with
// `--out=dist-online` deleted that release without a word (a field report).
// A build to another out moves the previous release (manifest.json and its
// artifacts) to .aio/kept-dist-<stamp>/ first, and says so.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { distRelease } from "../src/build/dist-staging.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const BUILD_ALL = fromFileUrl(new URL("../src/build-all.ts", import.meta.url));

/** A per-target builder (the fleet's `--build-spec` seam) that empties dist/
 *  as the real one does before compiling, then writes its binary. */
const STUB = `
for await (const e of Deno.readDir("dist")) {
  await Deno.remove("dist/" + e.name, { recursive: true });
}
const bin = Deno.cwd() + "/keepdist";
await Deno.writeTextFile(bin, "#!/bin/sh\\necho 'keepdist 0.1.0 (aio 1.0.0-beta)'\\n");
await Deno.chmod(bin, 0o755);
`;

Deno.test("distRelease: a manifest.json makes dist/ a release — it and every non-staged entry, else nothing", () => {
  assertEquals(distRelease([]), []);
  assertEquals(distRelease(["app.js", "style.css", "leftover"]), []);
  assertEquals(
    distRelease([
      "app.js",
      "style.css",
      "manifest.json",
      "keepdist-linux-x86_64",
      ".DS_Store",
      "keepdist.AppImage",
    ]),
    ["keepdist-linux-x86_64", "keepdist.AppImage", "manifest.json"],
  );
});

Deno.test("dist: a build to another out keeps the release dist/ held, and says where", async () => {
  const dir = await tempDir("aio-keep-dist-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "keepdist", build: { targets: ["server"] } }),
    );
    await Deno.writeTextFile(join(dir, "stub-build.ts"), STUB);
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "export {};\n");
    await Deno.mkdir(join(dir, "dist"));
    const manifest = JSON.stringify({
      targets: [{ target: "linux", ok: true }],
    });
    await Deno.writeTextFile(join(dir, "dist", "manifest.json"), manifest);
    await Deno.writeTextFile(join(dir, "dist", "keepdist-linux"), "release\n");
    await Deno.writeTextFile(join(dir, "dist", "app.js"), "staged\n");
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        BUILD_ALL,
        `--build-spec=${join(dir, "stub-build.ts")}`,
        "--out=dist-online",
      ],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const said = dec.decode(out.stderr) + dec.decode(out.stdout);
    assertEquals(out.code, 0, said);
    const kept: string[] = [];
    for await (const e of Deno.readDir(join(dir, ".aio"))) {
      if (e.name.startsWith("kept-dist-")) kept.push(e.name);
    }
    const [name] = kept;
    assertEquals(kept.length, 1, said);
    assert(name);
    const keptDir = join(dir, ".aio", name);
    assertEquals(
      await Deno.readTextFile(join(keptDir, "keepdist-linux")),
      "release\n",
    );
    assertEquals(
      await Deno.readTextFile(join(keptDir, "manifest.json")),
      manifest,
    );
    assertStringIncludes(said, `moved to .aio/${name}/`);
    assertStringIncludes(said, "keepdist-linux, manifest.json");
    assert(
      (await Deno.stat(join(dir, "dist-online", "manifest.json"))).isFile,
      said,
    );
  } finally {
    await dropTempDir(dir);
  }
});
