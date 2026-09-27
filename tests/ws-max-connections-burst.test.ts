// `maxConnections` holds against a BURST of handshakes, not only a trickle.
//
// The ceiling counted open sockets, and a socket is counted only at `onopen` —
// after the upgrade response went out. Every handshake of a concurrent burst
// passed the check before any of them opened: measured, 20 simultaneous
// connects against `maxConnections: 5` all opened. A reconnect storm after a
// restart (or one peer opening sockets in parallel) walked straight past the
// ceiling the docs call server-wide.
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("ws: maxConnections caps a concurrent burst of handshakes", async () => {
  const port = freePort();
  const dir = await tempDir("aio-ws-burst-");
  const app = await aio.run({
    cells: [cell("burst_c", { state: { n: 0 }, methods: {} })],
    appId: "test-ws-max-conn-burst",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: dir,
    maxConnections: 5,
  });
  const socks: WebSocket[] = [];
  try {
    const outcomes = await Promise.all(
      Array.from(
        { length: 20 },
        () =>
          new Promise<"open" | "refused">((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
            socks.push(ws);
            ws.onopen = () => resolve("open");
            ws.onerror = () => resolve("refused");
          }),
      ),
    );
    assertEquals(outcomes.filter((o) => o === "open").length, 5);

    // A refused burst leaves no residue: closing the five frees five slots.
    await Promise.all(
      socks.filter((s) => s.readyState === WebSocket.OPEN).map((s) =>
        new Promise<void>((resolve) => {
          s.onclose = () => resolve();
          s.close();
        })
      ),
    );
    await new Promise((r) => setTimeout(r, 100));
    const again = await Promise.all(
      Array.from(
        { length: 5 },
        () =>
          new Promise<"open" | "refused">((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
            socks.push(ws);
            ws.onopen = () => resolve("open");
            ws.onerror = () => resolve("refused");
          }),
      ),
    );
    assertEquals(again.filter((o) => o === "open").length, 5);
  } finally {
    await Promise.all(
      socks.map((s) =>
        s.readyState === WebSocket.CLOSED ? undefined : new Promise<void>(
          (resolve) => {
            s.onclose = () => resolve();
            s.close();
          },
        )
      ),
    );
    await app.close();
    await dropTempDir(dir);
  }
});
