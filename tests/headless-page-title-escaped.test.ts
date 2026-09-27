// the headless-build 503 page interpolates `title` into <title> raw,
// while every other shell (generateHTML, the diagnostic page) escHtml()s it.
// A title that merely contains `</title>` ends the element early and the rest
// is parsed as markup. The page also has no `<html lang>` (htmlOpen rule).
import { assert, assertEquals } from "@std/assert";
import {
  createStaticHandler,
  type StaticDeps,
} from "../src/server/server-static.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function deps(over: Partial<StaticDeps>): StaticDeps {
  return {
    prod: true,
    debug: () => {},
    title: "T",
    absBaseDir: "/tmp",
    absDistDir: null,
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => null,
    getVitalsExtra: () => ({ payloadStats: new Map(), clientBackpressure: {} }),
    getTrojanDeps: () => ({}),
    ...over,
  };
}

Deno.test("headless-build page escapes the app title like every other shell", async () => {
  const dist = await tempDir("aio-headless-"); // no app.js in it
  try {
    const title = `Q&A </title><script>alert(1)</script>`;
    const { serveStatic } = createStaticHandler(
      deps({ absBaseDir: dist, absDistDir: dist, title }),
    );
    const res = await serveStatic("/");
    const html = await res.text();
    assertEquals(res.status, 503, html);
    assert(
      !html.includes("<script>alert(1)</script>"),
      `title reached the page as markup:\n${html.slice(0, 200)}`,
    );
  } finally {
    await dropTempDir(dist);
  }
});

Deno.test("headless-build page carries <html lang> (htmlOpen rule)", async () => {
  const dist = await tempDir("aio-headless-lang-");
  try {
    const { serveStatic } = createStaticHandler(
      deps({ absBaseDir: dist, absDistDir: dist, lang: "de" }),
    );
    const html = await (await serveStatic("/")).text();
    assert(html.includes(`<html lang="de"`), html.slice(0, 120));
  } finally {
    await dropTempDir(dist);
  }
});
