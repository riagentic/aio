// A dev session WAITING for a fix (its relaunch died on a broken save) holds
// the lock under its own pid with `waiting` set. A fresh start of the app takes
// the slot — the session steps aside on its own — and never SIGTERMs it; the
// `am` side names the wait (`waitingOf` / `waitingMessage`).
import { exits0, sleeper } from "./proc-helper.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  AppLock,
  type LockData,
  lockKey,
  readLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { waitingMessage, waitingOf } from "../src/am/am-cmd-process.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

Deno.test("waiting dev session: a new start takes the slot without killing it", async () => {
  const dir = await tempDir("lock-wait-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  const holder = sleeper();
  const home = join(dir, "home");
  let lock: AppLock | null = null;
  try {
    const rec: LockData = {
      appId: "wt",
      pid: holder.pid,
      port: 0,
      startedAt: Date.now(),
      status: "starting",
      waiting: { reason: "the file saved last does not load", since: 1 },
      cwd: dir,
      home,
    };
    writeLock(rec);
    lock = new AppLock("wt", home);
    const r = await lock.acquire(0, /* killExisting */ false);
    assert(r.ok, "a waiting dev session blocked a fresh start");
    assertEquals(readLock(lockKey("wt", home))?.pid, Deno.pid);
    Deno.kill(holder.pid, 0); // throws if the session was killed
  } finally {
    lock?.release();
    try {
      holder.kill("SIGKILL");
    } catch { /* aio-ok: already gone — the failure the test reports */ }
    await holder.status;
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
    await dropTempDir(dir);
  }
});

Deno.test("waitingOf / waitingMessage: name the wait and what the app said", () => {
  assertEquals(waitingOf({ appId: "a" } as never), null);
  const w = { reason: "it broke", since: 5 };
  assertEquals(waitingOf({ waiting: w } as never), w);
  assertEquals(waitingOf({ waiting: { reason: 3 } } as never), null);
  const m = waitingMessage("myapp", 42, w, ["error: SyntaxError: nope"]);
  assertStringIncludes(m, "myapp is waiting for a fix — it broke");
  assertStringIncludes(m, "pid 42");
  assertStringIncludes(m, "SyntaxError: nope");
});

// A waiting session killed with SIGKILL leaves its `waiting` lock behind. The
// app was not running then, so the next boot must not claim state was lost.
Deno.test("waiting dev session: its stale lock is reclaimed without a false 'state lost'", async () => {
  const dir = await tempDir("lock-wait-dead-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  const gone = exits0();
  await gone.status; // reaped: its pid names no process
  const home = join(dir, "home");
  const warns: string[] = [];
  const prev = getLogger();
  setLogger({
    logDir: "",
    pub: (lvl: string, cat: string, msg?: string) => {
      if (lvl === "warn") warns.push(`${cat} ${msg ?? ""}`);
    },
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink);
  let lock: AppLock | null = null;
  try {
    writeLock({
      appId: "wt",
      pid: gone.pid,
      port: 0,
      startedAt: Date.now(),
      status: "starting",
      waiting: { reason: "the file saved last does not load", since: 1 },
      cwd: dir,
      home,
    });
    lock = new AppLock("wt", home);
    const r = await lock.acquire(0, false);
    assert(r.ok, "the stale waiting lock blocked the boot");
    assertEquals(warns, []);
  } finally {
    setLogger(prev);
    lock?.release();
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
    await dropTempDir(dir);
  }
});
