// A string that grows must not re-ship itself on every broadcast.
//
// A streamed reply is `s.reply += chunk`. Before the `append` op, every
// broadcast window carried the WHOLE reply as a `replace` — and past the
// full-state threshold, the whole state — so a 10 KB reply streamed in 50
// chunks cost ~50 × 10 KB on the wire. Measured here on a real server with a
// raw WebSocket counting its own inbound bytes (the same meter
// tests/cost-wire-accuracy.test.ts holds `am cost` against), not at the
// patch-generation seam: coalescing, the patch-vs-full decision and the
// envelope all sit between the two, and each could undo the saving.
import { assert, assertEquals } from "@std/assert";
import { dec } from "../src/protocol/envelope.ts";
import { cell } from "../src/state/cell.ts";
import { testServer } from "../src/testing/server-test.ts";

const BASE = "b".repeat(10 * 1024);
const CHUNK = "k".repeat(100);
const ROUNDS = 50;

const chat = cell("apw-chat", {
  state: { reply: BASE, n: 0 },
  methods: {
    stream(s, chunk: string) {
      s.reply += chunk;
      s.n += 1;
    },
  },
});

/** Counts inbound bytes per frame kind AFTER the initial full state. */
async function countingClient(url: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
  const bytes = { patches: 0, state: 0, other: 0 };
  const ops = { append: 0, replace: 0 };
  let n = 0;
  let initial = false;
  ws.addEventListener("message", (e) => {
    const text = String((e as MessageEvent).data);
    const f = dec(text);
    const len = new TextEncoder().encode(text).byteLength;
    if (f?.t === "state" && !initial) {
      initial = true;
      return;
    }
    if (f?.t === "patches") {
      bytes.patches += len;
      for (const op of f.d as { op: string; path: unknown[] }[]) {
        if (op.path.join(".") !== "apw-chat.reply") continue;
        if (op.op === "append") ops.append++;
        else if (op.op === "replace") ops.replace++;
      }
    } else if (f?.t === "state") bytes.state += len;
    else bytes.other += len;
    const d = f?.d as { "apw-chat"?: { n?: number } } | undefined;
    if (f?.t === "state" && typeof d?.["apw-chat"]?.n === "number") {
      n = d["apw-chat"].n;
    } else if (f?.t === "patches") {
      for (
        const op of f.d as { op: string; path: unknown[]; value?: unknown }[]
      ) {
        if (op.path.join(".") === "apw-chat.n") n = op.value as number;
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws failed to open")));
  });
  return {
    bytes,
    ops,
    get n() {
      return n;
    },
    close: () => ws.close(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("append: streaming 50 chunks into a 10 KB string costs the chunks, not the string", async () => {
  await using srv = await testServer({ cells: [chat] });
  const client = await countingClient(srv.url);
  try {
    await sleep(100); // initial state frame
    for (let i = 0; i < ROUNDS; i++) {
      await chat.stream(CHUNK);
      // Past the coalescing window, so every chunk is its own broadcast —
      // the shape a token stream has, and the worst case for the old code.
      await sleep(25);
    }
    const deadline = Date.now() + 3000;
    while (client.n < ROUNDS && Date.now() < deadline) await sleep(10);
    assertEquals(client.n, ROUNDS, "every chunk reached the client");

    const total = client.bytes.patches + client.bytes.state;
    // The old cost: each window re-sent the whole reply — 50 × ≥ 10 KB.
    const oldCost = ROUNDS * BASE.length;
    // Per chunk: the suffix + op/path/envelope overhead + the `n` op. 200 B
    // over the chunk is generous; the point is the bound does not scale with
    // BASE at all.
    const bound = ROUNDS * (CHUNK.length + 200);
    assert(
      total <= bound,
      `${ROUNDS} × ${CHUNK.length} B chunks cost ${total} B on the wire ` +
        `(patches ${client.bytes.patches} B, full states ${client.bytes.state} B) — ` +
        `bound ${bound} B; the old cost was ~${oldCost} B. ` +
        `ops on reply: ${JSON.stringify(client.ops)}`,
    );
    assertEquals(client.bytes.state, 0, "no window fell back to a full state");
    assertEquals(client.ops.replace, 0, "no window re-sent the whole reply");
    assertEquals(client.ops.append, ROUNDS, "one append per chunk");
    console.log(
      `  append wire cost: ${total} B for ${ROUNDS} chunks ` +
        `(old ≈ ${oldCost} B, ${(oldCost / total).toFixed(0)}× less)`,
    );
  } finally {
    client.close();
  }
});
