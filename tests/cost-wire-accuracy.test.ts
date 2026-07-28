// The condition this feature was accepted under, in the reporter's words:
//
//   "It must be correct, or not shipped. A cost number that is plausible but
//    wrong is worse than no number, because people act on it — I removed a
//    feature from my own app this month for exactly that reason. So it needs the
//    testMultiClient treatment: real clients, real sockets, and a test asserting
//    the REPORTED bytes match the bytes that actually crossed the wire."
//
// So: a raw WebSocket counts every inbound byte itself, and the number `am cost`
// reports must equal it. Not "within an order of magnitude" — equal, because both
// sides are counting the same frames.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

type S = { cpu: number; history: number[]; label: string };

const hw = cell("cost-hw", {
  state: { cpu: 0, history: [], label: "idle" } as S,
  methods: {
    tick(s: S, v: number) {
      s.cpu = v;
      s.history.push(v);
      if (s.history.length > 30) s.history.shift();
    },
    rename(s: S, l: string) {
      s.label = l;
    },
  },
});

/** A client that counts exactly what it receives, byte for byte. */
async function countingClient(url: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
  let bytes = 0;
  let frames = 0;
  ws.addEventListener("message", (e) => {
    // The server sends strings; measure them the way the wire does.
    bytes += new TextEncoder().encode(String((e as MessageEvent).data))
      .byteLength;
    frames++;
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws failed to open")));
  });
  return {
    ws,
    get bytes() {
      return bytes;
    },
    get frames() {
      return frames;
    },
    close: () => ws.close(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cost(url: string, q = "") {
  const res = await fetch(`${url}/__aio/trojan/cost${q}`);
  // Read the body ONCE: using `await res.text()` as an assertion message
  // consumes it, and the parse below then fails for a reason that has nothing
  // to do with the test.
  const body = await res.text();
  assertEquals(res.status, 200, body);
  return JSON.parse(body);
}

Deno.test("cost: reported wire bytes EQUAL what a real socket received", async () => {
  await using srv = await testServer({ cells: [hw] });
  const client = await countingClient(srv.url);
  try {
    await sleep(80); // initial state frame

    for (let i = 1; i <= 12; i++) {
      await hw.tick(i);
      await sleep(20);
    }
    await sleep(200); // let the last broadcast drain

    const report = await cost(srv.url, "?window=60");
    assertEquals(
      report.wire.totalBytes,
      client.bytes,
      `am cost reported ${report.wire.totalBytes}B; the socket received ` +
        `${client.bytes}B. These count the same frames and must agree exactly.`,
    );
    assertEquals(
      report.wire.frames,
      client.frames,
      "and the frame count must agree too",
    );
    assert(client.bytes > 0, "the test itself must have moved bytes");
  } finally {
    client.close();
  }
});

Deno.test("cost: two surfaces cost twice, and per-client shows the unit price", async () => {
  await using srv = await testServer({ cells: [hw] });
  const a = await countingClient(srv.url);
  const b = await countingClient(srv.url);
  try {
    await sleep(80);
    for (let i = 1; i <= 8; i++) {
      await hw.tick(i);
      await sleep(20);
    }
    await sleep(200);

    const report = await cost(srv.url, "?window=60");
    assertEquals(
      report.wire.totalBytes,
      a.bytes + b.bytes,
      "the total is what BOTH sockets received",
    );
    assertEquals(report.clients, 2);
    // The number that decides "can I afford another window": total ÷ clients.
    const perClient = report.wire.bytesPerSecPerClient;
    const total = report.wire.bytesPerSec;
    assert(
      Math.abs(perClient * 2 - total) < 1,
      `per-client (${perClient}) × 2 should be the total (${total})`,
    );
  } finally {
    a.close();
    b.close();
  }
});

Deno.test("cost: attribution names the key that is actually big", async () => {
  await using srv = await testServer({ cells: [hw] });
  const client = await countingClient(srv.url);
  try {
    await sleep(80);
    // `history` grows to 30 numbers; `label` is one short string written once.
    for (let i = 1; i <= 30; i++) {
      await hw.tick(i);
      await sleep(10);
    }
    await hw.rename("busy");
    await sleep(200);

    const report = await cost(srv.url, "?window=60");
    const cellRow = report.cells.find((c: { cell: string }) =>
      c.cell === "cost-hw"
    );
    assert(cellRow, `cost-hw must appear: ${JSON.stringify(report.cells)}`);
    const keys: { key: string; bytes: number }[] = cellRow.keys;
    assert(keys.length > 0, "keys must be attributed");
    const history = keys.find((k) => k.key === "history" || k.key === "*");
    const label = keys.find((k) => k.key === "label");
    assert(
      history,
      `the growing array must be attributed: ${JSON.stringify(keys)}`,
    );
    if (label) {
      assert(
        history.bytes > label.bytes,
        `the 30-element array (${history.bytes}B) must outweigh one short ` +
          `string (${label.bytes}B) — that ordering IS the decision this tool exists for`,
      );
    }
  } finally {
    client.close();
  }
});

Deno.test("cost: state size is reported next to push cost", async () => {
  await using srv = await testServer({ cells: [hw] });
  try {
    await hw.tick(1);
    await sleep(120);
    const report = await cost(srv.url);
    // "What moves" and "what is there" answer different questions, and aiol's
    // hint ("N state keys across M cells") is about the second.
    assert(
      typeof report.stateBytes["cost-hw"] === "number" &&
        report.stateBytes["cost-hw"] > 0,
      `state size must be present: ${JSON.stringify(report.stateBytes)}`,
    );
  } finally {
    /* server disposed by `await using` */
  }
});

Deno.test("cost: an idle app reports zero, not noise", async () => {
  await using srv = await testServer({ cells: [hw] });
  await sleep(60);
  const report = await cost(srv.url, "?window=60");
  assertEquals(report.wire.totalBytes, 0, "no clients, no pushes, no bytes");
  assertEquals(report.clients, 0);
  assert(
    report.idleCells.includes("cost-hw"),
    "a cell that did nothing is reported as idle rather than omitted — " +
      `got ${JSON.stringify(report.idleCells)}`,
  );
});

Deno.test("cost: --window and --cell narrow the report", async () => {
  await using srv = await testServer({ cells: [hw] });
  const client = await countingClient(srv.url);
  try {
    await sleep(60);
    await hw.tick(1);
    await sleep(150);
    const all = await cost(srv.url, "?window=60");
    assert(all.wire.totalBytes > 0);

    const scoped = await cost(srv.url, "?window=60&cell=cost-hw");
    assertEquals(scoped.cells.map((c: { cell: string }) => c.cell), [
      "cost-hw",
    ]);

    const bad = await fetch(`${srv.url}/__aio/trojan/cost?window=nonsense`);
    assertEquals(bad.status, 400, "a bad window is refused, not silently 60s");
  } finally {
    client.close();
  }
});

Deno.test("cost: acks are NOT counted as full resends", async () => {
  // The bug this test exists for: classifying every non-patch frame as "full"
  // turned a wall of 40-byte acknowledgements into the headline "most frames
  // send the WHOLE state", at 71% — a plausible number that was wrong, about
  // traffic that was mostly acks. Wrong headlines get acted on.
  await using srv = await testServer({ cells: [hw] });
  const client = await countingClient(srv.url);
  try {
    await sleep(80);
    for (let i = 1; i <= 10; i++) {
      await hw.tick(i); // each dispatch acks, and may or may not patch
      await sleep(15);
    }
    await sleep(200);

    const report = await cost(srv.url, "?window=60");
    const k = report.wire.byKind;
    assert(k, "the frame split must be inspectable, not implied");
    assertEquals(
      k.patch + k.full + k.other,
      report.wire.frames,
      "every frame is classified exactly once",
    );
    assert(
      k.other > 0,
      `acks must be seen and separated: ${JSON.stringify(k)}`,
    );
    const pushes = k.patch + k.full;
    if (pushes > 0) {
      assertEquals(
        report.wire.fullResendShare,
        k.full / pushes,
        "the share is of STATE PUSHES — acks are not pushes",
      );
    }
    // …and the total still equals what the socket received, taxonomy or not.
    assertEquals(report.wire.totalBytes, client.bytes);
  } finally {
    client.close();
  }
});
