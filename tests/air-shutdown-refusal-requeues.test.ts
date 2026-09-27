// A call the server refuses because it is SHUTTING DOWN (`DISPATCH_CLOSED`,
// `DISPATCH_DRAINING` — "dropped, not applied") is the offline queue's case a
// few milliseconds early: nothing landed, and the socket is about to close.
// The browser rejected it, and a fire-and-forget call (`onClick={() =>
// c.inc()}`) swallows its rejection by design — so a click made in the
// shutdown window of a restart vanished with no trace, while a click made a
// moment later was queued and replayed. Measured on a real server + Chromium:
// 20 clicks across a SIGTERM restart, server ended one short, page silent.
//
// Now held and re-sent like a budget refusal: the server refuses it at the door
// with `retryAfterMs` (its word that nothing ran), the close puts it back in
// the offline queue, the reconnect lands it. A server that stays sealed on an
// open socket still gets the refusal to its caller, after the retry cap.
//
// The CODE alone never re-sends: a DISPATCH_DRAINING raised INSIDE a running
// method (an inner call refused mid-shutdown) follows writes that already
// landed — re-sending it applied them twice.
import { assert, assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name:
    "air transport: a call refused by a shutting-down server is re-sent after the reconnect, not lost",
  async fn() {
    const port = freePort();
    // Per connection: "closing" refuses every call at the door and drops the
    // socket (a SIGTERM'd server), "sealed" refuses at the door and stays
    // open, "inside" fails the call with the code but NO `retryAfterMs` (a
    // method whose inner call hit the drain, its writes landed), "up" applies.
    const modes: ("closing" | "sealed" | "inside" | "up")[] = [
      "up",
      "closing",
      "up",
      "sealed",
      "inside",
    ];
    let conn = 0;
    const applied: string[] = [];
    const refused: string[] = [];
    const sockets: WebSocket[] = [];
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen: () => {} },
      (req) => {
        if (new URL(req.url).pathname !== "/ws") {
          return new Response("not here", { status: 404 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req);
        const mode = modes[Math.min(conn++, modes.length - 1)]!;
        sockets.push(socket);
        socket.onopen = () => socket.send(enc("proto", protoHello()));
        socket.onmessage = (e) => {
          const f = dec(String(e.data));
          if (f?.t !== "action") return;
          const cid = (f.d as { cid?: string }).cid;
          if (typeof cid !== "string") return;
          if (mode === "up") {
            applied.push(cid);
            socket.send(enc("ack", { cid, ok: true }));
            return;
          }
          refused.push(cid);
          socket.send(enc("ack", {
            cid,
            ok: false,
            error: "dispatch after close() — action dropped, not applied",
            code: refused.length % 2 ? "DISPATCH_CLOSED" : "DISPATCH_DRAINING",
            ...(mode === "inside" ? {} : { retryAfterMs: 500 }),
          }));
          if (mode === "closing") {
            setTimeout(() => {
              try {
                socket.close();
              } catch { /* closed */ }
            }, 20);
          }
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
    const call = () => {
      const cid = crypto.randomUUID();
      const out = { cid, outcome: "pending" };
      _registerAck(cid, { deferTimer: true, methodKey: "sd:inc" }).then(
        () => out.outcome = "resolved",
        (e) => out.outcome = String(e instanceof Error ? e.message : e),
      );
      client.send({ type: "sd:inc", payload: {}, cid } as { type: string });
      return out;
    };
    const until = async (ok: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!ok() && Date.now() < end) await sleep(25);
    };
    try {
      ensureConnected();
      await until(() => sockets.length > 0, 5_000);
      const first = call();
      await until(() => first.outcome !== "pending", 5_000);
      assertEquals(first.outcome, "resolved");

      // The server starts shutting down: the next socket frame is refused.
      sockets[0]!.close();
      await until(() => conn >= 2, 10_000);
      await sleep(100);
      const late = call();
      await until(() => late.outcome !== "pending", 15_000);
      assert(refused.includes(late.cid), "the probe never hit the refusal");
      assertEquals(
        late.outcome,
        "resolved",
        "a call refused only because the server was closing must land after " +
          "the restart",
      );
      assertEquals(applied.filter((c) => c === late.cid).length, 1);

      // A server that stays sealed on an OPEN socket: the caller still gets
      // the refusal, once the retry cap is spent — never a call held forever.
      sockets[sockets.length - 1]!.close();
      await until(() => conn >= 4, 10_000);
      await sleep(100);
      const sealed = call();
      await until(() => sealed.outcome !== "pending", 15_000);
      assert(
        sealed.outcome.includes("dispatch after close()"),
        `sealed: ${sealed.outcome}`,
      );
      const tries = refused.filter((c) => c === sealed.cid).length;
      assert(tries > 1 && tries <= 9, `sealed: refused ${tries} times`);

      // The same code WITHOUT `retryAfterMs`: the method ran — its caller is
      // told, and the call is never sent a second time.
      sockets[sockets.length - 1]!.close();
      await until(() => conn >= 5, 10_000);
      await sleep(100);
      const inside = call();
      await until(() => inside.outcome !== "pending", 15_000);
      assert(inside.outcome.includes("dispatch after close()"), inside.outcome);
      await sleep(1_200);
      assertEquals(
        refused.filter((c) => c === inside.cid).length,
        1,
        "a refusal raised inside a running method was re-sent",
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
