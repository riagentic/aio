// dist/ is aio's staging dir, and every build empties it — so it was exempt
// from the out-dir guard (build-out-never-deletes-user-files.test.ts). But a
// project can arrive with a `dist/` of its OWN (a web project's build output,
// hand-placed files): the first `deno task build` deleted all of it under a
// green summary. A dist/ holding none of the files an aio build stages there,
// and no release manifest, was never aio's — refused, naming the files. A
// dist/ any aio build wrote is emptied exactly as before.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { foreignDist } from "../src/build/dist-staging.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const BUILD_ALL = fromFileUrl(new URL("../src/build-all.ts", import.meta.url));

/** A per-target builder that succeeds at once (the fleet's `--build-spec`
 *  seam): the fleet's own placement is what is under test, not a compile. */
const STUB = `
const bin = Deno.cwd() + "/distguard";
await Deno.writeTextFile(bin, "#!/bin/sh\\necho 'distguard 0.1.0 (aio 1.0.0-beta)'\\n");
await Deno.chmod(bin, 0o755);
`;

Deno.test("dist: a dist/ with none of aio's staged files is foreign; one aio wrote is not", () => {
  assertEquals(foreignDist([]), []);
  assertEquals(foreignDist([".DS_Store"]), []);
  assertEquals(foreignDist(["index.html", "assets"]), ["assets", "index.html"]);
  assertEquals(foreignDist(["app.js", "index.html"]), []);
  assertEquals(foreignDist(["manifest.json", "counter-linux-x86_64"]), []);
  assertEquals(foreignDist(["style.css", "leftover.bin"]), []);
});

Deno.test("dist: a fleet build into a project's own dist/ refuses and deletes nothing", async () => {
  const dir = await tempDir("aio-foreign-dist-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "distguard", build: { targets: ["server"] } }),
    );
    await Deno.writeTextFile(join(dir, "stub-build.ts"), STUB);
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "export {};\n");
    await Deno.mkdir(join(dir, "dist"));
    await Deno.writeTextFile(join(dir, "dist", "index.html"), "<p>mine</p>\n");
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        BUILD_ALL,
        `--build-spec=${join(dir, "stub-build.ts")}`,
      ],
      cwd: dir,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const said = dec.decode(out.stderr) + dec.decode(out.stdout);
    assertEquals(out.code, 1, said);
    assertStringIncludes(said, "index.html");
    assertStringIncludes(said, "DELETED");
    assert(
      (await Deno.readTextFile(join(dir, "dist", "index.html"))) ===
        "<p>mine</p>\n",
      "the user's file was touched",
    );
  } finally {
    await dropTempDir(dir);
  }
});
