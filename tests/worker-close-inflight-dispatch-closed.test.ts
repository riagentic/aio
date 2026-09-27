// CellWorker.close() rejects the calls still in flight at the deadline with a
// PLAIN Error — no `DISPATCH_CLOSED`. `closedWorkerCall` (same file) exists to
// tag a plain close exactly so the scheduler (schedule.ts) classifies it as a
// shutdown and stays quiet; the in-flight twin was left untagged, so a tick
// whose method ignores its abort signal is logged at ERROR on every clean
// stop, and `errorCode(err)` reads undefined for a caller.
import { assertEquals } from "@std/assert";
import { createCellWorker } from "../src/server/cell-worker.ts";
import { registerCall } from "../src/state/cell-impl.ts";
import { errorCode } from "../src/protocol/envelope.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("cell worker: close() settles in-flight calls with DISPATCH_CLOSED, like a call after close", async () => {
  const dir = await tempDir("aio-hunt-r7-wclose-");
  // A worker that handshakes and acks `close` (as the real host does after its
  // 800ms drain) but never answers the call — a method that ignored its
  // abort signal.
  const entry = `${dir}/stub-worker.ts`;
  await Deno.writeTextFile(
    entry,
    `self.onmessage = (ev) => {
  const m = ev.data;
  if (m.t === "init") self.postMessage({ t: "ready", cell: "wclose" });
  else if (m.t === "close") self.postMessage({ t: "closed" });
};
`,
  );
  const w = createCellWorker({ __aio: { id: "wclose" } } as never, {
    entry: new URL(`file://${entry}`),
    initialState: () => ({}),
    prod: false,
    freezeState: false,
    applyPatches: () => {},
    runEffect: () => {},
  } as never);
  try {
    await w.ready();
    // A sync method (transport promise) and an async one (registry callId).
    const syncCall = w.call({ type: "wclose:tick", payload: {} } as never);
    let syncErr: unknown;
    syncCall.catch((e) => syncErr = e);
    // The async caller awaits the REAL call registry, which the worker
    // settles by callId (cell-impl's resolveCall).
    const callId = `wclose-${crypto.randomUUID()}`;
    let asyncErr: unknown;
    const awaited = registerCall(callId).catch((e) => asyncErr = e);
    void w.call(
      { type: "wclose:poll", payload: { _callId: callId } } as never,
    );
    await w.close();
    await Promise.resolve();

    // Control: a call AFTER close is tagged DISPATCH_CLOSED.
    let afterErr: unknown;
    await w.call({ type: "wclose:tick", payload: {} } as never).catch((e) =>
      afterErr = e
    );
    assertEquals(errorCode(afterErr), "DISPATCH_CLOSED");

    assertEquals(
      errorCode(syncErr),
      "DISPATCH_CLOSED",
      `in-flight call rejected by close() with: ${syncErr}`,
    );
    await awaited;
    assertEquals(
      errorCode(asyncErr),
      "DISPATCH_CLOSED",
      `in-flight ASYNC call rejected by close() with: ${asyncErr}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});
