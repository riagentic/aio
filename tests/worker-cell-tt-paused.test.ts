// Paused time travel refuses a `worker: true` cell's call at the door, exactly
// as it refuses the cell beside it.
//
// Worker-cell calls are routed to the worker BEFORE the main dispatch door, so
// the paused check never saw them: the method RAN in the worker (side effects
// and all), its caller was answered with a return value, and the patches it
// streamed home were then refused by the paused door — so the write the caller
// had just been told succeeded existed only in the worker's copy until the
// next re-seed discarded it. A main-isolate cell's call is refused, loudly,
// before anything runs.
import { assertEquals, assertRejects } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { testServer } from "../src/testing/server-test.ts";
import { isolationProbe } from "./fixtures/worker-isolation-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-isolation-app.ts");

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("ws timeout"));
    }, 5000);
    ws.onmessage = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
}

/** The debug panel's own frame; resolves once tt-state reports it applied. */
function panel(ws: WebSocket, cmd: "pause" | "resume"): Promise<void> {
  return new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const f = dec(String(ev.data));
      if (
        f?.t === "tt-state" &&
        (f.d as { paused?: boolean }).paused === (cmd === "pause")
      ) {
        ws.onmessage = null;
        resolve();
      }
    };
    ws.send(enc("tt-cmd", { cmd }));
  });
}

Deno.test("real workers: paused time travel refuses a worker cell's call before it runs", async () => {
  await using srv = await testServer({
    cells: [isolationProbe],
    workers: "real",
    workerEntry: ENTRY,
  });
  const ws = await connect(srv.port);
  try {
    await isolationProbe.take(1);
    const calls = () =>
      (srv.state() as { isolationProbe: { calls: number } }).isolationProbe
        .calls;
    assertEquals(calls(), 1);
    await panel(ws, "pause");
    await assertRejects(() => isolationProbe.take(2), Error, "paused");
    await panel(ws, "resume");
    // The refused call never ran in the worker: its next commit builds on the
    // state the main isolate holds, not on a write nobody kept.
    await isolationProbe.take(3);
    assertEquals(calls(), 2, "the refused call ran in the worker anyway");
  } finally {
    ws.close();
  }
});
