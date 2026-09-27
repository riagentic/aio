// The CLI twin of air-retry-cap-survives-close: CLI_MAX_BUDGET_RETRIES (8)
// bounds how often ONE call is re-sent after "dropped, retry after N ms"
// refusals. A re-send still held in the pacer when the socket closes goes back
// to the offline queue as a bare action; without `_triesOf` its count was lost
// there, so the cap restarted at 0 on every reconnect.
//
// Fast by shape: refusals 1–4 are short and keep the socket, refusal 5 holds
// the re-send and drops the socket, and after the one reconnect every refusal
// is short again. Cap intact → the caller is refused at #9. Count reset → it
// takes 5 + 9.
import { assert, assertMatch } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { connectCli } from "../src/server/cli-client.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLI_MAX_BUDGET_RETRIES = 8; // cli-client.ts

Deno.test({
  name:
    "connectCli: the budget-retry cap is not reset by a socket close while the re-send is held",
  async fn() {
    const port = freePort();
    let refusals = 0;
    const sockets: WebSocket[] = [];
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        if (new URL(req.url).pathname !== "/ws") {
          return new Response("not here", { status: 404 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req);
        sockets.push(socket);
        socket.onopen = () => {
          socket.send(enc("proto", protoHello()));
          socket.send(enc("state", { clicap: { n: 0 } }));
        };
        socket.onmessage = (e) => {
          const f = dec(String(e.data));
          if (f?.t !== "action") return;
          const cid = (f.d as { cid?: string }).cid;
          if (typeof cid !== "string") return;
          refusals++;
          const drop = refusals === 5;
          socket.send(enc("ack", {
            cid,
            ok: false,
            error: "this frame was dropped: over the global budget",
            retryAfterMs: drop ? 5_000 : 10,
          }));
          if (drop) {
            setTimeout(() => {
              try {
                socket.close();
              } catch { /* closed */ }
            }, 50);
          }
        };
        return response;
      },
    );
    const counter = cell("clicap", {
      state: { n: 0 },
      methods: {
        inc(s: { n: number }) {
          s.n++;
        },
      },
    });
    const cli = connectCli<Record<string, { n: number }>>(
      `http://127.0.0.1:${port}`,
      { readyTimeoutMs: 10_000 },
    );
    try {
      await cli.ready;
      cli.bind(counter as unknown as CellDef);
      let outcome = "pending";
      (counter as unknown as { inc(): Promise<unknown> }).inc().then(
        () => outcome = "resolved",
        (e) => outcome = String(e instanceof Error ? e.message : e),
      );
      const deadline = Date.now() + 15_000;
      while (
        outcome === "pending" && refusals <= CLI_MAX_BUDGET_RETRIES + 6 &&
        Date.now() < deadline
      ) await sleep(20);
      assert(sockets.length >= 2, "precondition: the client reconnected");
      assertMatch(outcome, /dropped/, "the caller gets the server's refusal");
      assert(
        refusals <= CLI_MAX_BUDGET_RETRIES + 1,
        `refused ${refusals} times before settling (cap ` +
          `${CLI_MAX_BUDGET_RETRIES}) — the cap reset on the close`,
      );
    } finally {
      cli.close();
      for (const s of sockets) {
        try {
          s.close();
        } catch { /* closed */ }
      }
      await sleep(200);
      await server.shutdown();
    }
  },
});
