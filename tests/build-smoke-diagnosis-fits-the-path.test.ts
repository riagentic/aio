// "compiled, but does not run" named ONE cause for every failure: a path with
// a space or a non-ASCII character. Measured on a plain `/tmp/…/app` whose
// binary died on `Import "@std/jsonc" not a dependency` — the build told the
// user to move a project whose path had nothing wrong with it, right under
// the error that was the real cause. The path diagnosis is now given only for
// a path it can be true of.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { smokeRunArtifact } from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const PATH_CAUSE = "known cause";

async function failingBin(dir: string): Promise<string> {
  const bin = join(dir, "tool");
  await Deno.writeTextFile(
    bin,
    `#!/bin/sh\necho 'error: Import "@std/jsonc" not a dependency' >&2\nexit 1\n`,
  );
  await Deno.chmod(bin, 0o755);
  return bin;
}

Deno.test({
  name:
    "smoke diagnosis: a plain path is not blamed, a path with a space still is",
  ignore: Deno.build.os === "windows", // the stand-in artifact is a shell script
  fn: async () => {
    const dir = await tempDir("aio-smoke-diag-");
    try {
      const plain = await smokeRunArtifact(await failingBin(dir));
      assert(plain !== null, "an exit 1 is a broken build");
      assertStringIncludes(plain, "BROKEN BUILD");
      assertStringIncludes(plain, "not a dependency");
      assert(
        /^[\x21-\x7e]+$/.test(dir) && !plain.includes(PATH_CAUSE),
        `a plain path was blamed:\n${plain}`,
      );

      const spaced = join(dir, "my app ü");
      await Deno.mkdir(spaced);
      const blamed = await smokeRunArtifact(await failingBin(spaced));
      assert(blamed !== null);
      assertStringIncludes(blamed, PATH_CAUSE);
    } finally {
      await dropTempDir(dir);
    }
  },
});
