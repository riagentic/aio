// `am timeline` on a dev session WAITING for a fix: it names the wait, and
// no longer follows it with "— is the app running?", which contradicted it.
import "./store-sandbox.ts";
import { sleeper } from "./proc-helper.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";
import { writeLock } from "../src/server/single-instance-lock.ts";
import { cmdTimeline } from "../src/am/am-cmd-timeline.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

Deno.test("am timeline: a session waiting for a fix is not asked if it runs", async () => {
  const dir = await tempDir("am-timeline-wait-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  const holder = sleeper();
  const port = freePort();
  const realExit = Deno.exit;
  const realLog = console.log;
  const realErr = console.error;
  let out = "";
  let code: number | null = null;
  const EXIT = Symbol("exit");
  try {
    _resetInstanceVerify();
    writeLock({
      appId: "atw",
      pid: holder.pid,
      port,
      startedAt: Date.now(),
      status: "starting",
      waiting: { reason: "the file saved last does not load", since: 1 },
      cwd: dir,
      home: join(dir, "home"),
    });
    console.log = console.error = (...a: unknown[]) => {
      out += a.join(" ") + "\n";
    };
    (Deno as { exit: (c?: number) => never }).exit = (c?: number) => {
      code = c ?? 0;
      throw EXIT;
    };
    try {
      await cmdTimeline([], { app: "atw", port, json: true } as GlobalFlags);
    } catch (e) {
      if (e !== EXIT) throw e;
    }
  } finally {
    Deno.exit = realExit;
    console.log = realLog;
    console.error = realErr;
    holder.kill("SIGKILL");
    await holder.status;
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
    await dropTempDir(dir);
  }
  assertEquals(code, 1, out);
  assertStringIncludes(out, "atw is waiting for a fix");
  assert(!out.includes("is the app running?"), out);
  assertStringIncludes(out, "the file saved last does not load");
});
