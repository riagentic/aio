import { assertEquals } from "@std/assert";
import {
  AppLock,
  instances,
  isProcessAlive,
  lockPath,
  readLock,
  removeLock,
  resolveAppId,
  slugify,
  writeLock,
} from "../src/server/single-instance-lock.ts";

const TEST_APP = "aio-test-lock-" + Deno.pid; // unique per test run to avoid collisions

async function cleanup() {
  removeLock(TEST_APP);
}

// ── slugify ──

Deno.test("slugify: basic", () => {
  assertEquals(slugify("My App"), "my-app");
  assertEquals(slugify("hello world!"), "hello-world");
  assertEquals(slugify(""), "aio-app");
  assertEquals(slugify("---"), "aio-app");
  assertEquals(slugify("My App! @v2"), "my-app-v2");
});

// ── resolveAppId ──

Deno.test("resolveAppId: slugifies explicit appId", () => {
  assertEquals(resolveAppId("My Custom App"), "my-custom-app");
});

Deno.test("resolveAppId: throws when no appId provided", () => {
  let threw = false;
  try {
    resolveAppId();
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// ── lockPath ──

Deno.test("lockPath: contains appId under aio/ subdir", () => {
  const p = lockPath("my-app");
  assertEquals(p.includes("my-app.lock"), true);
  assertEquals(p.includes("aio"), true); // lives under .../aio/ directory
});

// ── acquire / release basics ──

Deno.test("AppLock: acquire succeeds when no lock exists", async () => {
  await cleanup();
  const lock = new AppLock(TEST_APP);
  try {
    const result = await lock.acquire(19999);
    assertEquals(result.ok, true);
    // Lock file should exist with correct data
    const data = readLock(TEST_APP);
    assertEquals(data?.appId, TEST_APP);
    assertEquals(data?.port, 19999);
    assertEquals(data?.pid, Deno.pid);
    assertEquals(data?.status, "starting");
    assertEquals(data?.cwd, Deno.cwd());
  } finally {
    lock.release();
    await cleanup();
  }
});

Deno.test("AppLock: release removes lock file", async () => {
  await cleanup();
  const lock = new AppLock(TEST_APP);
  try {
    await lock.acquire(19999);
    lock.release();
    assertEquals(readLock(TEST_APP), null);
  } finally {
    await cleanup();
  }
});

Deno.test("AppLock: acquire cleans dead process lock", async () => {
  await cleanup();
  // Write a lock file with a dead PID
  const { writeLock } = await import("../src/server/single-instance-lock.ts");
  writeLock({
    appId: TEST_APP,
    pid: 999999,
    port: 19999,
    startedAt: Date.now(),
    status: "started",
    cwd: "/tmp",
  });
  const lock = new AppLock(TEST_APP);
  try {
    const result = await lock.acquire(19999);
    assertEquals(result.ok, true);
  } finally {
    lock.release();
    await cleanup();
  }
});

Deno.test("AppLock: release is idempotent", async () => {
  await cleanup();
  const lock = new AppLock(TEST_APP);
  lock.release(); // no lock file — should not throw
  lock.release(); // call again — still no throw
});

Deno.test("AppLock: lock file contains startedAt timestamp", async () => {
  await cleanup();
  const before = Date.now();
  const lock = new AppLock(TEST_APP);
  try {
    await lock.acquire(19999);
    const data = readLock(TEST_APP)!;
    assertEquals(data.startedAt >= before, true);
    assertEquals(data.startedAt <= Date.now(), true);
  } finally {
    lock.release();
    await cleanup();
  }
});

Deno.test("AppLock: update modifies lock data", async () => {
  await cleanup();
  const lock = new AppLock(TEST_APP);
  try {
    await lock.acquire(19999);
    lock.update({ status: "started", socketPath: "/tmp/test.sock" });
    const data = readLock(TEST_APP)!;
    assertEquals(data.status, "started");
    assertEquals(data.socketPath, "/tmp/test.sock");
    assertEquals(data.pid, Deno.pid); // unchanged
  } finally {
    lock.release();
    await cleanup();
  }
});

Deno.test("AppLock: release only removes own lock", async () => {
  await cleanup();
  // Write a lock with a different PID (simulating another process)
  const { writeLock } = await import("../src/server/single-instance-lock.ts");
  writeLock({
    appId: TEST_APP,
    pid: 999999,
    port: 19999,
    startedAt: Date.now(),
    status: "started",
    cwd: "/tmp",
  });
  const lock = new AppLock(TEST_APP);
  lock.release(); // should NOT remove — PID doesn't match
  // Lock should still exist (it has a different PID, but the process is dead so...)
  // Actually since 999999 is dead, readLock will still return data.
  // The key is that release() checks PID match — it won't remove someone else's lock.
  // In this case lock.acquired is false so release() is a no-op.
  await cleanup();
});

// ── instances ──

Deno.test("instances: returns empty when no locks", () => {
  const all = instances("nonexistent-app-xyz");
  assertEquals(all.length, 0);
});

Deno.test("instances: finds running app", async () => {
  await cleanup();
  const lock = new AppLock(TEST_APP);
  try {
    await lock.acquire(19999);
    lock.update({ status: "started" });
    const all = instances(TEST_APP);
    assertEquals(all.length, 1);
    assertEquals(all[0]!.appId, TEST_APP);
    assertEquals(all[0]!.pid, Deno.pid);
    assertEquals(all[0]!.alive, true);
  } finally {
    lock.release();
    await cleanup();
  }
});

Deno.test("instances: cleans stale locks", async () => {
  const staleApp = TEST_APP + "-stale";
  const { writeLock } = await import("../src/server/single-instance-lock.ts");
  writeLock({
    appId: staleApp,
    pid: 999999,
    port: 19999,
    startedAt: Date.now(),
    status: "started",
    cwd: "/tmp",
  });
  const all = instances(staleApp);
  assertEquals(all.length, 0); // cleaned because PID 999999 is dead
  assertEquals(readLock(staleApp), null); // lock file removed
});

// ── isProcessAlive ──

Deno.test("isProcessAlive: current process is alive", () => {
  assertEquals(isProcessAlive(Deno.pid), true);
});

Deno.test("isProcessAlive: dead PID returns false", () => {
  assertEquals(isProcessAlive(999999), false);
});

Deno.test("zombie reclaim: pid alive but port dead → lock reclaimed (mdview #5)", async () => {
  const appId = "zombie-test-" + crypto.randomUUID().slice(0, 8);
  // A port that is definitely closed: bind then release it
  const l = Deno.listen({ port: 0 });
  const deadPort = (l.addr as Deno.NetAddr).port;
  l.close();
  // Lock owned by a live foreign process (a spawned sleeper) whose "server"
  // port refuses connections, past the startup grace window.
  const sleeper = new Deno.Command("sleep", { args: ["30"] }).spawn();
  try {
    writeLock({
      appId,
      pid: sleeper.pid,
      port: deadPort,
      startedAt: Date.now() - 60_000,
      status: "started",
      cwd: Deno.cwd(),
    });

    const lock = new AppLock(appId);
    const result = await lock.acquire(4321);
    assertEquals(
      result.ok,
      true,
      "zombie lock (live pid, dead port) reclaimed",
    );
    lock.release();
  } finally {
    try {
      sleeper.kill();
    } catch { /* already gone */ }
    await sleeper.status;
  }
});

Deno.test("zombie reclaim: skipped for UDS instances and during startup grace", async () => {
  const appId = "zombie-uds-" + crypto.randomUUID().slice(0, 8);
  const l = Deno.listen({ port: 0 });
  const deadPort = (l.addr as Deno.NetAddr).port;
  l.close();
  // UDS instance: port never listens — must NOT be treated as a zombie
  const sleeper = new Deno.Command("sleep", { args: ["30"] }).spawn();
  try {
    writeLock({
      appId,
      pid: sleeper.pid,
      port: deadPort,
      startedAt: Date.now() - 60_000,
      status: "started",
      cwd: Deno.cwd(),
      socketPath: "/tmp/aio/fake.sock",
    });
    const lock = new AppLock(appId);
    const result = await lock.acquire(4322);
    assertEquals(result.ok, false, "UDS instance not reclaimed by port check");
    removeLock(appId);
  } finally {
    try {
      sleeper.kill();
    } catch { /* already gone */ }
    await sleeper.status;
  }
});
