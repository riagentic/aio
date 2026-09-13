// tests/sync/offline-flush-advertised-limit.test.ts — the reconnect flush sizes
// its frames to the limit the server ADVERTISES, not to the 1 MB default.
//
// The slice budget was a fixed 250 KB, "a quarter of the default — room for an
// app that lowered `wsLimits.maxMessageBytes`". An app that lowered it under
// 250 KB (say 100 KB) got every flush frame dropped unread by the server, at
// every reconnect: the same never-delivered queue offline-flush-slices.test.ts
// pins for the default, reachable by one config key. The WS server now sends
// `maxMessageBytes` in its proto hello beside `rate`, and the engine takes a
// quarter of it.
import { assert, assertEquals } from "@std/assert";
import { createNet, type State } from "./_net.ts";
import {
  parseProtoHello,
  rememberPeerHello,
} from "../../src/protocol/protocol-version.ts";
import { dec } from "../../src/protocol/envelope.ts";
import { testServer } from "../../src/testing/server-test.ts";

const CELL = "notes";
const LOWERED_LIMIT = 100_000;
const apply = (s: State, action: string, payload: unknown): State =>
  action === "add"
    ? {
      ...s,
      items: [...(s.items as string[]), (payload as string).slice(0, 8)],
    }
    : s;

Deno.test("hello: maxMessageBytes survives the parser, bounded", () => {
  assertEquals(
    parseProtoHello({ v: 3, min: 3, maxMessageBytes: 100_000 })
      ?.maxMessageBytes,
    100_000,
  );
  for (const bad of [0, -1, 10, Number.NaN, 1e12, "100000"]) {
    assertEquals(
      parseProtoHello({ v: 3, min: 3, maxMessageBytes: bad })?.maxMessageBytes,
      undefined,
      `untrusted ${bad} must not become a slice budget`,
    );
  }
});

Deno.test("a 240 KB offline queue reaches a server whose limit is 100 KB", async () => {
  rememberPeerHello(
    parseProtoHello({ v: 3, min: 3, maxMessageBytes: LOWERED_LIMIT })!,
  );
  const net = createNet({ cell: CELL, initial: () => ({ items: [] }), apply });
  try {
    const tab = net.addClient("tab");
    await tab.engine.requestSync();
    await net.pump();

    tab.online = false;
    tab.engine.setOnline(false);
    const pad = "x".repeat(4000);
    const want: string[] = [];
    for (let i = 0; i < 60; i++) {
      const id = `n${String(i).padStart(4, "0")}___`.slice(0, 8);
      want.push(id);
      await tab.engine.handleLocalAction(CELL, "add", id + pad);
    }

    tab.online = true;
    tab.engine.setOnline(true);
    for (let i = 0; i < 200; i++) {
      // Drop what that server would drop — the frame never arrives.
      tab.outbox = tab.outbox.filter((f) => f.length <= LOWERED_LIMIT);
      await net.pump();
      if ((await tab.buffer.getUnconfirmed(CELL)).length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const biggest = Math.max(...tab.sentLog.map((f) => f.length));
    assert(
      biggest <= LOWERED_LIMIT,
      `every frame fits the advertised limit — the biggest was ${biggest}`,
    );
    assertEquals(net.live().items, want, "server has every write, in order");
    assertEquals((await tab.buffer.getUnconfirmed(CELL)).length, 0);
  } finally {
    await net.close();
    rememberPeerHello({ v: 3, min: 3 });
  }
});

Deno.test("the WS server advertises its frame limit in the proto hello", async () => {
  const { cell } = await import("../../mod.ts");
  const probe = cell("limitprobe", {
    state: { n: 0 },
    visible: "all",
    methods: {},
  });
  const srv = await testServer({
    cells: [probe],
    wsLimits: { maxMessageBytes: LOWERED_LIMIT },
  });
  const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws");
  try {
    const hello = await new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no proto hello")), 5000);
      ws.onmessage = (e) => {
        const f = dec(String(e.data));
        if (f?.t === "proto") {
          clearTimeout(t);
          resolve(f.d);
        }
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("ws error"));
      };
    });
    assertEquals(parseProtoHello(hello)?.maxMessageBytes, LOWERED_LIMIT);
  } finally {
    const closed = new Promise((r) => (ws.onclose = r));
    ws.close();
    await closed;
    await srv.close();
  }
});
