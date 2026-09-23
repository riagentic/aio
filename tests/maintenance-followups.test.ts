// Follow-ups to the maintenance hold (`am backup` / `am restore`) and the
// installer kill — each pinned where it can regress.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { deadOwnerWarning } from "../src/server/single-instance-lock.ts";
import { installerKillPlan } from "../src/electron/electron-spawn.ts";
import { type AppDirs, writeAppMeta } from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");

// A boot reclaiming a DEAD owner's lock warned "the previous run of <app> did
// not shut down cleanly … state … is otherwise gone" — also when that owner
// was a killed `am backup`, which held no app state at all.
Deno.test("dead owner: a killed maintenance holder is named, not blamed for lost writes", () => {
  const app = deadOwnerWarning("w", { pid: 9 });
  assertStringIncludes(app, `the previous run of "w" (pid 9)`);
  const bk = deadOwnerWarning("w", {
    pid: 9,
    maintenance: { op: "am backup" },
  });
  assertStringIncludes(bk, "am backup (pid 9) was killed");
  assertStringIncludes(bk, "no app state was lost");
  assert(!bk.includes("previous run"), bk);
  const rs = deadOwnerWarning("w", {
    pid: 9,
    maintenance: { op: "am restore" },
  });
  assertStringIncludes(rs, "am restore (pid 9) was killed");
  assertStringIncludes(rs, "data.replaced-*");
});

Deno.test({
  name: "dead owner: the boot's reclaim of a killed backup's lock says so",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("dead-mnt-");
    try {
      const gone = new Deno.Command("true").spawn();
      await gone.status; // a pid that no longer runs
      const mod = toFileUrl(join(REPO, "src/server/single-instance-lock.ts"));
      const home = join(dir, "home");
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          join(REPO, "deno.json"),
          `const m = await import(${JSON.stringify(mod.href)});
           m.writeLock({ appId: "deadmnt", pid: ${gone.pid}, port: 0,
             startedAt: Date.now(), status: "starting",
             maintenance: { op: "am backup" }, cwd: "/",
             home: ${JSON.stringify(home)} });
           const l = new m.AppLock("deadmnt", ${JSON.stringify(home)});
           const got = await l.acquire(0);
           console.log("GOT", got.ok);
           l.release();`,
        ],
        env: { AIO_APPS_DIR: join(dir, "apps") },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(r.stdout) +
        new TextDecoder().decode(r.stderr);
      assert(r.success, out);
      assertStringIncludes(out, "GOT true");
      assertStringIncludes(out, `am backup (pid ${gone.pid}) was killed`);
      assert(!out.includes("did not shut down cleanly"), out);
    } finally {
      await dropTempDir(dir);
    }
  },
});

// Windows has no process groups, and TerminateProcess never ends children:
// aborting a first-run install killed `deno install` and orphaned its
// lifecycle grandchild. The tree is ended with `taskkill /T /F`.
Deno.test("installer kill: POSIX signals the group, Windows kills the tree", () => {
  assertEquals(installerKillPlan("linux", 4242), { kind: "group", pgid: 4242 });
  assertEquals(installerKillPlan("darwin", 7), { kind: "group", pgid: 7 });
  assertEquals(installerKillPlan("windows", 4242), {
    kind: "tree",
    cmd: "taskkill",
    args: ["/T", "/F", "/PID", "4242"],
  });
});

// meta.json is rewritten on every boot. In place, a reader (`am backup`'s
// copy, the next boot's createdAt read) could see it half-written, and a
// `meta.json` symlink was written THROUGH.
Deno.test({
  name: "writeAppMeta: replaces a planted symlink, never writes through it",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("meta-atomic-");
    try {
      const data = join(dir, "data");
      Deno.mkdirSync(data);
      const outside = join(dir, "outside.json");
      Deno.writeTextFileSync(outside, "NOT YOURS");
      const meta = join(data, "meta.json");
      Deno.symlinkSync(outside, meta);
      writeAppMeta({ data, meta } as AppDirs, { appId: "m", aio: "1.2.3" });
      assertEquals(Deno.readTextFileSync(outside), "NOT YOURS");
      assert(!Deno.lstatSync(meta).isSymlink, "meta.json is still a link");
      assertEquals(JSON.parse(Deno.readTextFileSync(meta)).aio, "1.2.3");
      assertEquals(
        [...Deno.readDirSync(data)].map((e) => e.name),
        ["meta.json"],
        "no temp left behind",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

// A boot killed between meta.json's tmp write and its rename leaves the tmp
// in data/ — swept by the next write (under the lock), by the shared rule:
// only an OLDER-than-this-process regular file of exactly that shape.
Deno.test({
  name: "writeAppMeta: sweeps a dead writer's meta.json tmp, keeps a live one",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("meta-sweep-");
    try {
      const data = join(dir, "data");
      Deno.mkdirSync(data);
      const meta = join(data, "meta.json");
      const uuid = "0123abcd-0000-4000-8000-00000000abcd";
      const stale = `${meta}.${uuid}.tmp`;
      const live = `${meta}.${uuid.replace("0123", "9999")}.tmp`;
      Deno.writeTextFileSync(stale, "half");
      Deno.writeTextFileSync(live, "writing");
      const past = new Date(performance.timeOrigin - 60_000);
      Deno.utimeSync(stale, past, past);
      writeAppMeta({ data, meta } as AppDirs, { appId: "m", aio: "1.2.3" });
      assertEquals(
        [...Deno.readDirSync(data)].map((e) => e.name).sort(),
        ["meta.json", `meta.json.${uuid.replace("0123", "9999")}.tmp`],
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

// The legacy migration refuses while the app is LIVE — any instance but the
// caller. Once the boot ran it after taking its own lock, a flag waived the
// check outright; but the check reads the DEFAULT-home lock, and a boot from
// another home (`appDir`) holds a different one — so a live default-home app
// had its data.db moved from under it. Now: refuse unless the live owner IS
// this process.
Deno.test({
  name:
    "legacy migration: refuses under a live OTHER instance, not under itself",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("mig-live-");
    const holder = new Deno.Command("sleep", {
      args: ["60"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      const lockMod = toFileUrl(
        join(REPO, "src/server/single-instance-lock.ts"),
      );
      const migMod = toFileUrl(join(REPO, "src/server/app-dirs-migrate.ts"));
      const dirsMod = toFileUrl(join(REPO, "src/server/app-dirs.ts"));
      const probe = (owner: string) =>
        new Deno.Command(Deno.execPath(), {
          args: [
            "eval",
            "--config",
            join(REPO, "deno.json"),
            `const L = await import(${JSON.stringify(lockMod.href)});
             const M = await import(${JSON.stringify(migMod.href)});
             const D = await import(${JSON.stringify(dirsMod.href)});
             const cwd = ${JSON.stringify(dir)} + "/cwd-" + ${
              JSON.stringify(owner)
            };
             Deno.mkdirSync(cwd, { recursive: true });
             Deno.writeTextFileSync(cwd + "/data.db", "LEGACY");
             // The DEFAULT-home lock, owned by ${owner}.
             L.writeLock({ appId: "mig", pid: ${
              owner === "self" ? "Deno.pid" : holder.pid
            },
               ${owner === "recycled" ? 'startToken: "not-this-process",' : ""}
               port: 0, startedAt: Date.now(), status: "started", cwd,
               home: D.appHome("mig") });
             // …while this boot runs from ANOTHER home.
             const dirs = D.appDirs("mig", ${
              JSON.stringify(dir)
            } + "/other-" + ${JSON.stringify(owner)});
             const r = M.migrateLegacyLayout({ appId: "mig", dirs, cwd,
               legacyXdgDir: ${JSON.stringify(dir)} + "/xdg" });
             L.removeLock("mig");
             let left = true;
             try { Deno.statSync(cwd + "/data.db"); } catch { left = false; }
             console.log(JSON.stringify({ refused: !!r.refused, left }));`,
          ],
          env: { AIO_APPS_DIR: join(dir, "apps") },
          stdout: "piped",
          stderr: "piped",
        }).output();
      const other = await probe("other");
      const o1 = new TextDecoder().decode(other.stdout);
      assert(other.success, o1 + new TextDecoder().decode(other.stderr));
      assertEquals(JSON.parse(o1), { refused: true, left: true });
      const self = await probe("self");
      const o2 = new TextDecoder().decode(self.stdout);
      assert(self.success, o2 + new TextDecoder().decode(self.stderr));
      assertEquals(JSON.parse(o2), { refused: false, left: false });
      // A live pid with ANOTHER start token is a recycled pid, not the owner.
      const rec = await probe("recycled");
      const o3 = new TextDecoder().decode(rec.stdout);
      assert(rec.success, o3 + new TextDecoder().decode(rec.stderr));
      if (Deno.build.os === "linux") {
        assertEquals(JSON.parse(o3), { refused: false, left: false });
      }
    } finally {
      try {
        holder.kill("SIGKILL");
      } catch { /* aio-ok: already gone */ }
      await holder.status;
      await dropTempDir(dir);
    }
  },
});

// `removePid` is the lock cleanup `am start` / `am status` / `am stop` share:
// a dead maintenance holder is named there too, whichever path reaches it
// first (a `--home`-pinned lookup never lists instances at all).
Deno.test({
  name: "removePid: a dead maintenance holder is named before its lock goes",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("rmpid-dead-");
    try {
      const gone = new Deno.Command("true").spawn();
      await gone.status;
      const lockMod = toFileUrl(
        join(REPO, "src/server/single-instance-lock.ts"),
      );
      const utils = toFileUrl(join(REPO, "src/am/am-utils.ts"));
      const home = join(dir, "home");
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          join(REPO, "deno.json"),
          `const L = await import(${JSON.stringify(lockMod.href)});
           const U = await import(${JSON.stringify(utils.href)});
           const pf = { appId: "rmp", pid: ${gone.pid}, port: 0,
             startedAt: Date.now(), status: "starting", cwd: "/",
             home: ${JSON.stringify(home)},
             maintenance: { op: "am restore", partial: "/x/data.restoring-1" } };
           L.writeLock(pf);
           U.removePid("rmp", pf);
           console.log("LEFT", L.readLock(L.lockKey("rmp", pf.home)) !== null);`,
        ],
        env: { AIO_APPS_DIR: join(dir, "apps") },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(r.stdout) +
        new TextDecoder().decode(r.stderr);
      assert(r.success, out);
      assertStringIncludes(out, "LEFT false");
      assertStringIncludes(out, `am restore (pid ${gone.pid}) was killed`);
      assertStringIncludes(out, "/x/data.restoring-1");
    } finally {
      await dropTempDir(dir);
    }
  },
});

// The other side of the same rule, and the malformed shapes: a dead APP's
// lock is cleaned up without the killed-op warning; a `maintenance` that is
// not an object is still a hold (unknown op) — never an app crash; and lock
// text is printed with its control characters replaced (a lock file is
// writable by anything running as the user — an escape sequence in `op` must
// not reach the terminal).
Deno.test({
  name:
    "removePid: a dead app is not a killed op; malformed/escaped holds print safely",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("rmpid-shapes-");
    try {
      const gone = new Deno.Command("true").spawn();
      await gone.status;
      const lockMod = toFileUrl(
        join(REPO, "src/server/single-instance-lock.ts"),
      );
      const utils = toFileUrl(join(REPO, "src/am/am-utils.ts"));
      const run = async (maintenance: string) => {
        const o = await new Deno.Command(Deno.execPath(), {
          args: [
            "eval",
            "--config",
            join(REPO, "deno.json"),
            `const L = await import(${JSON.stringify(lockMod.href)});
             const U = await import(${JSON.stringify(utils.href)});
             const pf = { appId: "shp", pid: ${gone.pid}, port: 0,
               startedAt: Date.now(), status: "starting", cwd: "/",
               home: ${JSON.stringify(join(dir, "home"))}
               ${maintenance ? `, maintenance: ${maintenance}` : ""} };
             L.writeLock(pf);
             U.removePid("shp", pf);
             console.log("OP", JSON.stringify(U.maintenanceOp(pf)));`,
          ],
          env: { AIO_APPS_DIR: join(dir, "apps") },
          stdout: "piped",
          stderr: "piped",
        }).output();
        const out = new TextDecoder().decode(o.stdout) +
          new TextDecoder().decode(o.stderr);
        assert(o.success, out);
        return out;
      };
      const app = await run("");
      assert(!app.includes("was killed"), app);
      assert(!app.includes("previous run"), app);
      assertStringIncludes(app, "OP null");

      const yes = await run(`"yes"`);
      assertStringIncludes(yes, `am (pid ${gone.pid}) was killed`);
      assertStringIncludes(yes, 'OP "am"');

      const esc = await run(
        `{ op: "am backup\\u001b[2J", partial: "/p\\u0007.partial" }`,
      );
      assert(!esc.includes("\u001b[2J"), JSON.stringify(esc));
      assert(!esc.includes("\u0007"), JSON.stringify(esc));
      assertStringIncludes(esc, "am backup?[2J (pid");
      assertStringIncludes(esc, "/p?.partial");
    } finally {
      await dropTempDir(dir);
    }
  },
});
