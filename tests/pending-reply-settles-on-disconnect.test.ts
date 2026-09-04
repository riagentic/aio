// A control request to a client that DISCONNECTS must be answered by the
// disconnect, not by the 5-second clock.
//
// `am surface N`, `am trigger N …` and `am client N` register a pending reply
// keyed by the connection and wait `CLIENT_REPLY_TIMEOUT_MS` for it. Neither
// transport touched that entry when the connection went away, so a window
// that closed mid-request (a reload, a crash, a tab the user shut) left the
// caller waiting the whole ceiling — and then handed it the timeout's
// diagnosis, which names three causes ("the window is not VISIBLE … its main
// thread really is busy … a headless client") and not the one that happened.
// A field report lost two debugging passes to that very message; sending
// someone down it for a client that no longer exists is worse.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createWsManager } from "../src/server/server-ws.ts";
import {
  CLIENT_REPLY_TIMEOUT_MS,
  createUDSListener,
} from "../src/server/uds.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Well under the reply ceiling: a disconnect must answer long before it. */
const PROMPT_MS = Math.min(1000, CLIENT_REPLY_TIMEOUT_MS / 2);

Deno.test("ws: a pending control reply settles when its client disconnects", async () => {
  const counter = { value: 0 };
  const mgr = createWsManager({
    dispatch: () => {},
    getUIState: () => ({ c: { n: 1 } }),
    debug: () => {},
    prod: false,
    clientCounter: counter,
    bootId: "b",
  });
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => mgr.handleWs(req),
  );
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws error"));
    });
    // The client never answers `get-state` — it is about to go away.
    await wait(50);
    const idx = [...mgr.connections.values()][0]!.index;
    const r = mgr.sendToWsClient(idx, enc("get-state"));
    assert(r.found);
    const started = Date.now();
    ws.close();
    const res = await Promise.race([
      r.promise.then((resp) => resp.json()),
      wait(PROMPT_MS).then(() => "still waiting"),
    ]);
    assert(
      res !== "still waiting",
      `the reply was still pending ${PROMPT_MS}ms after the client closed — ` +
        `the caller is left to the ${CLIENT_REPLY_TIMEOUT_MS}ms clock`,
    );
    const body = res as { error?: string };
    assert(typeof body.error === "string", JSON.stringify(body));
    assert(
      /disconnect/i.test(body.error),
      `the reason must be the disconnect, not the visibility diagnosis: ${body.error}`,
    );
    assert(Date.now() - started < PROMPT_MS);
    assertEquals(mgr.pendingClientState.size, 0, "and the entry is gone");
  } finally {
    mgr.shutdown();
    await server.shutdown();
  }
});

Deno.test("uds: a pending control reply settles when its client disconnects", async () => {
  const socketPath = join(
    await tempDir("aio-pending-reply-settles-on-disconnect-"),
    "pending-gone.sock",
  );
  const uds = createUDSListener(
    socketPath,
    () => ({ c: { n: 1 } }),
    () => {},
    () => {},
  );
  await wait(30);
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const reader = conn.readable.getReader();
  (async () => {
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch { /* closed */ }
  })();
  await wait(50);
  try {
    const idx = uds.clients()[0]!.index;
    const p = uds.requestClientState(idx);
    const started = Date.now();
    conn.close();
    const res = await Promise.race([
      p,
      wait(PROMPT_MS).then(() => "still waiting"),
    ]);
    assert(
      res !== "still waiting",
      `the reply was still pending ${PROMPT_MS}ms after the peer closed`,
    );
    const body = res as { error?: string };
    assert(typeof body.error === "string", JSON.stringify(body));
    assert(/disconnect/i.test(body.error), body.error);
    assert(Date.now() - started < PROMPT_MS);
  } finally {
    uds.shutdown();
  }
});
