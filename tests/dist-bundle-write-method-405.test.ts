// A write method aimed at a FILE is a 405 (`_readOnly`, see
// tests/static-write-method-405.test.ts: "DELETE /notes.txt answered 200 with
// the file, as if it had been deleted"). In prod the two bundle files
// (`/app.js`, `/style.css`) are served by a branch in `serveStatic` that runs
// BEFORE the `_readOnly` check, so `DELETE /app.js` still answers 200 with the
// bundle — the exact shape that test says was fixed.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("prod DELETE/POST /app.js and /style.css are 405, like every other file", async () => {
  const port = freePort();
  const dir = await tempDir("r8-dist-405");
  const dist = join(dir, "dist");
  await Deno.mkdir(dist, { recursive: true });
  await Deno.writeTextFile(join(dist, "app.js"), "export function mount(){}");
  await Deno.writeTextFile(join(dist, "style.css"), "body{}");
  await Deno.writeFile(join(dir, "logo.png"), new Uint8Array([1, 2, 3]));
  const server = createServer({
    port,
    title: "T",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: dist,
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 200; i++) {
      try {
        const r = await fetch(url + "/logo.png");
        await r.body?.cancel();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    // Control: an ordinary file already refuses.
    const png = await fetch(url + "/logo.png", { method: "DELETE" });
    await png.body?.cancel();
    assertEquals(png.status, 405, "DELETE /logo.png");
    for (const p of ["/app.js", "/style.css"]) {
      for (const method of ["DELETE", "POST"]) {
        const r = await fetch(url + p, { method, body: "x" });
        await r.body?.cancel();
        assertEquals(r.status, 405, `${method} ${p}`);
      }
    }
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});
