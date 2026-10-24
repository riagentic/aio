// Observability numbers held against ground truth — each one was plausible
// and wrong (hunt round 3):
//
//  • `aio_broadcast_bytes_total` / `_messages_total` counted only WS state
//    frames, and only with a vitals system: a desktop app (every client on
//    the socket) or `vitals: false` scraped a confident 0 forever.
//  • `am cost` "clients connected" was learned on a broadcast round and never
//    as zero: every client gone, it still said 1 and divided by it.
//  • `stateBytes` (`am cost`) and `cells` (`/__aio/trojan/metrics`) were
//    UTF-16 code units labelled bytes — a third of the truth for CJK text.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { createCostMeter } from "../src/vitals/cost-meter.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const utf8 = (s: string) => new TextEncoder().encode(s).byteLength;

const obs = cell("obs-truth", {
  state: { n: 0, label: "日本語" },
  methods: {
    bump(s) {
      s.n++;
    },
  },
});

/** A WS client that counts the STATE frames it receives, byte for byte. */
async function stateCounter(url: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
  const seen = { bytes: 0, frames: 0, all: 0 };
  ws.addEventListener("message", (e) => {
    const t = String((e as MessageEvent).data);
    seen.all++;
    const kind = /^\{"v":\d+,"t":"([^"]+)"/.exec(t)?.[1];
    if (kind === "state" || kind === "patches") {
      seen.bytes += utf8(t);
      seen.frames++;
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws failed")));
  });
  return { ws, seen };
}

/** Wait until no frame has arrived for 300 ms. */
async function quiet(seen: { all: number }) {
  let last = -1;
  for (let q = 0; q < 3;) {
    await sleep(100);
    q = seen.all === last ? q + 1 : 0;
    last = seen.all;
  }
}

const prom = async (url: string, name: string) => {
  const text = await (await fetch(`${url}/__aio/metrics`)).text();
  const line = text.split("\n").find((l) => l.startsWith(`${name} `));
  assert(line, `${name} missing from:\n${text}`);
  return Number(line.slice(name.length + 1));
};

Deno.test("metrics: broadcast totals equal the state frames a client received", async () => {
  await using srv = await testServer({ cells: [obs] });
  const { ws, seen } = await stateCounter(srv.url);
  try {
    await sleep(80);
    for (let i = 0; i < 10; i++) {
      await obs.bump();
      await sleep(15);
    }
    await quiet(seen);
    assert(seen.frames > 1, "the test must have pushed state");
    assertEquals(
      await prom(srv.url, "aio_broadcast_bytes_total"),
      seen.bytes,
      "the counter must equal the state bytes the only client received",
    );
    assertEquals(
      await prom(srv.url, "aio_broadcast_messages_total"),
      seen.frames,
    );
  } finally {
    ws.close();
  }
});

Deno.test("cost: the meter's lifetime counts state frames on any transport, across reset()", () => {
  const m = createCostMeter();
  m.recordSend(100, "uds-1", "patch");
  m.recordSend(40, "uds-1", "other"); // an ack is not a broadcast
  m.recordSend(500, "ws-1", "full");
  m.reset(); // a counter that resets is not a counter
  m.recordSend(7, "uds-1", "patch");
  assertEquals(m.lifetime(), { bytes: 607, count: 3 });
});

Deno.test("cost: clients connected reads zero once every client has left", async () => {
  await using srv = await testServer({ cells: [obs] });
  const { ws, seen } = await stateCounter(srv.url);
  await sleep(80);
  await obs.bump();
  await quiet(seen);
  ws.close();
  await sleep(200);
  const r = await (await fetch(`${srv.url}/__aio/trojan/cost`)).json();
  const m = await (await fetch(`${srv.url}/__aio/trojan/metrics`)).json();
  assertEquals(r.clients, m.connections, "two routes, one count");
  assertEquals(r.clients, 0);
});

Deno.test("cost + metrics: state sizes are UTF-8 bytes", async () => {
  await using srv = await testServer({ cells: [obs] });
  const state = await (await fetch(`${srv.url}/__aio/trojan/state`)).json();
  const truth = utf8(JSON.stringify(state["obs-truth"]));
  const r = await (await fetch(`${srv.url}/__aio/trojan/cost`)).json();
  const m = await (await fetch(`${srv.url}/__aio/trojan/metrics`)).json();
  assertEquals(r.stateBytes["obs-truth"], truth);
  assertEquals(m.cells["obs-truth"], truth);
});
