// tests/sync/op-over-frame-limit.test.ts — a sync op too big for the server's
// frame limit is refused aloud, never queued to wedge the cell.
//
// The server drops a frame over `wsLimits.maxMessageBytes` unread. A sync op
// bigger than that (a pasted image in a synced note) resolved the caller as
// success, was never acked, and went out first in every catch-up: each one
// dropped, the watchdog asked again, and the cell took no peer change and
// confirmed none of its own, for good.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createNet, type State } from "./_net.ts";
import { normalizeSyncConfig } from "../../src/sync/types.ts";
import {
  parseProtoHello,
  rememberPeerHello,
} from "../../src/protocol/protocol-version.ts";

const CELL = "notes";
const LIMIT = 100_000;
const apply = (s: State, action: string, payload: unknown): State =>
  action === "add"
    ? {
      ...s,
      items: [...(s.items as string[]), (payload as string).slice(0, 8)],
    }
    : s;

/** The client's outbox drops what the server would drop unread. */
function serverDrops(c: { outbox: string[] }): void {
  c.outbox.push = function (this: string[], ...m: string[]) {
    for (const x of m) {
      if (x.length <= LIMIT) Array.prototype.push.call(this, x);
    }
    return this.length;
  };
}

Deno.test("an op over the advertised frame limit rejects its call and queues nothing", async () => {
  rememberPeerHello(parseProtoHello({ v: 3, min: 3, maxMessageBytes: LIMIT })!);
  const net = createNet({ cell: CELL, initial: () => ({ items: [] }), apply });
  try {
    const tab = net.addClient("tab");
    serverDrops(tab);
    await tab.engine.requestSync();
    await net.pump();
    await assertRejects(
      () =>
        tab.engine.handleLocalAction(
          CELL,
          "add",
          "big_____" + "x".repeat(LIMIT),
        ),
      Error,
      "frame limit",
    );
    assertEquals((await tab.buffer.getUnconfirmed(CELL)).length, 0);
    assertEquals(tab.view().items, []);
  } finally {
    await net.close();
    rememberPeerHello({ v: 3, min: 3 });
  }
});

Deno.test("a queued op over the limit is refused at reconnect, and the cell syncs on", async () => {
  rememberPeerHello({ v: 3, min: 3 }); // made offline: no limit known yet
  const net = createNet({
    cell: CELL,
    initial: () => ({ items: [] }),
    apply,
    engine: { catchupTimeoutMs: 50 },
  });
  try {
    const rejected: string[] = [];
    const tab = net.addClient("tab", undefined, {
      cells: {
        [CELL]: {
          ...normalizeSyncConfig(true),
          onRejected: (r) => void rejected.push(r.reason),
        },
      },
    });
    const peer = net.addClient("peer");
    serverDrops(tab);
    await tab.engine.requestSync();
    await peer.engine.requestSync();
    await net.pump();
    tab.online = false;
    tab.engine.setOnline(false);
    await tab.engine.handleLocalAction(
      CELL,
      "add",
      "big_____" + "x".repeat(LIMIT),
    );
    await tab.engine.handleLocalAction(CELL, "add", "small___");

    rememberPeerHello(
      parseProtoHello({ v: 3, min: 3, maxMessageBytes: LIMIT })!,
    );
    tab.online = true;
    tab.engine.setOnline(true);
    await peer.engine.handleLocalAction(CELL, "add", "peer____");
    for (let i = 0; i < 10; i++) {
      await net.pump(40);
      if ((await tab.buffer.getUnconfirmed(CELL)).length === 0) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assertEquals(net.live().items, ["peer____", "small___"]);
    assertEquals(tab.confirmed().items, ["peer____", "small___"]);
    assertEquals(tab.view().items, ["peer____", "small___"]);
    assertEquals((await tab.buffer.getUnconfirmed(CELL)).length, 0);
    assertEquals(rejected.length, 1);
    assert(rejected[0]?.startsWith("too-large"), rejected[0]);
  } finally {
    await net.close();
    rememberPeerHello({ v: 3, min: 3 });
  }
});

Deno.test("a catch-up request over the limit with no op in it refuses no op — small offline changes are kept", async () => {
  rememberPeerHello({ v: 3, min: 3 });
  const net = createNet({ cell: CELL, initial: () => ({ items: [] }), apply });
  try {
    const rejected: string[] = [];
    const tab = net.addClient("tab", undefined, {
      cells: {
        [CELL]: {
          ...normalizeSyncConfig(true),
          onRejected: (r) => void rejected.push(r.reason),
        },
      },
    });
    await tab.engine.requestSync();
    await net.pump();
    tab.online = false;
    tab.engine.setOnline(false);
    await tab.engine.handleLocalAction(CELL, "add", "small___");
    // A limit no request can fit, even empty: no op is to blame. (A hello
    // floors its limit at 1 KiB; many sync cells make an empty request that
    // big — set directly, the one cell here stands in for them.)
    rememberPeerHello({ v: 3, min: 3, maxMessageBytes: 10 });
    tab.online = true;
    tab.engine.setOnline(true);
    await tab.engine.requestSync();
    assertEquals(rejected, []);
    assertEquals((await tab.buffer.getUnconfirmed(CELL)).length, 1);
  } finally {
    await net.close();
    rememberPeerHello({ v: 3, min: 3 });
  }
});
