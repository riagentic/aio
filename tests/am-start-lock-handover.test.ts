// `am start` hands its placeholder lock to the child it spawned IN PLACE, and
// only then releases its own hold: the slot is never vacant in between. When
// it was released first, a second `am start` took the empty slot and this
// child was refused by that am's lock ("did not start … exited immediately").
// The end-to-end race (tests/am-start-attach-peer-wins.test.ts "two at once")
// catches a regression only 1 run in 3; this pins the invariant directly.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { AppLock } from "../src/server/single-instance-lock.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { readPid } from "../src/am/am-utils.ts";
import { handLockToChild } from "../src/am/am-cmd-start.ts";
import { sleeper } from "./proc-helper.ts";

Deno.test("am start: the lock goes to the child in place — never a vacant slot", async () => {
  const appId = `handover-${Deno.pid}`;
  const home = appDirs(appId).home;
  const lock = new AppLock(appId, home);
  const handoff = crypto.randomUUID();
  const r = await lock.acquire(0, false, { handoff });
  assert(r.ok, JSON.stringify(r));
  const child = sleeper();
  try {
    let vacant = false;
    const handed = handLockToChild(appId, {
      appId,
      pid: child.pid,
      port: 0,
      startedAt: Date.now(),
      status: "starting",
      cwd: Deno.cwd(),
      home,
      handoff,
    }, () => {
      lock.release();
      vacant = readPid(appId) === null; // the moment am lets go
    });
    assertEquals(handed, true);
    assertEquals(vacant, false, "the slot was empty after am released it");
    const now = readPid(appId);
    assertEquals(now?.pid, child.pid);
    assertEquals((now as { handoff?: string } | null)?.handoff, handoff);
  } finally {
    child.kill();
    await child.status;
  }
});
