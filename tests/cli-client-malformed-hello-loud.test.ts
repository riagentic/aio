// The CLI twin of proto-malformed-hello-loud: a server hello connectCli cannot
// parse skipped the version gate in silence (`if (!theirs) return;`) and the
// client went on trading frames with a peer it never checked. It now stops,
// as a version mismatch does: the socket closes with the mismatch code.
import { assertEquals } from "@std/assert";
import { connectCli } from "../src/server/cli-client.ts";
import { enc } from "../src/protocol/envelope.ts";
import { PROTOCOL_MISMATCH_CLOSE_CODE } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name: "connectCli: an unreadable server hello closes as a mismatch does",
  async fn() {
    const port = freePort();
    const closes: number[] = [];
    let opens = 0;
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        if (new URL(req.url).pathname !== "/ws") {
          return new Response("not here", { status: 404 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onopen = () => {
          opens++;
          socket.send(enc("proto", { v: "3", min: 3 })); // v as a string
          socket.send(enc("state", { x: { n: 0 } }));
        };
        socket.onclose = (e) => closes.push(e.code);
        return response;
      },
    );
    const cli = connectCli(`http://127.0.0.1:${port}`, {
      readyTimeoutMs: 5_000,
    });
    cli.ready.catch(() => {});
    try {
      for (let i = 0; i < 100 && closes.length === 0; i++) await sleep(20);
      assertEquals(closes, [PROTOCOL_MISMATCH_CLOSE_CODE]);
      await sleep(1_600); // past the first reconnect backoff (1 s ±20%)
      assertEquals(opens, 1, "a mismatch stops the reconnect loop");
    } finally {
      cli.close();
      await server.shutdown();
    }
  },
});
