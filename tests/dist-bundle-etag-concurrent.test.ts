// `/app.js` and `/style.css` (prod) are served with `ETag: _lastDistEtag`, a
// closure-wide variable that `readDistCached` sets just before returning. The
// comment says the caller "is synchronous with it" — it is not: the caller
// `await`s, and between the callee's assignment and the caller's resumption
// another request's `readDistCached` can overwrite the variable. Concurrent
// requests for the two bundle files then carry each other's validator, which
// breaks revalidation (and a stale 304 is one more interleaving away).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { etagOf } from "../src/server/http-encoding.ts";

Deno.test("concurrent /app.js + /style.css each carry their OWN ETag", async () => {
  const port = freePort();
  const dir = await tempDir("r8-dist-etag");
  const dist = join(dir, "dist");
  await Deno.mkdir(dist, { recursive: true });
  const js = "export function mount(){}\n" + "// js\n".repeat(500);
  const css = "body{color:red}\n".repeat(700);
  await Deno.writeTextFile(join(dist, "app.js"), js);
  await Deno.writeTextFile(join(dist, "style.css"), css);
  const tagOf = (s: string) =>
    etagOf(new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>);
  const want: Record<string, string> = {
    "/app.js": tagOf(js),
    "/style.css": tagOf(css),
  };
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
    // Wait until answering.
    for (let i = 0; i < 200; i++) {
      try {
        const r = await fetch(url + "/app.js");
        await r.body?.cancel();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    // Sequentially, each file carries its own tag — the expectation is right.
    for (const p of ["/app.js", "/style.css", "/app.js"]) {
      const r = await fetch(url + p, {
        headers: { "accept-encoding": "identity" },
      });
      await r.body?.cancel();
      assertEquals(r.headers.get("etag"), want[p], `sequential ${p}`);
    }
    const wrong: string[] = [];
    for (let round = 0; round < 20; round++) {
      const paths = Array.from(
        { length: 20 },
        (_, i) => (i % 2 ? "/app.js" : "/style.css"),
      );
      const got = await Promise.all(paths.map(async (p) => {
        const r = await fetch(url + p, {
          headers: { "accept-encoding": "identity" },
        });
        await r.body?.cancel();
        return [p, r.headers.get("etag")] as const;
      }));
      for (const [p, tag] of got) {
        if (tag !== want[p]) wrong.push(`${p} carried ${tag}`);
      }
    }
    assertEquals(
      wrong.slice(0, 5),
      [],
      `${wrong.length} responses carried another file's ETag`,
    );
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});
