// "app not running on port N" is said for a REFUSED connection only.
//
// Since Deno 2.9 a fetch failure is a bare "TypeError: fetch failed" with the
// reason in `e.cause`. Reading the cause brought back the "not running"
// branch for a dead port — and a substring match on "onnect" then also caught
// a LIVE app dropping the socket mid-request (`client error (SendRequest):
// connection closed before message completed`), telling the operator that a
// running app was not running. Both shapes are produced here by real sockets,
// not by hand-written error strings.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fetchError } from "../src/am/am-http.ts";

async function fetchFailure(url: string): Promise<unknown> {
  try {
    const r = await fetch(url);
    await r.body?.cancel();
  } catch (e) {
    return e;
  }
  throw new Error(`fetch to ${url} succeeded — the fixture is wrong`);
}

Deno.test("fetchError: a connection dropped mid-request is NOT 'not running'", async () => {
  // Accepts, reads the request, closes without a reply — a live process.
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  const served = (async () => {
    const c = await l.accept();
    await c.read(new Uint8Array(4096));
    c.close();
  })();
  try {
    const e = await fetchFailure(`http://127.0.0.1:${port}/__aio/health`);
    await served;
    const r = fetchError(e, port);
    assertEquals(r.ok, false);
    const error = r.ok ? "" : r.error;
    assert(!/not running/.test(error), `a live app was called dead: ${error}`);
  } finally {
    l.close();
  }
});

Deno.test("fetchError: a refused connection IS 'not running on port N'", async () => {
  // Bind, learn the port, close: nothing listens there now.
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  const e = await fetchFailure(`http://127.0.0.1:${port}/`);
  const r = fetchError(e, port);
  assertEquals(r.ok, false);
  assertStringIncludes(r.ok ? "" : r.error, `app not running on port ${port}`);
});
