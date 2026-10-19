// The dev restart's lock hand-over, when a step of it fails.
//
// The old app's release writes a record naming the supervisor over its lock
// (`AppLock.handOver`), and the supervisor files the relaunched child over
// that (`fileChildPlaceholder`). Two ways that went wrong:
//  1. The hand-over write threw part-way: `release()` threw with it and
//     skipped the rest of the release — the hold, `acquired`, the exit hooks.
//  2. The child's placeholder could not be filed: the slot kept naming the
//     LIVE supervisor, so the child met "already running" (or took the
//     supervisor for a zombie listener) instead of a free slot.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "node:fs";
import { tempDir } from "../src/testing/temp-dir.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import {
  _lockDeps,
  AppLock,
  type LockData,
  lockKey,
  lockPath,
  readLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { _fileChildPlaceholder } from "../src/server/dev-restart.ts";

async function withAppsDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir("lock-handover-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  try {
    return await fn(dir);
  } finally {
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
  }
}

Deno.test("lock hand-over: a hand-over write that throws still releases the lock whole", async () => {
  await withAppsDir(async (dir) => {
    const home = join(dir, "home");
    const lock = new AppLock("hand", home);
    const r = await lock.acquire(0);
    assert(r.ok);
    const mine = readLock(lockKey("hand", home))!;
    lock.handOver({ ...mine, status: "starting", pid: Deno.pid });
    // Refused before a byte is written (a program holds the file open).
    const open = _lockDeps.open;
    _lockDeps.open = () => {
      throw new Error("held open");
    };
    try {
      lock.release();
    } finally {
      _lockDeps.open = open;
    }
    assert(!AppLock.live().includes(lock), "still listed as held");
    // The record it could not hand over is removed, as at any quit.
    assertEquals(readLock(lockKey("hand", home)), null);
  });
});

Deno.test("lock hand-over: a child placeholder that cannot be filed frees the slot the supervisor held", async () => {
  await withAppsDir(async (dir) => {
    const home = join(dir, "home");
    const self: LockData = {
      appId: "hand2",
      home,
      pid: Deno.pid,
      port: 1,
      status: "started",
      startedAt: Date.now(),
    } as LockData;
    // The old app's hand-over: the slot names this (live) supervisor.
    writeLock({ ...self, status: "starting" });
    // Refused before a byte is written (a program holds the file open).
    const open = _lockDeps.open;
    _lockDeps.open = () => {
      throw new Error("held open");
    };
    let placed: string | null;
    try {
      placed = _fileChildPlaceholder(self, 999_999_999, 1);
    } finally {
      _lockDeps.open = open;
    }
    assertEquals(placed, null);
    assertEquals(
      readLock(lockKey("hand2", home)),
      null,
      "the slot still names the live supervisor — the child is refused",
    );
  });
});

function captureWarns(): { lines: string[]; [Symbol.dispose](): void } {
  const lines: string[] = [];
  setLogger(
    {
      pub: (lvl: string, _cat: string, msg: string) =>
        lvl === "warn" && lines.push(msg),
    } as unknown as LogSink,
  );
  return { lines, [Symbol.dispose]: () => setLogger(null) };
}

Deno.test("lock hand-over: a hand-over write refused part-way removes the emptied or torn record, and says so truly", async () => {
  for (const cut of [0, 7]) {
    await withAppsDir(async (dir) => {
      const home = join(dir, "home");
      const lock = new AppLock("hand3", home);
      const r = await lock.acquire(0);
      assert(r.ok);
      const mine = readLock(lockKey("hand3", home))!;
      // The supervisor's record: another pid, so written unsealed — the file
      // is emptied first, then the write is refused after `cut` bytes.
      lock.handOver({ ...mine, status: "starting", pid: 999_999_998 });
      const write = _lockDeps.write;
      _lockDeps.write = (f, bytes) => {
        f.writeSync(bytes.subarray(0, cut));
        throw new Error("no space left on device");
      };
      using log = captureWarns();
      try {
        lock.release();
      } finally {
        _lockDeps.write = write;
      }
      assert(!AppLock.live().includes(lock), "still listed as held");
      assert(
        !existsSync(lockPath(lockKey("hand3", home))),
        `cut ${cut}: an emptied/torn record is left in the slot`,
      );
      assert(
        log.lines.some((w) => w.includes("removed instead")),
        log.lines.join("\n"),
      );
    });
  }
});

Deno.test("lock hand-over: a child placeholder whose lock mutex cannot be made never throws", async () => {
  await withAppsDir(async (dir) => {
    const home = join(dir, "home");
    const self: LockData = {
      appId: "hand4",
      home,
      pid: Deno.pid,
      port: 1,
      status: "started",
      startedAt: Date.now(),
    } as LockData;
    writeLock({ ...self, status: "starting" });
    const create = _lockDeps.create;
    _lockDeps.create = () => {
      throw new Deno.errors.PermissionDenied("mutex refused");
    };
    using _log = captureWarns();
    let placed: string | null = "unset";
    try {
      placed = _fileChildPlaceholder(self, 999_999_999, 1);
    } finally {
      _lockDeps.create = create;
    }
    assertEquals(placed, null);
  });
});
