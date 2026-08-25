// `am instances` names each instance's aio version: the lock carries the
// VERSION the process booted with, and a row whose version differs from the
// `am` reading it is marked — two checkouts on one machine is the normal dev
// setup, and a mismatch is the first thing to rule out.
import { assertEquals } from "@std/assert";
import {
  AppLock,
  readLock,
  removeLock,
} from "../src/server/single-instance-lock.ts";
import { VERSION } from "../src/server/aio-cli.ts";
import {
  instanceAioColumn,
  instanceAioMismatch,
} from "../src/am/am-cmd-process.ts";

const TEST_APP = "aio-test-lock-version-" + Deno.pid;

Deno.test("lock: acquire records the aio version it was given (cdpPort stays absent)", async () => {
  const lock = new AppLock(TEST_APP);
  try {
    const r = await lock.acquire(0, false, { aioVersion: VERSION });
    assertEquals(r.ok, true);
    const data = readLock(lock.key)!;
    assertEquals(data.aioVersion, VERSION);
    assertEquals("cdpPort" in data, false);
  } finally {
    lock.release();
    removeLock(lock.key);
  }
});

Deno.test("lock: acquire without meta writes no aioVersion (old shape preserved)", async () => {
  const lock = new AppLock(TEST_APP + "-nometa");
  try {
    await lock.acquire(0);
    assertEquals("aioVersion" in readLock(lock.key)!, false);
  } finally {
    lock.release();
    removeLock(lock.key);
  }
});

Deno.test("am instances: the aio column, and the mismatch mark", () => {
  assertEquals(instanceAioColumn(VERSION), `aio=${VERSION}`);
  assertEquals(instanceAioColumn(undefined), "aio=?");
  assertEquals(
    instanceAioColumn("1.0.0-alpha1"),
    `aio=1.0.0-alpha1  ≠ am ${VERSION}`,
  );
  assertEquals(instanceAioMismatch(undefined), false);
  assertEquals(instanceAioMismatch(VERSION), false);
  assertEquals(instanceAioMismatch("0.0.1"), true);
});
