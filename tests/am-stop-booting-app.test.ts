// `am stop` on an app that finishes booting WHILE the stop runs.
//
// A booting app rewrites its own lock: `starting` → `started`, and its own
// `startedAt` over `am start`'s placeholder. The stop's compare-and-swap used
// to compare those fields, so the SAME live process read as "a lock that
// changed": `am stop` answered "nothing was stopped", `am stop --all` skipped
// every app that finished booting mid-list, and `am restart` exited 1. The
// compare is the OWNER (pid + start identity); what the owner writes since is
// kept. Each case runs in a child with its own XDG_RUNTIME_DIR/AIO_APPS_DIR.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const CFG = join(REPO, "deno.json");
const url = (p: string) => JSON.stringify(toFileUrl(join(REPO, p)).href);

async function inChild(dir: string, code: string): Promise<unknown> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--config", CFG, code],
    cwd: dir,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      XDG_RUNTIME_DIR: join(dir, "run"),
      AIO_APPS_DIR: join(dir, "apps"),
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(o.stdout);
  if (!o.success) throw new Error(out + new TextDecoder().decode(o.stderr));
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

/** A booting "app": a real process (`sleep`) whose lock the child writes,
 *  as `am start`'s placeholder would — `starting`, port 1 (nothing listens,
 *  so the stop falls through to SIGTERM). */
const APP = `
  const m = await import(${url("src/server/single-instance-lock.ts")});
  const boot = (id) => {
    const p = new Deno.Command("sleep", { args: ["60"] }).spawn();
    m.writeLock({ appId: id, pid: p.pid, port: 1, startedAt: 1000,
      status: "starting", cwd: Deno.cwd(), ...m.ownerIdentity(p.pid) });
    return p;
  };
  // What the app itself does when it finishes booting.
  const flip = (id) => {
    const now = m.readLock(id);
    if (now) m.writeLock({ ...now, status: "started", startedAt: Date.now() });
  };
  const gone = async (p) => {
    for (let i = 0; i < 100 && m.isProcessAlive(p.pid); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return !m.isProcessAlive(p.pid);
  };`;

Deno.test({
  name: "am stop: an app that finishes booting mid-stop is still stopped",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("stop-flip-");
    try {
      await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
      const r = await inChild(
        dir,
        `${APP}
         const { stopOne } = await import(${url("src/am/am-cmd-process.ts")});
         const p = boot("fl");
         const pf = m.readLock("fl"); // what \`am stop\` read: starting
         flip("fl");                  // …and the app finished booting
         const res = await stopOne({ appId: "fl", port: 1, pf }, { json: true });
         const dead = await gone(p);
         try { p.kill("SIGKILL"); } catch {}
         await p.status;
         console.log(JSON.stringify({ ok: res.ok, error: res.error, dead }));`,
      );
      assertEquals(r, { ok: true, dead: true });
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "am stop --all: apps whose locks flip mid-list are all stopped",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("stopall-flip-");
    try {
      await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
      await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
      const r = await inChild(
        dir,
        `${APP}
         const ps = ["fa", "fb", "fc"].map(boot);
         // Every lock keeps being rewritten by its (same) owner while the
         // fleet stop runs — the booting flip, as often as it can happen.
         const t = setInterval(() => ["fa", "fb", "fc"].forEach(flip), 15);
         const o = await new Deno.Command(Deno.execPath(), {
           args: ["run", "-A", "--config", ${JSON.stringify(CFG)},
             ${JSON.stringify(join(REPO, "src/am.ts"))}, "stop", "--all",
             "--json"],
           stdout: "piped", stderr: "piped" }).output();
         clearInterval(t);
         const dead = [];
         for (const p of ps) dead.push(await gone(p));
         for (const p of ps) { try { p.kill("SIGKILL"); } catch {} await p.status; }
         console.log(JSON.stringify({ code: o.code, dead,
           said: new TextDecoder().decode(o.stdout) }));`,
      );
      const o = r as { code: number; dead: boolean[]; said: string };
      assertEquals(o.dead, [true, true, true], o.said);
      assertEquals(o.code, 0, o.said);
      assert(!o.said.includes("changed"), o.said);
    } finally {
      await dropTempDir(dir);
    }
  },
});

// A lock gone between the read and the stop: stopped ONLY if its owner is
// gone too. An owner that still LIVES (a lock removed by hand, an exit still
// under way) is still the process to stop — `am restart` otherwise left the
// old instance running beside the new one.
Deno.test({
  name:
    "am stop: lock gone mid-stop — a live owner is still stopped, a dead one is 'stopped'",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("stop-gone-");
    try {
      await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
      const r = await inChild(
        dir,
        `${APP}
         const { stopOne } = await import(${url("src/am/am-cmd-process.ts")});
         // Owner alive, lock removed by hand.
         const p = boot("gn");
         const pf = m.readLock("gn");
         m.removeLock("gn");
         const live = await stopOne({ appId: "gn", port: 1, pf }, { json: true });
         const liveDead = await gone(p);
         try { p.kill("SIGKILL"); } catch {}
         await p.status;
         // Owner exited, and its lock with it.
         const q = boot("gd");
         const qf = m.readLock("gd");
         q.kill("SIGKILL"); await q.status;
         m.removeLock("gd");
         const dead = await stopOne({ appId: "gd", port: 1, pf: qf }, { json: true });
         console.log(JSON.stringify({ live: live.ok, liveDead, dead: dead.ok,
           deadError: dead.error }));`,
      );
      assertEquals(r, { live: true, liveDead: true, dead: true });
    } finally {
      await dropTempDir(dir);
    }
  },
});
