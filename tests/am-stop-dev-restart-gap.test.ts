// network §3: right after a save restarted a dev app, `am stop` said "app not
// running: no lock file" and a second `am stop` a moment later worked. A dev
// restart releases the old child's lock early in its shutdown, and the next
// child's lock appears only after it exits (~100 ms measured on a tiny app,
// longer with real databases). The app's own log moving in that gap is the
// evidence of a restart: `am stop` waits for the lock while it moves, then
// stops the new process. A quiet log answers at once, exactly as before.
import "./store-sandbox.ts";
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

/** `fresh`: the app's stdout.log was just written (a restart under way).
 *  `relockMs`: when the next child's lock appears (null = never). */
const scenario = (fresh: boolean, relockMs: number | null) => `
  const m = await import(${url("src/server/single-instance-lock.ts")});
  const { appDirs } = await import(${url("src/server/app-dirs.ts")});
  const logs = appDirs("rs").logs;
  await Deno.mkdir(logs, { recursive: true });
  // A restart keeps writing its log until the next child's lock is filed.
  const touch = () => Deno.writeTextFileSync(logs + "/stdout.log",
    "restarting\\n", { append: true });
  const ticker = ${fresh} ? setInterval(touch, 250) : undefined;
  if (${fresh}) touch();
  const p = new Deno.Command(Deno.execPath(), {
    args: ["eval", "setTimeout(() => {}, 60000)"],
  }).spawn();
  if (${relockMs} !== null) {
    setTimeout(() => {
      clearInterval(ticker);
      m.writeLock({ appId: "rs", pid: p.pid, port: 1, startedAt: Date.now(),
        status: "starting", cwd: Deno.cwd(), ...m.ownerIdentity(p.pid) });
    }, ${relockMs ?? 0});
  }
  const t0 = Date.now();
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", ${JSON.stringify(CFG)},
      ${JSON.stringify(join(REPO, "src/am.ts"))}, "stop", "--app=rs", "--json"],
    stdout: "piped", stderr: "piped" }).output();
  const ms = Date.now() - t0;
  let dead = false;
  for (let i = 0; i < 100 && !dead; i++) {
    dead = !m.isProcessAlive(p.pid);
    if (!dead) await new Promise((r) => setTimeout(r, 50));
  }
  try { p.kill("SIGKILL"); } catch {}
  await p.status;
  const td = new TextDecoder();
  console.log(JSON.stringify({ code: o.code, dead, ms,
    said: td.decode(o.stdout) + td.decode(o.stderr) }));`;

type R = { code: number; dead: boolean; ms: number; said: string };

Deno.test({
  name: "am stop: a lock that comes back while the log moves is stopped",
  async fn() {
    const dir = await tempDir("stop-restart-gap-");
    try {
      await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
      // The lock comes back well after `am stop` is up: a cold `am` under a
      // loaded Windows suite took past 4 s to start, found the lock already
      // there, and never met the gap this test is about.
      const r = await inChild(dir, scenario(true, 8000)) as R;
      assertEquals(r.code, 0, r.said);
      assert(r.dead, r.said);
      assert(r.said.includes("restart"), r.said);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "am stop: no lock and a quiet log is 'not running' at once",
  async fn() {
    const dir = await tempDir("stop-restart-quiet-");
    try {
      await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
      const r = await inChild(dir, scenario(false, null)) as R;
      assertEquals(r.code, 1, r.said);
      assert(r.said.includes("no lock file"), r.said);
    } finally {
      await dropTempDir(dir);
    }
  },
});
