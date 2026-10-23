// A server stop must not show its clients a reset.
//
// Shutdown's `destroyAll` resets every cell to its declared initial state
// after the final persist, while the sockets are still open. That reset was
// broadcast: on every stop or restart each connected page blanked to initial
// state (a zero counter, an empty list) and kept showing it while the server
// was down — the disk still held the data, the screen said it was gone.
// Measured in headless Chromium: `n` went 1 → 0 the moment the server got
// SIGTERM. `app.cells.disable`'s reset is a live write and still broadcasts.
import { assertEquals } from "@std/assert";
import { dec } from "../src/protocol/envelope.ts";
import { cell } from "../src/state/cell.ts";
import { testServer } from "../src/testing/server-test.ts";

const counter = cell("srnb-counter", {
  state: { n: 0 },
  methods: {
    inc(s) {
      s.n++;
    },
  },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every `n` the socket was told, in order: full states and patches. */
function seenN(frames: string[]): number[] {
  const out: number[] = [];
  for (const raw of frames) {
    const f = dec(raw) as { t?: string; d?: unknown } | null;
    if (f?.t === "state") {
      const n = (f.d as Record<string, { n?: number }>)["srnb-counter"]?.n;
      if (typeof n === "number") out.push(n);
    } else if (f?.t === "patches" || f?.t === "$p") {
      const m = JSON.stringify(f.d).match(/"path":\["n"\],"value":(\d+)/);
      if (m) out.push(Number(m[1]));
    }
  }
  return out;
}

Deno.test("shutdown: the cell reset on the way out is not broadcast to clients", async () => {
  const srv = await testServer({ cells: [counter] });
  const ws = new WebSocket(srv.url.replace(/^http/, "ws") + "/ws");
  const frames: string[] = [];
  ws.onmessage = (e) => frames.push(String(e.data));
  const closed = new Promise((r) => ws.onclose = r);
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("ws failed to open"));
    });
    await counter.inc();
    const deadline = Date.now() + 3000;
    while (!seenN(frames).includes(1) && Date.now() < deadline) await sleep(10);
    assertEquals(seenN(frames).at(-1), 1, "the write reached the client");
    await sleep(300); // past the broadcast throttle window, as a real app is
  } finally {
    await srv.close();
  }
  await closed;
  assertEquals(
    seenN(frames).at(-1),
    1,
    `the last value the client was shown must be the real one, got ${
      JSON.stringify(seenN(frames))
    }`,
  );
});
