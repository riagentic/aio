// Wine rig — the HOST half, run as `wine deno.exe run -A --unstable-ffi host.ts`.
//
// Two named pipes, exactly the shape the app opens on Windows:
//   <pipe>       NDJSON echo — every line comes back as {"echo":<line>}
//   <pipe>-http  HTTP/1.1 over the pipe via serveHttpOverLocal:
//                  GET  /big        20 MB random body, streamed in 64 KB chunks
//                  GET  /big.sha256 {"length","sha256"} of that body
//                  POST /echo       the request body, byte for byte
// Prints `READY <pipe> <httpPipe>` once both listeners are up. Anything that
// throws is printed as `HOST ERROR <message>` — with the Win32 call and code
// the implementation names — and exits 1.
import {
  listenLocal,
  type LocalConn,
} from "../../../src/server/local-listen.ts";
import { serveHttpOverLocal } from "../../../src/server/http-over-conn.ts";

const rand = crypto.randomUUID().slice(0, 8);
const pipe = `\\\\.\\pipe\\aio-test-${rand}`;
const httpPipe = `${pipe}-http`;
const enc = new TextEncoder();

const CHUNK = 64 * 1024;
const BIG = 20 * 1024 * 1024;
const big = new Uint8Array(BIG);
for (let o = 0; o < BIG; o += CHUNK) {
  crypto.getRandomValues(big.subarray(o, Math.min(o + CHUNK, BIG)));
}
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const bigSha = hex(await crypto.subtle.digest("SHA-256", big));

async function echo(conn: LocalConn): Promise<void> {
  const w = conn.writable.getWriter();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of conn.readable) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        await w.write(enc.encode(`{"echo":${line}}\n`));
      }
    }
    await w.close().catch(() => {});
  } catch (e) {
    console.error(`HOST CONN ERROR ${(e as Error).message}`);
  } finally {
    conn.close();
  }
}

try {
  const ndjson = listenLocal(pipe);
  (async () => {
    for await (const conn of ndjson) echo(conn);
  })().catch((e) => {
    console.error(`HOST ERROR accept: ${(e as Error).message}`);
    Deno.exit(1);
  });

  const http = listenLocal(httpPipe);
  serveHttpOverLocal(http, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/big") {
      let o = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (o >= BIG) return c.close();
          c.enqueue(big.subarray(o, Math.min(o + CHUNK, BIG)));
          o += CHUNK;
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
          "x-content-type-options": "nosniff",
          "x-aio-rig": "big",
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/big.sha256") {
      return Response.json({ length: BIG, sha256: bigSha });
    }
    if (req.method === "POST" && url.pathname === "/echo") {
      const b = new Uint8Array(await req.arrayBuffer());
      return new Response(b, {
        headers: {
          "content-type": req.headers.get("content-type") ??
            "application/octet-stream",
          "content-length": String(b.length),
          "x-content-type-options": "nosniff",
        },
      });
    }
    return new Response("not found", { status: 404 });
  });

  console.log(`READY ${pipe} ${httpPipe}`);
} catch (e) {
  console.error(`HOST ERROR ${(e as Error).stack ?? e}`);
  Deno.exit(1);
}

// Stay alive until the runner kills us.
await new Promise(() => {});
