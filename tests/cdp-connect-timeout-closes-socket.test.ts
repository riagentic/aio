// `cdpConnect` gave up on a target that accepted the TCP connection but never
// answered the WebSocket upgrade — and left the socket CONNECTING. The caller
// got its "timed out" error and then the process could not exit: `am shot` /
// `am eval` against a wedged window reported the timeout and hung forever.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

Deno.test("cdp: a connect timeout closes the socket, so the process can exit", async () => {
  const port = freePort();
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  // Accept, read the upgrade request, never answer it.
  const held: Deno.Conn[] = [];
  const serving = (async () => {
    try {
      for await (const c of listener) {
        held.push(c);
        (async () => {
          const buf = new Uint8Array(4096);
          try {
            while ((await c.read(buf)) !== null) { /* swallow */ }
          } catch { /* aio-ok: closed by the test */ }
        })();
      }
    } catch { /* aio-ok: listener closed */ }
  })();
  const cdp = fromFileUrl(new URL("../src/media/cdp.ts", import.meta.url));
  const script = `
    import { cdpConnect } from ${JSON.stringify(cdp)};
    try {
      await cdpConnect("ws://127.0.0.1:${port}/devtools/page/x", 300);
      console.log("connected?!");
    } catch (e) {
      console.log("refused: " + (e instanceof Error ? e.message : e));
    }
  `;
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), 8_000);
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", "--no-check", script],
      stdout: "piped",
      stderr: "piped",
      signal: ac.signal,
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    assertStringIncludes(text, "refused: CDP connect timed out after 300ms");
    assert(
      !ac.signal.aborted,
      "the process must EXIT after the timeout, not hang on the abandoned socket",
    );
    assertEquals(out.code, 0);
  } finally {
    clearTimeout(kill);
    listener.close();
    for (const c of held) {
      try {
        c.close();
      } catch { /* aio-ok: already closed */ }
    }
    await serving;
  }
});
