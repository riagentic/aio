// A mount's own root (`/files/`) answers like a directory inside it
// (`/files/sub/`): both are directories, so both fall to the app shell. The
// root used to 403 — `resolve(root, "")` IS the root, and the traversal guard
// only admitted paths strictly below it.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createStaticHandler } from "../src/server/server-static.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("mount root answers like a subdir of the mount", async () => {
  const root = await tempDir("aio-mount-root-");
  try {
    const base = join(root, "app");
    const files = join(root, "files");
    await Deno.mkdir(join(files, "sub"), { recursive: true });
    await Deno.mkdir(base);
    await Deno.writeTextFile(join(files, "a.txt"), "a");
    const h = createStaticHandler({
      prod: false,
      debug: () => {},
      title: "t",
      absBaseDir: base,
      assets: { "/files": files },
      absDistDir: join(base, "dist"),
      hasCSS: false,
      importMap: "{}",
      noCache: {},
      getGraphResult: () => null,
      // deno-lint-ignore no-explicit-any
    } as any);
    const sub = await h.serveStatic("/files/sub/");
    const top = await h.serveStatic("/files/");
    await sub.body?.cancel();
    await top.body?.cancel();
    assertEquals(top.status, sub.status, "mount root and a subdir differ");
    assertEquals(top.status, 200);
    const file = await h.serveStatic("/files/a.txt");
    assertEquals(await file.text(), "a");
  } finally {
    await dropTempDir(root);
  }
});
