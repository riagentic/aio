// The lock's per-key mutex is mutually exclusive, and a holder that DIES
// releases it — measured with real processes.
//
// It was a file whose presence was the hold, and a dead holder's file was
// broken by rename-aside + compare + link-back. While a LIVE holder's file sat
// moved aside the name was free: a third process published, the link-back
// failed, and two processes were inside the mutex at once. It is an OS lock
// now (nothing to break), with the holder unlinking the file on the way out —
// which is exactly the part a waiter could get wrong (locking an inode that is
// no longer at the path), so that is what the race below hammers.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const MOD = toFileUrl(join(REPO, "src/server/single-instance-lock.ts")).href;
const N = 6;
const ITER = 3000;

// Each worker enters the mutex ITER times; inside, it claims an "occupied"
// marker with createNew. A marker already there = someone else is inside too.
const WORKER = `const { withLockMutex } = await import(${JSON.stringify(MOD)});
const occ = Deno.env.get("OCC");
let clash = 0;
for (let i = 0; i < ${ITER}; i++) {
  withLockMutex("mx-race", () => {
    try {
      Deno.openSync(occ, { createNew: true, write: true }).close();
    } catch {
      clash++;
      return;
    }
    for (let k = 0; k < 200; k++) Math.sqrt(k);
    Deno.removeSync(occ);
  });
}
console.log("CLASH " + clash);
`;

Deno.test(
  "lock mutex: " + N + " processes, never two inside at once",
  async () => {
    const dir = await tempDir("lock-mx-");
    const worker = join(dir, "worker.ts");
    await Deno.writeTextFile(worker, WORKER);
    const env = { AIO_APPS_DIR: join(dir, "apps"), OCC: join(dir, "occupied") };
    const outs = await Promise.all(
      Array.from({ length: N }, () =>
        new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", "--config", join(REPO, "deno.json"), worker],
          env,
          stdout: "piped",
          stderr: "piped",
        }).output()),
    );
    const dec = new TextDecoder();
    assertEquals(outs.length, N, "every worker ran");
    let clashes = 0;
    for (const o of outs) {
      const line = dec.decode(o.stdout).trim().split("\n").pop() ?? "";
      assert(
        o.success && line.startsWith("CLASH "),
        `worker failed: ${line}\n${dec.decode(o.stderr).slice(-1500)}`,
      );
      clashes += Number(line.slice(6));
    }
    assertEquals(clashes, 0, "two processes held the mutex at once");
  },
);

Deno.test("lock mutex: a holder SIGKILLed inside it releases it at once — nothing to break", async () => {
  const dir = await tempDir("lock-mx-dead-");
  const env = { AIO_APPS_DIR: join(dir, "apps") };
  const holder = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--config",
      join(REPO, "deno.json"),
      `const { withLockMutex } = await import(${JSON.stringify(MOD)});
       withLockMutex("mx-dead", () => {
         console.log("IN");
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
       });`,
    ],
    env,
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = holder.stdout.getReader();
  let said = "";
  while (!said.includes("IN")) {
    const { value, done } = await reader.read();
    if (done) break;
    said += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  assert(said.includes("IN"), "the holder never entered the mutex");
  holder.kill("SIGKILL");
  await holder.status;
  await holder.stdout.cancel();
  const t0 = performance.now();
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--config",
      join(REPO, "deno.json"),
      `const { withLockMutex } = await import(${JSON.stringify(MOD)});
       const t = performance.now();
       withLockMutex("mx-dead", () => {});
       console.log("WAITED " + Math.round(performance.now() - t));`,
    ],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const line = new TextDecoder().decode(out.stdout).trim();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const waited = Number(line.replace("WAITED ", ""));
  // No pid to judge, no file to break, no 2 s deadline: the OS released it
  // with the process.
  assert(waited < 500, `waited ${waited} ms behind a dead holder (${line})`);
  assert(performance.now() - t0 < 30_000);
});

// ── The mutex FILE a crash leaves behind ────────────────────────────────
// A holder SIGKILLed inside the mutex never unlinks `<lock>.mx`. It names no
// pid, so no temp sweep can judge it, and it kept a scoped lock dir from ever
// being pruned (on Windows the file was never removed at all). It is dropped
// through the holder's own protocol — lock without waiting, confirm, unlink —
// so a mutex somebody HOLDS is never touched.

function holdMutex(apps: string, key: string) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--config",
      join(REPO, "deno.json"),
      `const { withLockMutex } = await import(${JSON.stringify(MOD)});
       withLockMutex(${JSON.stringify(key)}, () => {
         console.log("IN");
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
       });`,
    ],
    env: { AIO_APPS_DIR: apps },
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const ready = (async () => {
    const reader = child.stdout.getReader();
    let said = "";
    while (!said.includes("IN")) {
      const { value, done } = await reader.read();
      if (done) break;
      said += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    await child.stdout.cancel();
    assert(said.includes("IN"), "the holder never entered the mutex");
  })();
  return { child, ready };
}

Deno.test("lock mutex: a crash's idle .mx is swept at acquire and prune; a HELD one never", async () => {
  const dir = await tempDir("lock-mx-sweep-");
  const apps = join(dir, "apps");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", apps);
  const m = await import("../src/server/single-instance-lock.ts");
  const exists = (f: string) => {
    try {
      Deno.statSync(f);
      return true;
    } catch {
      return false;
    }
  };
  const held = holdMutex(apps, m.lockKey("held", join(dir, "h")));
  try {
    await held.ready;
    const heldMx = `${m.lockPath(m.lockKey("held", join(dir, "h")))}.mx`;
    assert(exists(heldMx), "the holder's mutex file is not there");
    // A crash leftover for the app we are about to start.
    const key = m.lockKey("idle", join(dir, "i"));
    const idleMx = `${m.lockPath(key)}.mx`;
    Deno.writeTextFileSync(idleMx, "");
    m.sweepOrphanLockTemps(key);
    assertEquals(exists(idleMx), false, "acquire's sweep left an idle .mx");
    // prune: an idle .mx of an app that never starts again goes too…
    const gone = `${m.lockPath(m.lockKey("gone", join(dir, "g")))}.mx`;
    Deno.writeTextFileSync(gone, "");
    m.pruneLockDir();
    assertEquals(exists(gone), false, "prune left an idle .mx");
    // …and a held one survives both.
    m.sweepOrphanLockTemps(m.lockKey("held", join(dir, "h")));
    assert(exists(heldMx), "swept a mutex its holder is inside");
  } finally {
    held.child.kill("SIGKILL");
    await held.child.status;
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
  }
});

Deno.test("lock mutex: unlinked only where files have an identity (Windows included)", async () => {
  const { mayUnlinkMutex } = await import(
    "../src/server/single-instance-lock.ts"
  );
  // Linux, macOS and Windows (Deno 2.9.6 measured): `ino` is set.
  assertEquals(mayUnlinkMutex({ ino: 3940649674113906 }), true);
  // A filesystem with no identity: the file stays; `sameFile` can't tell.
  assertEquals(mayUnlinkMutex({ ino: null }), false);
});
