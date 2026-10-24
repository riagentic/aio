// The static deny list judges the file that OPENS, not only the name asked for.
//
// Windows opens `io.server.ts` for `io.server.ts.`, `io.server.ts%20`,
// `io.server.ts::$DATA` and the 8.3 name — spellings the name rule does not
// match, so a server-only module's source went out raw. The fix judges the
// real path's own name; on any OS a link to a protected file is the same case.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createStaticHandler } from "../src/server/server-static.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { linkFile } from "./symlink-helper.ts";

function handlerFor(absBaseDir: string, prod: boolean) {
  return createStaticHandler({
    prod,
    debug: () => {},
    title: "t",
    absBaseDir,
    absDistDir: join(absBaseDir, "dist"),
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    // deno-lint-ignore no-explicit-any
  } as any);
}

Deno.test("static: a name that opens a protected file is refused, in both modes", async () => {
  const dir = await tempDir("aio-opened-file-");
  try {
    await Deno.mkdir(join(dir, "dist"));
    await Deno.writeTextFile(
      join(dir, "io.server.ts"),
      "export const SECRET = 1",
    );
    await Deno.writeTextFile(join(dir, ".env"), "SECRET=1");
    await Deno.writeTextFile(join(dir, "App.tsx"), "export const SECRET = 2");
    await Deno.writeTextFile(join(dir, "logo.svg"), "<svg/>");
    await linkFile("io.server.ts", join(dir, "public.js"));
    await linkFile(".env", join(dir, "env.txt"));
    await linkFile("App.tsx", join(dir, "view.js"));
    await linkFile("logo.svg", join(dir, "alias.svg"));
    const windows = Deno.build.os === "windows"
      ? ["/io.server.ts.", "/io.server.ts%20", "/io.server.ts::$DATA"]
      : [];
    for (const prod of [false, true]) {
      const h = handlerFor(dir, prod);
      const denied = [
        "/public.js",
        "/env.txt",
        ...windows,
        ...(prod
          ? [
            "/view.js",
            ...windows.map((w) => w.replace("io.server.ts", "App.tsx")),
          ]
          : []),
      ];
      for (const p of denied) {
        const res = await h.serveStatic(p);
        const body = await res.text();
        assertEquals(res.status, 404, `${p} (prod=${prod}) served: ${body}`);
        assert(!body.includes("SECRET"), `${p} leaked: ${body}`);
      }
      const ok = await h.serveStatic("/alias.svg");
      assertEquals(ok.status, 200, "a link to an ordinary file still serves");
      await ok.text();
    }
  } finally {
    await dropTempDir(dir);
  }
});
