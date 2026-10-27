// A package the compile ITSELF installs arrives after the exclude list and the
// trim were decided: that binary carried its docs and maps, and only a later
// build, finding it on disk, did not. So the build compiles once more, now
// that it is there. (The field case — aio's own happy-dom pulled in by a
// minified `import("happy-dom")` — is closed at its source in
// minify-server.ts; this is the net under every other late install.)
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withDevExcluded } from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { linkDir } from "./symlink-helper.ts";

const exists = (p: string) => Deno.lstat(p).then(() => true).catch(() => false);

async function entryFile(nm: string, entry: string, pkg: string, rel: string) {
  const p = join(nm, ".deno", entry, "node_modules", pkg, rel);
  await Deno.mkdir(join(p, ".."), { recursive: true });
  await Deno.writeTextFile(p, "x");
  return p;
}

Deno.test("build: a package the compile itself installs is compiled again, trimmed", async () => {
  const dir = await tempDir("aio-late-install-");
  const nm = join(dir, "node_modules");
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    await entryFile(nm, "app-lib@1.0.0", "app-lib", "index.js");
    await linkDir(
      ".deno/app-lib@1.0.0/node_modules/app-lib",
      join(nm, "app-lib"),
    );
    const lateDoc = join(
      nm,
      ".deno",
      "late@2.0.0",
      "node_modules",
      "late",
      "README.md",
    );
    const seenDoc: boolean[] = [];
    const ok = await withDevExcluded(nm, async () => {
      // The first compile installs `late` — docs and all.
      if (seenDoc.length === 0) {
        await entryFile(nm, "late@2.0.0", "late", "index.js");
        await entryFile(nm, "late@2.0.0", "late", "README.md");
      }
      seenDoc.push(await exists(lateDoc));
      return true;
    });
    assert(ok);
    // Compiled twice; the second compile saw `late` trimmed.
    assertEquals(seenDoc, [true, false]);
    assertStringIncludes(logs.join("\n"), "installed by the compile itself");
    // Everything held aside is back.
    assert(await exists(lateDoc));
  } finally {
    console.log = log;
    await dropTempDir(dir);
  }
});
