// MAX_BUDGET_RETRIES (8) bounds how often ONE call is re-sent after
// "dropped, retry after N ms" refusals — "so a call cannot wait forever". A
// held re-send that is still in the pacer when the socket closes goes back to
// the offline queue through `_requeuePaced` / `_carryPush`, which keep only
// `action` + `seq` — the `tries` count is dropped, so every reconnect restarts
// the cap at 0 and a server that keeps refusing (and dropping the socket) is
// retried forever instead of the caller getting the refusal.
import { assert } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_BUDGET_RETRIES = 8; // browser-air-transport.ts

Deno.test({
  name:
    "hunt r13: the budget-retry cap is not reset by a socket close while the re-send is held",
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
        socket.onopen = () => socket.send(enc("proto", protoHello()));
        socket.onmessage = (e) => {
          const f = dec(String(e.data));
          if (f?.t !== "action") return;
          const cid = (f.d as { cid?: string }).cid;
          if (typeof cid !== "string") return;
          refusals++;
          // Refused with a long window (the re-send is HELD in the pacer)…
          socket.send(enc("ack", {
            cid,
            ok: false,
            error: "this frame was dropped: over the global budget",
            retryAfterMs: 5_000,
          }));
          // …and the connection drops before the window reopens.
          setTimeout(() => {
            try {
              socket.close();
            } catch { /* closed */ }
          }, 50);
        };
        return response;
      },
    );
    const g = globalThis as Record<string, unknown>;
    g.location = {
      protocol: "http:",
      host: `127.0.0.1:${port}`,
      search: "",
      origin: `http://127.0.0.1:${port}`,
    };
    await import("../src/browser/browser-air-transport.ts");
    const { client, ensureConnected } = await import(
      "../src/browser/browser-protocol.ts"
    );
    const { _registerAck } = await import("../src/browser/browser-ack.ts");
    const sub = await import("../src/browser/protocol-subscription.ts");
    const unsub = sub._subscribe(() => {});
    try {
      ensureConnected();
      for (let i = 0; i < 100 && sockets.length === 0; i++) await sleep(20);
      await sleep(100);
      const cid = crypto.randomUUID();
      let outcome = "pending";
      _registerAck(cid, { deferTimer: true, methodKey: "cap:inc" }).then(
        () => outcome = "resolved",
        (e) => outcome = String(e instanceof Error ? e.message : e),
      );
      client.send({ type: "cap:inc", payload: {}, cid } as { type: string });
      // One refusal per reconnect (~1 s backoff each). With the cap intact,
      // refusal #9 settles the caller; give it two more cycles of slack.
      const deadline = Date.now() + 20_000;
      while (
        outcome === "pending" && refusals <= MAX_BUDGET_RETRIES + 2 &&
        Date.now() < deadline
      ) await sleep(50);
      assert(
        outcome !== "pending",
        `the call was refused ${refusals} times across reconnects and is ` +
          `still being re-sent — the ${MAX_BUDGET_RETRIES}-retry cap reset ` +
          `on every close`,
      );
      assert(
        refusals <= MAX_BUDGET_RETRIES + 1,
        `refused ${refusals} times before settling (cap ${MAX_BUDGET_RETRIES})`,
      );
    } finally {
      unsub();
      for (const s of sockets) {
        try {
          s.close();
        } catch { /* closed */ }
      }
      await sleep(400);
      await server.shutdown();
    }
  },
});
