// A MAINTENANCE hold (`am backup` / `am restore` holding the app's lock while
// data/ is copied or swapped) is not an app: while its pid lives it is never
// reclaimed, a takeover never SIGTERMs it, and the app's own refused boot says
// which op to wait for — not "Already running … am stop", which sent the
// operator to stop a backup half-way through.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";
import {
  AppLock,
  type LockData,
  lockKey,
  readLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";

const REPO = join(import.meta.dirname!, "..");

async function plant(dir: string, pid: number): Promise<{ home: string }> {
  const home = join(dir, "home");
  const rec: LockData = {
    appId: "mnt",
    pid,
    port: 0,
    startedAt: Date.now() - 60_000,
    status: "starting",
    maintenance: { op: "am backup" },
    cwd: dir,
    home,
  };
  writeLock(rec);
  assertEquals(readLock(lockKey("mnt", home))?.maintenance?.op, "am backup");
  return { home };
}

Deno.test("maintenance hold: a takeover neither reclaims it nor kills its live holder", async () => {
  const dir = await tempDir("lock-mnt-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  const holder = new Deno.Command("sleep", { args: ["30"] }).spawn();
  try {
    const { home } = await plant(dir, holder.pid);
    const r = await new AppLock("mnt", home).acquire(
      0,
      /* killExisting */ true,
    );
    assert(!r.ok, "took over a maintenance hold");
    assertEquals(r.existing.maintenance?.op, "am backup");
    Deno.kill(holder.pid, "SIGCONT"); // throws if the holder was killed
    assertEquals(readLock(lockKey("mnt", home))?.pid, holder.pid);
  } finally {
    try {
      holder.kill("SIGKILL");
    } catch { /* aio-ok: already killed — the failure the test reports */ }
    await holder.status;
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
  }
});

Deno.test("maintenance hold: the app's refused boot names the op, not `am stop`", async () => {
  const dir = await tempDir("lock-mnt-boot-");
  const holder = new Deno.Command("sleep", { args: ["30"] }).spawn();
  try {
    const apps = join(dir, "apps");
    const home = join(dir, "home");
    // Planted from a child with the same AIO_APPS_DIR the boot uses.
    const mod = toFileUrl(join(REPO, "src/server/single-instance-lock.ts"));
    const helpers = toFileUrl(join(REPO, "src/server/aio-run-helpers.ts"));
    const run = (code: string) =>
      new Deno.Command(Deno.execPath(), {
        args: ["eval", "--config", join(REPO, "deno.json"), code],
        env: { AIO_APPS_DIR: apps },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const planted = await run(
      `const m = await import(${JSON.stringify(mod.href)});
       m.writeLock({ appId: "mnt", pid: ${holder.pid}, port: 0,
         startedAt: Date.now(), status: "starting",
         maintenance: { op: "am backup" },
         cwd: "/", home: ${JSON.stringify(home)} });`,
    );
    assert(planted.success, new TextDecoder().decode(planted.stderr));
    const boot = await run(
      `const h = await import(${JSON.stringify(helpers.href)});
       await h.acquireSingletonLock("mnt", ${
        JSON.stringify(home)
      }, 0, true, false);
       console.log("ACQUIRED");`,
    );
    const out = new TextDecoder().decode(boot.stdout) +
      new TextDecoder().decode(boot.stderr);
    assertEquals(boot.code, 1, out);
    assertStringIncludes(
      out,
      `am backup is running on mnt (pid ${holder.pid})`,
    );
    assertStringIncludes(out, "wait for it to finish");
    assert(!out.includes("am stop"), `told to stop a backup:\n${out}`);
  } finally {
    try {
      holder.kill("SIGKILL");
    } catch { /* aio-ok: already killed — the failure the test reports */ }
    await holder.status;
  }
});

Deno.test("maintenance hold: its startedAt keeps moving, so an older `am` never reads it as a stalled boot", async () => {
  const dir = await tempDir("lock-mnt-beat-");
  const was = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(dir, "apps"));
  const { _internals } = await import("../src/am/am-cmd-data.ts");
  const home = join(dir, "home");
  const hold = await _internals.holdForMaintenance(
    "beat",
    home,
    "backup",
    "json",
    40,
  );
  try {
    const first = readLock(lockKey("beat", home))!;
    assertEquals(first.maintenance?.op, "am backup");
    // What v1.0.9 reads: a live, door-less "starting" lock.
    assertEquals(first.status, "starting");
    await new Promise((r) => setTimeout(r, 200));
    const later = readLock(lockKey("beat", home))!;
    assert(
      later.startedAt > first.startedAt,
      `startedAt did not move: ${first.startedAt} → ${later.startedAt}`,
    );
    assertEquals(later.maintenance?.op, "am backup");
  } finally {
    hold.release();
    if (was === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", was);
  }
});
