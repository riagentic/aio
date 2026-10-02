// A lock's owner changes its record IN PLACE, through the handle it has had
// open since it made the file — never by writing a new file and renaming it.
//
// The lock file is published through a hard link, and on Windows a rename
// over a file published that way is refused (measured: 1.4–4.1 % of 2 000
// tries, for 0.5–1.3 s when quiet and over 10 s right after an install). A
// desktop app's boot was refused by it — `could not replace …\<app>.lock …
// after 11 tries` — on the first start after an install and after an update.
// A write through an open handle was refused 0 times in 8 000 and creates no
// file. What it costs is pinned here too: a reader can catch the write half
// done, so the owner's record carries a seal, any other record is emptied
// first, and a reader that does not see a whole record looks again.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  _lockDeps,
  _seal,
  AppLock,
  type LockData,
  lockPath,
  readLock,
  removeLock,
  replaceLockIf,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { _renameDeps } from "../src/diagnostics/rename-over.ts";

const id = (name: string) =>
  `inplace-${name}-${crypto.randomUUID().slice(0, 8)}`;
const ino = (appId: string) => Deno.statSync(lockPath(appId)).ino;
const raw = (appId: string) => Deno.readTextFileSync(lockPath(appId));
const tmps = (appId: string) =>
  [...Deno.readDirSync(lockPath(appId).replace(/[^/\\]+$/, ""))]
    .map((e) => e.name)
    .filter((n) => n.startsWith(`${appId}.lock.`) && n.endsWith(".tmp"));

/** Run `fn` as on a Windows machine where EVERY rename onto a lock file is
 *  refused, as one over a file published by hard link can be. Returns how
 *  many were tried. */
async function withRenamesRefused<T>(
  fn: () => T | Promise<T>,
): Promise<{ out: T; renames: number }> {
  const real = { ..._renameDeps };
  let renames = 0;
  _renameDeps.windows = () => true;
  _renameDeps.pause = () => {};
  _renameDeps.rename = (from, to) => {
    if (!to.endsWith(".lock")) return real.rename(from, to);
    renames++;
    throw new Deno.errors.PermissionDenied(
      `Access is denied. (os error 5): rename '${from}' -> '${to}'`,
    );
  };
  try {
    return { out: await fn(), renames };
  } finally {
    Object.assign(_renameDeps, real);
    _renameDeps.reset();
  }
}

Deno.test("an owner's update writes the same file: no rename, no new file — and lands where every rename is refused", async () => {
  const appId = id("update");
  const lock = new AppLock(appId);
  try {
    const r = await withRenamesRefused(async () => {
      assertEquals((await lock.acquire(4100)).ok, true);
      const made = ino(appId);
      lock.update({ status: "started", port: 4101, socketPath: "/x/y.sock" });
      lock.update({ status: "stopping" });
      return { made, now: ino(appId) };
    });
    assertEquals(r.renames, 0, "the owner's record is never renamed over");
    assertEquals(r.out.now, r.out.made, "one file for the lock's whole life");
    assertEquals(tmps(appId), []);
    const l = readLock(appId)!;
    assertEquals([l.status, l.port, l.socketPath, l.pid], [
      "stopping",
      4101,
      "/x/y.sock",
      Deno.pid,
    ]);
  } finally {
    lock.release();
  }
  assertThrows(() => Deno.statSync(lockPath(appId)), Deno.errors.NotFound);
});

Deno.test("a shorter record leaves no tail of the longer one", async () => {
  const appId = id("shrink");
  const lock = new AppLock(appId);
  try {
    assertEquals((await lock.acquire(4100)).ok, true);
    lock.update({ socketPath: "/a/very/long/path/".repeat(20) + "s.sock" });
    const long = raw(appId).length;
    lock.update({ socketPath: "/s" });
    assert(raw(appId).length < long);
    assertEquals(readLock(appId)!.socketPath, "/s");
    assertEquals(_seal.parse(raw(appId))!.socketPath, "/s");
  } finally {
    lock.release();
  }
});

Deno.test("a write that fails is thrown to the caller, not swallowed", async () => {
  const appId = id("fails");
  const lock = new AppLock(appId);
  const write = _lockDeps.write;
  try {
    assertEquals((await lock.acquire(4100)).ok, true);
    _lockDeps.write = () => {
      throw new Error("planted: no space left on device");
    };
    assertThrows(
      () => lock.update({ status: "started" }),
      Error,
      "planted: no space left on device",
    );
  } finally {
    _lockDeps.write = write;
    lock.release();
  }
});

// ── the seal ──────────────────────────────────────────────────────────────

const record = (o: Partial<LockData> = {}): LockData => ({
  appId: "notes",
  pid: 4242,
  port: 3000,
  startedAt: 1_700_000_000_000,
  status: "starting",
  cwd: "/home/u/notes",
  home: "/home/u/.notes",
  ...o,
});

Deno.test("the seal: a sealed record is plain JSON to any other reader, and reads back whole", () => {
  const data = record({ port: 3999, socketPath: "/r/n.sock" });
  const text = _seal.text(data);
  assert(text.startsWith(JSON.stringify(data) + "\n"));
  assertEquals(JSON.parse(text), data, "trailing whitespace to JSON.parse");
  assertEquals(_seal.parse(text), data);
  // A record with no seal — an older aio's, a placeholder's — is read as is.
  assertEquals(_seal.parse(JSON.stringify(data)), data);
  // One flipped mark, and it is not a record.
  const flipped = text.slice(0, -2) + (text.at(-2) === " " ? "\t" : " ") + "\n";
  assertEquals(_seal.parse(flipped), null);
});

Deno.test("the seal: no mix of two writes reads as a record", () => {
  const pairs: Array<[LockData, LockData]> = [
    [record(), record({ status: "started" })],
    [record(), record({ status: "started", port: 0, socketPath: "/r/n.sock" })],
    [record({ status: "started", socketPath: "/r/n.sock" }), record()],
    [record({ port: 3000 }), record({ port: 3001 })],
    [record({ status: "started" }), record({ status: "stopping" })],
  ];
  let mixes = 0;
  for (const [was, next] of pairs) {
    const a = _seal.text(was), b = _seal.text(next);
    const whole = new Set([JSON.stringify(was), JSON.stringify(next)]);
    // Every state a reader can catch: the first k bytes of the new record
    // over the old one, at the old length or the longer of the two.
    for (let k = 0; k <= b.length; k++) {
      for (const mix of [b.slice(0, k) + a.slice(k), b.slice(0, k)]) {
        const got = _seal.parse(mix);
        if (got === null) continue;
        mixes++;
        // Whatever reads IS one of the two records, field for field (the
        // new record's whole JSON with its seal still to come is the new
        // record).
        assert(
          whole.has(JSON.stringify(got)),
          `a torn record was read as whole (k=${k}): ${JSON.stringify(mix)}`,
        );
      }
    }
  }
  assert(mixes >= pairs.length, "the two whole records must read");
});

Deno.test("a reader that catches a write half done looks again, and gets the record", async () => {
  const appId = id("torn");
  const lock = new AppLock(appId);
  const read = Deno.readTextFileSync;
  try {
    assertEquals((await lock.acquire(4100)).ok, true);
    const before = raw(appId);
    lock.update({ status: "started", port: 4444 });
    const after = raw(appId);
    // The first three looks see the new record's start over the old one's
    // end, cut just inside what differs.
    let cut = 0;
    while (after[cut] === before[cut]) cut++;
    const torn = after.slice(0, cut + 3) + before.slice(cut + 3);
    assertEquals(_seal.parse(torn), null, "the cut must be a real tear");
    let looks = 0;
    Deno.readTextFileSync = ((p: string | URL) =>
      String(p) === lockPath(appId) && ++looks <= 3
        ? torn
        : read(p)) as typeof Deno.readTextFileSync;
    const l = readLock(appId);
    assertEquals(looks, 4, "read again until the record was whole");
    assertEquals([l?.status, l?.port], ["started", 4444]);
  } finally {
    Deno.readTextFileSync = read;
    lock.release();
  }
});

// ── writers that are not the owner ────────────────────────────────────────

Deno.test("a placeholder is stored as exactly JSON.stringify(record) — its writer compares those bytes", () => {
  const appId = id("plain");
  const { home: _h, ...plain } = record({ appId, pid: Deno.ppid });
  const data: LockData = plain;
  try {
    assert(replaceLockIf(null, data));
    assertEquals(raw(appId), JSON.stringify(data));
    // …and over a DEAD owner's sealed record: another owner, so replaced
    // whole, plain.
    const dead: LockData = { ...plain, pid: 2 ** 22 - 3 };
    Deno.writeTextFileSync(lockPath(appId), _seal.text(dead));
    assert(replaceLockIf(dead, data));
    assertEquals(raw(appId), JSON.stringify(data));
  } finally {
    removeLock(appId);
  }
});

Deno.test("another process's change to a live owner's record goes into the same file, and the owner's next write lands on it", async () => {
  const appId = id("edit");
  const lock = new AppLock(appId);
  try {
    assertEquals((await lock.acquire(4100)).ok, true);
    const made = ino(appId);
    const mine = readLock(appId)!;
    // What `am stop` does: mark it stopping, keeping what the owner wrote.
    const r = await withRenamesRefused(() =>
      replaceLockIf(mine, (now) => ({ ...now, status: "stopping" }))
    );
    assertEquals([r.out, r.renames], [true, 0]);
    assertEquals(ino(appId), made);
    assertEquals(readLock(appId)!.status, "stopping");
    lock.update({ port: 4199 });
    assertEquals(ino(appId), made);
    const l = readLock(appId)!;
    assertEquals([l.status, l.port], ["stopping", 4199]);
    // `writeLock` over the owner's own record: the same rule.
    writeLock({ ...l, port: 4200 });
    assertEquals([ino(appId), readLock(appId)!.port], [made, 4200]);
  } finally {
    lock.release();
  }
});

Deno.test("an older aio that RENAMED a new file over the owner's record: the owner's next write goes to the file that is there", async () => {
  const appId = id("renamed");
  const lock = new AppLock(appId);
  try {
    assertEquals((await lock.acquire(4100)).ok, true);
    const made = ino(appId);
    const mine = readLock(appId)!;
    // Plain text, a new file, renamed into place — the lock's old way.
    const tmp = `${lockPath(appId)}.other.tmp`;
    Deno.writeTextFileSync(
      tmp,
      JSON.stringify({ ...mine, status: "stopping" }),
    );
    Deno.renameSync(tmp, lockPath(appId));
    assert(ino(appId) !== made);
    lock.update({ port: 4300 });
    const l = readLock(appId)!;
    assertEquals([l.status, l.port], ["stopping", 4300]);
    // …sealed again, and in place from here on.
    const now = ino(appId);
    lock.update({ port: 4301 });
    assertEquals([ino(appId), readLock(appId)!.port], [now, 4301]);
  } finally {
    lock.release();
  }
});

Deno.test("no change to a lock record is a rename: placeholder, its change, a dead owner's record, an unsealed owner's — all land where every rename is refused", async () => {
  const appId = id("norename");
  const lock = new AppLock(appId);
  const dead: LockData = {
    appId,
    pid: 2 ** 22 - 3,
    port: 4400,
    startedAt: 1,
    status: "starting",
    cwd: "/",
  };
  try {
    const r = await withRenamesRefused(async () => {
      // A placeholder is PUBLISHED BY HARD LINK — the file a rename over is
      // refused for — and every later write is onto that very file.
      assertEquals(replaceLockIf(null, dead), true);
      const made = ino(appId);
      assertEquals(
        replaceLockIf(dead, (now) => ({ ...now, status: "started" })),
        true,
      );
      assertEquals([ino(appId), readLock(appId)!.status], [made, "started"]);
      // Another pid's record over it (a dead owner's replaced), and back.
      const next = { ...dead, pid: dead.pid - 1, port: 4401 };
      assertEquals(replaceLockIf(readLock(appId), next), true);
      assertEquals(raw(appId), JSON.stringify(next));
      writeLock({ ...next, port: 4402 });
      assertEquals([ino(appId), readLock(appId)!.port], [made, 4402]);
      // No file: created whole, by link again.
      removeLock(appId);
      writeLock(next);
      assertEquals(raw(appId), JSON.stringify(next));
      removeLock(appId);
      // An owner whose record lost its seal (an older aio rewrote it).
      assertEquals((await lock.acquire(4403)).ok, true);
      const mine = ino(appId);
      Deno.writeTextFileSync(
        lockPath(appId),
        JSON.stringify(readLock(appId)),
      );
      lock.update({ status: "started" });
      assertEquals([ino(appId), readLock(appId)!.status], [mine, "started"]);
      assertEquals(
        raw(appId),
        _seal.text(readLock(appId)!),
        "the owner seals what it writes",
      );
    });
    assertEquals(r.renames, 0);
    assertEquals(tmps(appId), []);
  } finally {
    lock.release();
    removeLock(appId);
  }
});

Deno.test("a record with no seal is emptied before it is written over: a reader sees no splice of the two", () => {
  const appId = id("splice");
  // The two differ in the middle and not in length — written straight over,
  // a reader mid-write gets a third record that parses (`"starteng"`…).
  const was: LockData = {
    appId,
    pid: 2 ** 22 - 5,
    port: 4500,
    startedAt: 1,
    status: "starting",
    cwd: "/",
  };
  const real = _lockDeps.write;
  const seen: string[] = [];
  try {
    assertEquals(replaceLockIf(null, was), true);
    _lockDeps.write = (f, bytes) => {
      seen.push(raw(appId)); // what a reader gets as the write begins
      // …and with the first half of it down
      f.seekSync(0, Deno.SeekMode.Start);
      f.writeSync(bytes.subarray(0, bytes.length >> 1));
      seen.push(raw(appId));
      real(f, bytes);
    };
    assertEquals(
      replaceLockIf(was, (now) => ({ ...now, status: "stopping" })),
      true,
    );
    const next = JSON.stringify({ ...was, status: "stopping" });
    assertEquals(seen, ["", next.slice(0, next.length >> 1)]);
    assertEquals(raw(appId), next);
  } finally {
    _lockDeps.write = real;
    removeLock(appId);
  }
});

Deno.test("a sealed record is written over in place without ever being empty: a reader at any step sees a whole record or a mix that fails its seal", () => {
  const appId = id("noempty");
  const was: LockData = {
    appId,
    pid: Deno.pid,
    port: 4600,
    startedAt: 1,
    status: "starting",
    cwd: "/",
  };
  assertEquals(replaceLockIf(null, was), true);
  const path = lockPath(appId);
  Deno.writeTextFileSync(path, _seal.text(was));
  const f = Deno.openSync(path, { read: true, write: true });
  const seen: string[] = [];
  // Every step the write makes is followed by a look at the file.
  const spy = new Proxy(f, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        const r = v.apply(t, a);
        if (k !== "close") seen.push(Deno.readTextFileSync(path));
        return r;
      };
    },
  });
  try {
    _lockDeps.write(
      spy,
      new TextEncoder().encode(_seal.text({ ...was, port: 4 })),
    );
    assert(seen.length >= 2, `${seen.length} steps`);
    assert(!seen.includes(""), "the file was empty at one step");
    assertEquals(readLock(appId)!.port, 4);
  } finally {
    f.close();
    removeLock(appId);
  }
});
