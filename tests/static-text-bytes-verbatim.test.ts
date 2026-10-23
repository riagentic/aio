// A static text file that is not a module is served as the bytes on disk.
//
// Every `.txt`/`.html`/`.md`/`.css`/`.json`/`.svg`/`.xml` under 8 MB went
// through `Deno.readTextFile` and back out as a string: a decode/encode round
// trip that nothing needed (only a module is rewritten), and that replaced
// every byte of a non-UTF-8 file with U+FFFD — a Latin-1 `café` reached the
// client as `caf�`, in dev and prod alike.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

Deno.test("static: a non-UTF-8 text file arrives byte for byte", async () => {
  const base = await Deno.makeTempDir({ prefix: "aio-text-bytes-" });
  try {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n"
    for (const f of ["notes.txt", "page.html", "data.xml"]) {
      await Deno.writeFile(join(base, f), latin1);
    }
    await using srv = await testServer({
      cells: [cell("text_bytes", { state: { n: 0 }, methods: {} })],
      baseDir: base,
    });
    for (const f of ["notes.txt", "page.html", "data.xml"]) {
      const r = await srv.fetch(`/${f}`);
      assertEquals(r.status, 200, f);
      assertEquals(new Uint8Array(await r.arrayBuffer()), latin1, f);
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
