// Differential: a call the server refuses AT ITS SHUTDOWN DOOR (ack `ok:false`
// with `retryAfterMs` — "never ran, re-send once I am back") is held and
// re-sent by BOTH CLI clients, and lands on the restarted server.
//
// `connectCli` (WS) has done this since the door learned to say so;
// `connectCliUDS` rejected the call on that ack — the same restart, the same
// frames, and the socket client's `await cell.m()` failed with
// DISPATCH_DRAINING where the WS client's resolved. Scripted servers, real
// clients: connection #1 refuses at the door and hangs up (the server
// finishing its close), connection #2 runs the call.
import { assertEquals } from "@std/assert";
import { connectCli, connectCliUDS } from "../src/server/cli-client.ts";
import { listenLocal } from "../src/server/local-listen.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { cell } from "../src/state/cell-create.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";

type Peer = { send: (s: string) => void; close: () => void };

/** The server's script, shared by both transports: what each connection
 *  answers to an action, by connection number. Returns the action count. */
function script() {
  const seen: number[] = [];
  /** What each connection did, for a red's message. */
  const events: string[] = [];
  let conns = 0;
  return {
    seen,
    events,
    open(peer: Peer) {
      const nth = ++conns;
      events.push(`#${nth} open`);
      peer.send(enc("proto", protoHello()));
      peer.send(enc("state", {}));
      return (line: string) => {
        const f = dec(line);
        events.push(`#${nth} ${f?.t}`);
        if (f?.t !== "action") return;
        const cid = (f.d as { cid?: string }).cid;
        if (typeof cid !== "string") return;
        seen.push(nth);
        if (nth === 1) {
          peer.send(enc("ack", {
            cid,
            ok: false,
            code: "DISPATCH_DRAINING",
            error: "the server is shutting down — this call was refused " +
              "before it ran (not applied); re-send it once the server is back",
            retryAfterMs: 50,
          }));
          setTimeout(() => peer.close(), 20);
        } else {
          peer.send(enc("ack", { cid, ok: true, value: 7 }));
        }
      };
    },
  };
}

let _n = 0;
function box() {
  return cell(`clidoor_${_n++}`, {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  }) as unknown as CellDef & { bump: () => Promise<unknown> };
}

type Run = { result: unknown; seen: number[]; events: string[] };

async function viaWs(): Promise<Run> {
  const s = script();
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response("not here", { status: 404 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => {
        const on = s.open({
          send: (m) => socket.send(m),
          close: () => socket.close(),
        });
        socket.onmessage = (e) => on(String(e.data));
        socket.onclose = (e) => s.events.push(`closed (${e.code} ${e.reason})`);
      };
      return response;
    },
  );
  const cli = connectCli(`http://127.0.0.1:${port}`);
  try {
    await cli.ready;
    const b = box();
    cli.bind(b);
    const result = await b.bump().catch((e) => `rejected: ${e.message}`);
    return { result, seen: s.seen, events: s.events };
  } finally {
    cli.close();
    await server.shutdown();
  }
}

async function viaUds(): Promise<Run> {
  const s = script();
  const path = localEndpoint(`/tmp/aio-clidoor-${crypto.randomUUID()}.sock`);
  const listener = listenLocal(path);
  const served = (async () => {
    for await (const conn of listener) {
      const w = conn.writable.getWriter();
      const te = new TextEncoder();
      const on = s.open({
        send: (m) => void w.write(te.encode(m + "\n")).catch(() => {}),
        close: () => {
          try {
            conn.close();
          } catch { /* gone */ }
        },
      });
      (async () => {
        const r = conn.readable.getReader();
        const td = new TextDecoder();
        let buf = "";
        try {
          while (true) {
            const { value, done } = await r.read();
            if (done) break;
            buf += td.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop()!;
            for (const l of lines) if (l) on(l);
          }
        } catch { /* closed */ }
      })();
    }
  })();
  const cli = connectCliUDS(path);
  try {
    await cli.ready;
    const b = box();
    cli.bind(b);
    const result = await b.bump().catch((e) => `rejected: ${e.message}`);
    return { result, seen: s.seen, events: s.events };
  } finally {
    cli.close();
    try {
      listener.close();
    } catch { /* closed */ }
    await served.catch(() => {});
    await localIdle();
    await Deno.remove(path).catch(() => {});
  }
}

Deno.test("cli clients: a call refused at the shutdown door is re-sent after the restart — WS and UDS alike", async () => {
  const ws = await viaWs();
  const uds = await viaUds();
  assertEquals(
    { result: ws.result, seen: ws.seen },
    { result: 7, seen: [1, 2] },
    `the WS client (reference):\n${ws.events.join("\n")}`,
  );
  assertEquals(
    { result: uds.result, seen: uds.seen },
    { result: ws.result, seen: ws.seen },
    `the UDS client must answer as the WS client does:\n${
      uds.events.join("\n")
    }`,
  );
});
