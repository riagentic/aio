// The Electron main process's door to the app, run for real (field report §13).
//
// `socketFetch` is the code every `aio://` request goes through in the
// packaged app. Two properties of it froze a real app on Windows:
//
//  • it used Node's GLOBAL agent — `maxSockets: Infinity`, keep-alive — so a
//    page with N `<img src>` opened N connections at once, each holding a
//    pending read on the server;
//  • `<img>` fires `error` at a 404's headers and never reads the body, so
//    the response was never cancelled and the socket stayed open and unread,
//    with the server parked in its drain. 58 of those and the app was gone.
//
// The generated main is CJS text, so this test EVALUATES it — the real
// function, against a real HTTP server on a real unix socket — rather than
// asserting on the source. Windows is the OS the defect belongs to, but the
// mechanism is Node's and reproduces here; the Win32 half is the Wine rig
// (`scripts/wine-pipe.ts`) and the real-VM run.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";
import { tmplSocketFetch } from "../src/electron/electron-shared.ts";

/** The generated `socketFetch`, bound to a socket path. */
function socketFetchOn(sock: string): (
  path: string,
  method?: string,
  headers?: Record<string, string>,
) => Promise<Response> {
  const src = tmplSocketFetch();
  const make = new Function(
    "HTTP_SOCK",
    "HTTP_URL",
    "require",
    `${src}\nreturn socketFetch;`,
  );
  const require = (m: string) => {
    // The generated code requires node builtins by bare name.
    if (m === "http") return nodeHttp;
    if (m === "stream") return nodeStream;
    throw new Error(`unexpected require(${m})`);
  };
  return make(sock, "", require);
}

const nodeHttp = await import("node:http");
const nodeStream = await import("node:stream");

Deno.test({
  name:
    "socketFetch: bounded connections, and a body nobody reads is read here",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false, // aio-ok: node:http keeps its agent's sockets
  sanitizeOps: false, // aio-ok: same
  async fn() {
    const dir = await tempDir("aio-sockfetch");
    const sock = join(dir, "app.sock");
    let live = 0;
    let peak = 0;
    /** Response bodies the SERVER is still holding open — i.e. written into
     *  and never taken. This is the thing that froze the app: on Windows the
     *  server sits in `drain()` (FlushFileBuffers) until the peer reads. */
    let unread = 0;
    const big = new Uint8Array(4 * 1024 * 1024);
    /** A chunked body of `n` bytes that reports when it is done with. */
    const tracked = (n: number) => {
      unread++;
      let o = 0;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        unread--;
      };
      return new ReadableStream<Uint8Array>({
        pull(c) {
          if (o >= n) {
            c.close();
            settle();
            return;
          }
          c.enqueue(big.subarray(o, Math.min(o + 64 * 1024, n)));
          o += 64 * 1024;
        },
        cancel() {
          settle();
        },
      });
    };
    const server = Deno.serve({
      path: sock,
      onListen: () => {},
      handler: (req) => {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/missing")) {
          // What an <img> gets from a route that has nothing: an error with a
          // body, CHUNKED (a streamed Response declares no length) — the
          // shape the frozen app's 58 pending requests had. Chromium fires
          // `error` at the headers and never reads a byte of it.
          return new Response(tracked(256 * 1024), { status: 404 });
        }
        if (url.pathname === "/small") {
          return new Response("hello", {
            headers: { "content-length": "5" },
          });
        }
        // A big streamed body, and a count of how many are open at once.
        live++;
        peak = Math.max(peak, live);
        let o = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (o >= big.length) {
                c.close();
                live--;
                return;
              }
              c.enqueue(big.subarray(o, o + 64 * 1024));
              o += 64 * 1024;
            },
            cancel() {
              live--;
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        );
      },
    });
    const fetchOne = socketFetchOn(sock);
    try {
      // ① 60 error responses that NOBODY READS — the page full of broken
      //    images. Each resolves, and the server is left holding none of
      //    them: an error body is taken here (bounded), because a body that
      //    is never read is a connection the app can never finish with.
      const misses = await Promise.all(
        Array.from({ length: 60 }, (_, i) => fetchOne(`/missing/${i}.png`)),
      );
      for (const r of misses) assertEquals(r.status, 404);
      // Give the server a turn to notice the cancels.
      for (let i = 0; i < 50 && unread > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(
        unread,
        0,
        "every unread error body must be finished with, not left open",
      );
      // …and the app still answers afterwards. This is the assertion the
      // frozen app failed.
      assertEquals((await fetchOne("/small")).status, 200);

      // ② A small declared body is delivered whole.
      const small = await fetchOne("/small");
      assertEquals(await small.text(), "hello");

      // ③ Big bodies still STREAM (nothing is buffered in this process), and
      //    no more than 6 sockets are open at a time however many are asked
      //    for — Chromium's own per-host cap.
      const reads = await Promise.all(
        Array.from({ length: 30 }, async () => {
          const r = await fetchOne("/big");
          assertEquals(r.status, 200);
          let n = 0;
          for await (const c of r.body!) n += c.length;
          return n;
        }),
      );
      assertEquals(reads.length, 30);
      for (const n of reads) assertEquals(n, big.length);
      assert(
        peak <= 6,
        `${peak} concurrent connections — the agent must cap them at 6`,
      );

      // ④ A dropped stream destroys the response rather than leaking it.
      const dropped = await fetchOne("/big");
      await dropped.body!.cancel();
      assertEquals((await fetchOne("/small")).status, 200);
    } finally {
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "socketFetch: a body that is CUT SHORT is never delivered as a 200",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false, // aio-ok: node:http keeps its agent's sockets
  sanitizeOps: false, // aio-ok: same
  async fn() {
    // The buffered branch (a declared-small body) must fail the same way the
    // streaming branch does when the app closes the connection mid-body.
    // The streaming branch errors the stream — the reader sees `aborted`.
    // The buffered branch used to `resolve` whatever HAD arrived, with the
    // original status and the original `content-length`: a truncated module
    // or stylesheet delivered to Chromium as a perfectly good 200, silently.
    //
    // This is not hypothetical on the OS this file belongs to: the pipe's own
    // `drain()` now CLOSES a connection whose peer has not read within
    // DRAIN_TIMEOUT_MS (win-pipe.ts), which is exactly a body cut short.
    const dir = await tempDir("aio-sockfetch-cut");
    const sock = join(dir, "app.sock");
    const listener = Deno.listen({ transport: "unix", path: sock });
    const served = (async () => {
      for await (const conn of listener) {
        void (async () => {
          try {
            await conn.read(new Uint8Array(4096));
            await conn.write(
              new TextEncoder().encode(
                "HTTP/1.1 200 OK\r\ncontent-type: text/javascript\r\n" +
                  "content-length: 1000\r\n\r\n",
              ),
            );
            await conn.write(new TextEncoder().encode("export const a = 1;"));
            conn.close();
          } catch { /* the client hung up first */ }
        })();
      }
    })();
    const fetchOne = socketFetchOn(sock);
    try {
      const res = await fetchOne("/app.js");
      assert(
        res.status !== 200,
        `a response cut short at 19 of 1000 bytes came back as ` +
          `${res.status} — a truncated resource must never look like a ` +
          `complete one`,
      );
      assertEquals(res.status, 502);
      assert(
        (await res.text()).includes("truncated"),
        "the 502 must say the response was truncated",
      );
    } finally {
      listener.close();
      await served.catch(() => {});
    }
  },
});
