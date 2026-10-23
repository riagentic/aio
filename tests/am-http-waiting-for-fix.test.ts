// A dev session WAITING for a fix (the saved file does not load) holds its
// lock with no server behind it. Every verb that asks the app — `am state`,
// `am dispatch`, `am surface`, `am timeline` — answered "app not running on
// port N", which sent the agent to `am start`, which only then said what was
// wrong. The control-plane request names the wait itself now.
import "./store-sandbox.ts";
import { sleeper } from "./proc-helper.ts";
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";
import { writeLock } from "../src/server/single-instance-lock.ts";
import {
  _resetInstanceVerify,
  trojanGet,
  trojanPost,
} from "../src/am/am-http.ts";

Deno.test("am → app: a session waiting for a fix is named, not 'not running'", async () => {
  const dir = await tempDir("am-http-wait-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  const holder = sleeper();
  const port = freePort();
  try {
    _resetInstanceVerify();
    writeLock({
      appId: "ahw",
      pid: holder.pid,
      port,
      startedAt: Date.now(),
      status: "starting",
      waiting: { reason: "the file saved last does not load", since: 1 },
      cwd: dir,
      home: join(dir, "home"),
    });
    for (
      const r of [
        await trojanGet(port, "state", "ahw"),
        await trojanPost(port, "dispatch", { type: "c:m" }, "ahw"),
      ]
    ) {
      assert(!r.ok);
      assertStringIncludes(r.error, "ahw is waiting for a fix");
      assertStringIncludes(r.error, "the file saved last does not load");
    }
  } finally {
    holder.kill("SIGKILL");
    await holder.status;
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
    await dropTempDir(dir);
  }
});
