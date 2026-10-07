// udsRequest's `timeout` bounds each read, not just the gaps between them. It
// used to be checked only BETWEEN reads: a peer that accepts the connection
// and then goes quiet (a wedged app, a handler that never answers) left
// `reader.read()` pending forever, so `am` hung instead of returning the named
// "accepted the connection but never answered the control request (waited
// Nms)" error.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { udsRequest } from "../src/am/am-uds.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { listenLocal, type LocalConn } from "../src/server/local-listen.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";

Deno.test({
  name: "udsRequest: timeout is honoured against a peer that never answers",
}, async () => {
  const dir = await tempDir("uds-timeout-");
  const socketPath = localEndpoint(join(dir, "s.sock"));
  const listener = listenLocal(socketPath);
  const held: LocalConn[] = [];
  const accepting = (async () => {
    for await (const c of listener) held.push(c); // accept, never write
  })().catch(() => {});
  try {
    const timeout = 300;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      udsRequest(socketPath, "/__aio/trojan/state", { method: "GET" }, timeout)
        .then((r) => ({ r })),
      new Promise<"hung">((res) => {
        timer = setTimeout(() => res("hung"), timeout + 3000);
      }),
    ]);
    clearTimeout(timer);
    assert(
      outcome !== "hung",
      `udsRequest(timeout=${timeout}) was still pending ${
        timeout + 3000
      }ms later against a peer that never answers`,
    );
    assert("error" in outcome.r, JSON.stringify(outcome.r));
    assertStringIncludes(outcome.r.error, "never answered");
  } finally {
    for (const c of held) {
      try {
        c.close();
      } catch { /* gone */ }
    }
    listener.close();
    await accepting;
    await localIdle();
    await dropTempDir(dir);
  }
});
