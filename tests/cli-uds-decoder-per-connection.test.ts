/**
 * The terminal client's UDS link decodes each connection on its own.
 *
 * One streaming `TextDecoder` served every reconnect. A connection that died
 * in the middle of a multi-byte character left its first byte inside that
 * decoder, and the NEXT connection's first frame came out as `U+FFFD` plus
 * the frame — which does not parse, so it was dropped without a word. When
 * that frame is the state snapshot, the client never gets state.
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { connectCliUDS } from "../src/server/cli-client.ts";
import { enc } from "../src/protocol/envelope.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { waitFor } from "./fake-ws.ts";

Deno.test("uds: a connection cut mid-character does not corrupt the next connection's first frame", async () => {
  const dir = await tempDir("aio-uds-dec-");
  const path = join(dir, "a.sock");
  const listener = Deno.listen({ transport: "unix", path });
  const served = (async () => {
    // Connection 1: the first byte of "é" (0xC3 0xA9), then hang up.
    const c1 = await listener.accept();
    const w1 = c1.writable.getWriter();
    await w1.write(new Uint8Array([0xc3]));
    try {
      c1.close();
    } catch { /* client gone */ }
    // Connection 2: a clean snapshot as its first frame.
    const c2 = await listener.accept();
    const w2 = c2.writable.getWriter();
    await w2.write(new TextEncoder().encode(enc("state", { n: 2 }) + "\n"));
    return c2;
  })();
  const cli = connectCliUDS<{ n: number }>(path);
  try {
    await waitFor(
      () => (cli.state as { n?: number } | null)?.n === 2,
      "the second connection's snapshot",
      8000,
    );
    assertEquals((cli.state as { n: number }).n, 2);
  } finally {
    cli.close();
    listener.close();
    const c2 = await served.catch(() => null);
    try {
      c2?.close();
    } catch { /* already closed */ }
    await dropTempDir(dir);
  }
});
