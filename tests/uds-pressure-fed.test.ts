// The vitals per-client bandwidth alarm ("PRESSURE — client … averaging
// N MB/s") was fed by the WS broadcaster only. A desktop app's windows are all
// on UDS, so the alarm could never fire there. The listener now feeds it at
// `sendTo` — state/patch frames only, as the WS path does — and forgets the
// client when it goes.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import { connectLocal } from "../src/server/local-listen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("uds: state frames feed the per-client bandwidth alarm; a disconnect clears it", async () => {
  const dir = await tempDir("uds-pressure-");
  const socketPath = localEndpoint(join(dir, "p.sock"));
  const fed: [string, number][] = [];
  const gone: string[] = [];
  let state = { big: { rows: "x".repeat(2000) } };
  const uds = createUDSListener(
    socketPath,
    () => state,
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      onBroadcast: (id, bytes) => void fed.push([id, bytes]),
      onClientDisconnect: (id) => void gone.push(id),
    },
  );
  const conn = await connectLocal(socketPath);
  const reader = conn.readable.getReader();
  const done = (async () => {
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch { /* aio-ok: closed at teardown */ }
  })();
  try {
    await sleep(100); // handshake: proto, cfg, initial state
    const before = fed.length;
    state = { big: { rows: "y".repeat(2000) } };
    uds.broadcastState(true);
    await sleep(100);
    assert(fed.length > before, `a state push must reach the alarm: ${fed}`);
    const [id, bytes] = fed.at(-1)!;
    assert(bytes > 2000, `bytes are the frame's: ${bytes}`);
    const client = uds.clients()[0] as { id: string };
    assertEquals(id, client.id);

    await reader.cancel();
    conn.close();
    await done;
    await sleep(100);
    assertEquals(gone, [id], "a gone client leaves the alarm's table");
  } finally {
    try {
      conn.close();
    } catch { /* aio-ok: already closed */ }
    uds.shutdown();
    await localIdle();
    await dropTempDir(dir);
  }
});
