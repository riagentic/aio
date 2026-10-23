// `offline: "fail"` — a call made while disconnected rejects AT ONCE and is
// never sent later, on BOTH CLI transports; `"queue"` (the default) keeps
// today's hold-and-replay. Plus `call(cell, method, ...args)` sends exactly the
// frame a bound method sends. Scripted servers, real clients: each connection
// opens, records the actions it receives, and acks them with 7.
import { assert, assertEquals } from "@std/assert";
import {
  _connectCli as connectCli,
  _connectCliUDS as connectCliUDS,
  type CliLink,
  type CliOffline,
} from "../src/server/cli-client.ts";
import { listenLocal } from "../src/server/local-listen.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";

type Conn = { send: (s: string) => void; close: () => void };

function script(refuseFirst = false) {
  const seen: { conn: number; type: string; payload: unknown }[] = [];
  const conns: Conn[] = [];
  return {
    seen,
    conns,
    open(c: Conn) {
      conns.push(c);
      const nth = conns.length;
      c.send(enc("proto", protoHello()));
      c.send(enc("state", {}));
      return (line: string) => {
        const f = dec(line);
        if (f?.t !== "action") return;
        const d = f.d as { cid?: string; type: string; payload: unknown };
        seen.push({ conn: nth, type: d.type, payload: d.payload });
        if (!d.cid) return;
        if (refuseFirst && nth === 1) {
          // The shutdown door: "never ran, re-send once I am back".
          c.send(enc("ack", {
            cid: d.cid,
            ok: false,
            code: "DISPATCH_DRAINING",
            error: "the server is shutting down",
            retryAfterMs: 50,
          }));
          setTimeout(() => c.close(), 20);
          return;
        }
        c.send(enc("ack", { cid: d.cid, ok: true, value: 7 }));
      };
    },
  };
}

type Rig = {
  s: ReturnType<typeof script>;
  cli: CliLink<unknown>;
  stop(): Promise<void>;
};

function viaWs(offline?: CliOffline, refuseFirst = false): Rig {
  const s = script(refuseFirst);
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
      };
      return response;
    },
  );
  const cli = connectCli(`http://127.0.0.1:${port}`, { offline });
  return {
    s,
    cli,
    async stop() {
      cli.close();
      await server.shutdown();
    },
  };
}

function viaUds(offline?: CliOffline, refuseFirst = false): Rig {
  const s = script(refuseFirst);
  const path = localEndpoint(`/tmp/aio-clioff-${crypto.randomUUID()}.sock`);
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
  const cli = connectCliUDS(path, { offline });
  return {
    s,
    cli,
    async stop() {
      cli.close();
      try {
        listener.close();
      } catch { /* closed */ }
      await served.catch(() => {});
      await localIdle();
      await Deno.remove(path).catch(() => {});
    },
  };
}

const until = async (ok: () => boolean, what: string) => {
  const end = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Connect, drop the connection, call while down, let it reconnect. */
async function blip(rig: Rig) {
  const { s, cli } = rig;
  await cli.ready;
  const first = await cli.call("svc", "ping", 1, "a");
  s.conns[0]!.close();
  await until(() => !cli.connected, "the drop");
  const t0 = Date.now();
  const down = cli.call("svc", "ping", 2).then(
    (v) => ({ ok: true, v, ms: Date.now() - t0 }),
    (e: Error) => ({ ok: false, v: e.message, ms: Date.now() - t0 }),
  );
  await until(() => s.conns.length === 2 && cli.connected, "the reconnect");
  // Long enough for a queued call to have been flushed on the new socket.
  await new Promise((r) => setTimeout(r, 200));
  return { first, down: await down, seen: s.seen };
}

for (const [name, make] of [["WS", viaWs], ["UDS", viaUds]] as const) {
  Deno.test(`${name}: offline "fail" rejects a call made while down at once, and never sends it later`, async () => {
    const rig = make("fail");
    try {
      const r = await blip(rig);
      assertEquals(r.first, 7);
      assert(!r.down.ok, `the down call must reject, got ${r.down.v}`);
      assert(String(r.down.v).includes("NOT sent"), String(r.down.v));
      assert(r.down.ms < 1_000, `rejected after ${r.down.ms}ms — not at once`);
      assertEquals(
        r.seen.map((x) => [x.conn, x.type, x.payload]),
        [[1, "svc:ping", { args: [1, "a"] }]],
        "the down call reached the server after the reconnect",
      );
    } finally {
      await rig.stop();
    }
  });

  Deno.test(`${name}: offline "queue" (default) still holds the call and sends it on reconnect`, async () => {
    const rig = make(undefined);
    try {
      const r = await blip(rig);
      assertEquals(r.down, { ok: true, v: 7, ms: r.down.ms });
      assertEquals(r.seen.map((x) => [x.conn, x.type]), [
        [1, "svc:ping"],
        [2, "svc:ping"],
      ]);
    } finally {
      await rig.stop();
    }
  });

  Deno.test(`${name}: offline "fail" — a call refused at the shutdown door rejects, and does not land on the restarted server`, async () => {
    const rig = make("fail", true);
    try {
      await rig.cli.ready;
      const r = await rig.cli.call("svc", "ping").then(
        (v) => `resolved ${v}`,
        (e: Error) => `rejected: ${e.message}`,
      );
      assert(r.startsWith("rejected"), r);
      await until(
        () => rig.s.conns.length === 2 && rig.cli.connected,
        "the reconnect",
      );
      await new Promise((res) => setTimeout(res, 200));
      assertEquals(rig.s.seen.map((x) => x.conn), [1]);
    } finally {
      await rig.stop();
    }
  });

  Deno.test(`${name}: onStatus tells each change — up, down on the drop, up again on the reconnect — and a throwing listener harms nothing`, async () => {
    const rig = make("fail");
    const seen: boolean[] = [];
    rig.cli.onStatus(() => {
      throw new Error("a bad listener");
    });
    const off = rig.cli.onStatus((up) => seen.push(up));
    try {
      await rig.cli.ready;
      await until(() => seen.length === 1, "up");
      rig.s.conns[0]!.close();
      await until(
        () => rig.s.conns.length === 2 && rig.cli.connected,
        "the reconnect",
      );
      await until(() => seen.length === 3, `3 changes (got ${seen})`);
      assertEquals(seen, [true, false, true]);
      off();
      rig.s.conns[1]!.close();
      await until(() => !rig.cli.connected, "the second drop");
      assertEquals(seen.length, 3, "unsubscribed");
    } finally {
      await rig.stop();
    }
  });

  Deno.test(`${name}: offline "fail" — a fire-and-forget send() while down throws`, async () => {
    const rig = make("fail");
    try {
      await rig.cli.ready;
      rig.s.conns[0]!.close();
      await until(() => !rig.cli.connected, "the drop");
      let threw = "";
      try {
        rig.cli.send({ type: "svc:ping", payload: { args: [] } });
      } catch (e) {
        threw = (e as Error).message;
      }
      assert(threw.includes("NOT sent"), `send() must throw, got "${threw}"`);
    } finally {
      await rig.stop();
    }
  });
}

Deno.test("call(): an empty cell or method name throws, naming the shape", async () => {
  const rig = viaWs("fail");
  try {
    await rig.cli.ready;
    let msg = "";
    try {
      await rig.cli.call("", "x");
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes("non-empty"), msg);
  } finally {
    await rig.stop();
  }
});
