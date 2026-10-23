// serveFile (aio/server): a file on disk with the blob route's Range contract.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { serveFile } from "../src/server-entry.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const BYTES = new TextEncoder().encode("0123456789abcdefghij"); // 20 bytes

async function withFile(
  name: string,
  fn: (path: string, dir: string) => Promise<void>,
) {
  const dir = await tempDir("aio-serve-file-");
  try {
    const path = join(dir, name);
    await Deno.writeFile(path, BYTES);
    await fn(path, dir);
  } finally {
    await dropTempDir(dir);
  }
}

const get = (headers: Record<string, string> = {}, method = "GET") =>
  new Request("http://x/f", { method, headers });

Deno.test("serveFile: 200 whole file, Accept-Ranges, inert type + nosniff", async () => {
  await withFile("clip.mp4", async (p) => {
    const r = await serveFile(get(), p);
    assertEquals(r.status, 200);
    assertEquals(new Uint8Array(await r.arrayBuffer()), BYTES);
    assertEquals(r.headers.get("content-length"), "20");
    assertEquals(r.headers.get("accept-ranges"), "bytes");
    assertEquals(r.headers.get("content-type"), "video/mp4");
    assertEquals(r.headers.get("x-content-type-options"), "nosniff");
    assertEquals(r.headers.get("content-security-policy"), "sandbox");
  });
});

Deno.test("serveFile: a renderable type is never inferred; an explicit one is sent", async () => {
  await withFile("evil.html", async (p) => {
    const r = await serveFile(get(), p);
    await r.body?.cancel();
    assertEquals(r.headers.get("content-type"), "application/octet-stream");
    const t = await serveFile(get(), p, { type: "text/plain" });
    await t.body?.cancel();
    assertEquals(t.headers.get("content-type"), "text/plain");
  });
});

Deno.test("serveFile: Range edge cases — 206 / 416 / ignored", async () => {
  await withFile("a.bin", async (p) => {
    const cases: [string, number, string | null, string][] = [
      ["bytes=0-4", 206, "bytes 0-4/20", "01234"],
      ["bytes=15-", 206, "bytes 15-19/20", "fghij"],
      ["bytes=-3", 206, "bytes 17-19/20", "hij"],
      ["bytes=18-500", 206, "bytes 18-19/20", "ij"],
      ["bytes=-500", 206, "bytes 0-19/20", "0123456789abcdefghij"],
      ["bytes=19-19", 206, "bytes 19-19/20", "j"],
      ["bytes=5-2", 200, null, "0123456789abcdefghij"], // malformed → whole
      ["bytes=0-1,4-5", 200, null, "0123456789abcdefghij"], // multi → whole
      ["chunks=0-1", 200, null, "0123456789abcdefghij"],
    ];
    for (const [range, status, cr, body] of cases) {
      const r = await serveFile(get({ Range: range }), p);
      assertEquals(r.status, status, range);
      assertEquals(r.headers.get("content-range"), cr, range);
      assertEquals(await r.text(), body, range);
      assertEquals(r.headers.get("content-length"), String(body.length), range);
    }
    for (const range of ["bytes=20-", "bytes=-0", "bytes=99-100"]) {
      const r = await serveFile(get({ Range: range }), p);
      assertEquals(r.status, 416, range);
      assertEquals(r.headers.get("content-range"), "bytes */20", range);
      await r.body?.cancel();
    }
  });
});

Deno.test("serveFile: HEAD, 405, 404 (missing, directory), 304, If-Range", async () => {
  await withFile("a.bin", async (p, dir) => {
    const head = await serveFile(get({ Range: "bytes=0-1" }, "HEAD"), p);
    assertEquals(head.status, 206);
    assertEquals(head.headers.get("content-length"), "2");
    await head.body?.cancel();
    const post = await serveFile(get({}, "POST"), p);
    assertEquals(post.status, 405);
    assertEquals(post.headers.get("allow"), "GET, HEAD");
    assertEquals((await serveFile(get(), join(dir, "nope"))).status, 404);
    assertEquals((await serveFile(get(), dir)).status, 404);
    const first = await serveFile(get(), p);
    await first.body?.cancel();
    const etag = first.headers.get("etag")!;
    const again = await serveFile(get({ "If-None-Match": etag }), p);
    assertEquals(again.status, 304);
    // A weak validator never satisfies If-Range: the whole file, not a splice.
    const ifRange = await serveFile(
      get({ Range: "bytes=0-1", "If-Range": etag }),
      p,
    );
    assertEquals(ifRange.status, 200);
    assertEquals(await ifRange.text(), "0123456789abcdefghij");
  });
});

Deno.test({
  name: "serveFile: a cancelled body closes the file",
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    const fds = () => [...Deno.readDirSync("/proc/self/fd")].length;
    await withFile("a.bin", async (p) => {
      const before = fds();
      const r = await serveFile(get({ Range: "bytes=2-" }), p);
      // Open while the body is pending: the file, plus at times a second
      // descriptor for the first read already in flight (measured 43 or 44).
      assert(fds() > before, "the file is open while its body is pending");
      await r.body!.cancel();
      // A read already in flight finishes before the descriptor goes (Deno
      // closes it when that op returns — measured: gone within a tick or two).
      for (let i = 0; i < 100 && fds() !== before; i++) {
        await new Promise((res) => setTimeout(res, 10));
      }
      assertEquals(fds(), before);
    });
  },
});

Deno.test("serveFile: a name no file can have is 404, not a 500 naming the path", async () => {
  await withFile("a.txt", async (p, dir) => {
    const loop = join(dir, "loop");
    await Deno.symlink(join(dir, "loop2"), loop, { type: "file" }); // Windows asks
    await Deno.symlink(loop, join(dir, "loop2"), { type: "file" });
    for (
      const bad of [
        join(dir, "x".repeat(300)), // over any filesystem's name limit
        join(dir, "a\0b"), // a NUL byte: Deno throws a TypeError
        loop, // a symlink cycle
        join(p, "x"), // a path through a file
        ...(Deno.build.os === "windows" ? [join(dir, "NUL")] : []), // a device
      ]
    ) assertEquals((await serveFile(get(), bad)).status, 404, bad);
    // A device NAME with an extension is an ordinary file on Windows 11
    // (measured: `aux.txt`, `con.json`, `nul.txt`) — served, never a 404.
    for (const name of ["aux.txt", "con.json"]) {
      await Deno.writeTextFile(join(dir, name), "x");
      const r = await serveFile(get(), join(dir, name));
      assertEquals([r.status, await r.text()], [200, "x"], name);
    }
  });
});

Deno.test("serveFile: no-transform — a resumed download never glues raw bytes onto a gzip start", async () => {
  await withFile("a.txt", async (p) => {
    const r = await serveFile(get(), p);
    await r.body?.cancel();
    assert(/\bno-transform\b/.test(r.headers.get("cache-control") ?? ""));
  });
});

Deno.test("serveFile: the file is closed with its last byte — a client that has them all never asks again", async () => {
  // A client reads by Content-Length and stops: the stream closed the file
  // only on a NEXT pull, which never came, so it stayed open until the
  // connection went (a loaded suite run saw it as a leak).
  await withFile("a.bin", async (p) => {
    const open = Deno.open;
    let closed = false;
    Deno.open = async (...a: Parameters<typeof Deno.open>) => {
      const f = await open(...a);
      const close = f.close.bind(f);
      f.close = () => {
        closed = true;
        close();
      };
      return f;
    };
    try {
      const r = await serveFile(get(), p);
      const reader = r.body!.getReader();
      let got = 0;
      while (got < BYTES.byteLength) {
        got += (await reader.read()).value!.byteLength;
      }
      assertEquals(closed, true, "open after its last byte was read");
      await reader.cancel();
    } finally {
      Deno.open = open;
    }
  });
});
