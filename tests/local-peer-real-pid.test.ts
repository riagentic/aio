// The pid the local-peer gate judges is the KERNEL's answer for the process
// on the other end — on a named pipe, `GetNamedPipeClientProcessId` of the
// accepted instance. The gate's own tests hand it an identity; this one asks
// the transport for a real client's.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { listenLocal } from "../src/server/local-listen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { localEndpoint } from "./local-endpoint-helper.ts";

const LISTEN = new URL("../src/server/local-listen.ts", import.meta.url).href;

Deno.test({
  name:
    "local peer: an accepted connection names its client's pid — the kernel's, not this process's",
  ignore: Deno.build.os !== "windows", // the pipe's own query; the unix backend's is tests/local-peer-http.test.ts
  async fn() {
    const dir = await tempDir("aio-peer-pid-");
    const path = localEndpoint(join(dir, "p.sock"));
    const l = listenLocal(path, { peer: true });
    const client = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { connectLocal } from ${JSON.stringify(LISTEN)};
const c = await connectLocal(${JSON.stringify(path)});
for await (const _ of c.readable) { /* until the server closes */ }
c.close();`,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "inherit",
    }).spawn();
    try {
      const { value: conn } = await l[Symbol.asyncIterator]().next();
      assert(conn, "no connection was accepted");
      const peer = conn.peerIdentity?.();
      assertEquals(peer?.pid, client.pid);
      assert(peer?.pid !== Deno.pid);
      conn.close();
      l.close();
      assertEquals((await client.status).code, 0);
    } finally {
      try {
        client.kill("SIGKILL");
      } catch { /* aio-ok: it ended when the server closed */ }
      await dropTempDir(dir);
    }
  },
});
