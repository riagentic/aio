// `am backup` / `am restore` hold the app's lock as a MAINTENANCE record, and
// every verb names it.
//
// They used to take the lock with the record a booting app writes
// (`starting`, port 0): `am status` said "starting", `am stop` SIGTERMed the
// backup mid-copy, and `am start` either told the user to `am stop` it or
// killed it as a zombie. Now the record carries `maintenance: { op }` (its
// `status` stays "starting" for readers that predate the field — the status
// union is frozen surface), and status (exit 2, transitional), stop (refuses, sends nothing), start
// (refuses) and every HTTP verb say "am backup is running". Additive on disk:
// an older reader validates appId/pid/port only, so it still sees a held lock.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  maintenanceMark,
  maintenanceMessage,
  maintenanceOp,
  noDoorMessage,
} from "../src/am/am-utils.ts";
import { alreadyRunningLine } from "../src/am/am-cmd-process.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const LOCK_MOD = new URL(
  "../src/server/single-instance-lock.ts",
  import.meta.url,
).href;
const APP = "ammainthold";

Deno.test("maintenanceOp: names the op of a maintenance record, only that", () => {
  const rec = { pid: 7, ...maintenanceMark("am backup") };
  assertEquals(maintenanceOp(rec), "am backup");
  assertEquals(maintenanceOp({ pid: 7, status: "starting" }), null);
  assertEquals(
    maintenanceOp({ pid: 7, status: "starting", maintenance: {} }),
    "am",
  );
  assertEquals(maintenanceOp(null), null);
  const msg = maintenanceMessage("x", rec);
  assertStringIncludes(msg, "am backup is running");
  assertStringIncludes(msg, "(pid 7)");
  // The shared no-door sentence and the start refusal say the same thing.
  assertEquals(noDoorMessage("x", rec as never), msg);
  assertEquals(
    alreadyRunningLine({ appId: "x", port: 0, ...rec } as never),
    msg,
  );
});

async function denoDirOf(): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(o.stdout)).denoDir;
}

Deno.test({
  name:
    "am: status/stop/start/state against a backup's hold name it, kill nothing",
  ignore: Deno.build.os === "windows", // `sleep` stands in for `am backup`
  fn: async () => {
    const base = await tempDir("am-maint-");
    const cwd = join(base, "cwd");
    for (const d of [cwd, join(base, "home"), join(base, "run")]) {
      await Deno.mkdir(d, { recursive: true, mode: 0o700 });
    }
    await Deno.writeTextFile(join(cwd, "main.ts"), "console.log(1);\n");
    const env = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      DENO_DIR: await denoDirOf(),
      HOME: join(base, "home"),
      AIO_APPS_DIR: join(base, "apps"),
      XDG_RUNTIME_DIR: join(base, "run"),
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    };
    // Ignores SIGTERM, like a hold that is still cleaning up: `am kill`
    // below must interrupt it WITHOUT taking its lock away.
    const sleeper = new Deno.Command("sh", {
      args: ["-c", "trap '' TERM; exec sleep 300"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      // The record exactly as `am backup` leaves it: acquire(0) + the mark.
      const lock = {
        appId: APP,
        pid: sleeper.pid,
        port: 0,
        startedAt: Date.now(), // the heartbeat's — fresh
        cwd,
        // The op's REAL start, two minutes ago.
        ...maintenanceMark("am backup", Date.now() - 120_000),
      };
      const planted = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          CONFIG,
          `import { writeLock } from ${JSON.stringify(LOCK_MOD)};` +
          `writeLock(${JSON.stringify(lock)});`,
        ],
        clearEnv: true,
        env,
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(planted.success, new TextDecoder().decode(planted.stderr));

      const am = async (...argv: string[]) => {
        const o = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", "--config", CONFIG, AM, ...argv, `--app=${APP}`],
          cwd,
          clearEnv: true,
          env,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        const d = new TextDecoder();
        return {
          code: o.code,
          out: d.decode(o.stdout),
          all: d.decode(o.stdout) + d.decode(o.stderr),
        };
      };
      const alive = () => {
        try {
          Deno.kill(sleeper.pid, "SIGCONT");
          return true;
        } catch {
          return false;
        }
      };

      const st = await am("status", "--json");
      assertEquals(st.code, 2, st.all);
      const doc = JSON.parse(st.out);
      assertEquals(doc.status, "maintenance", st.out);
      assertEquals(doc.op, "am backup", st.out);
      assertEquals(doc.pid, sleeper.pid);

      for (const argv of [["stop"], ["start"], ["state"]]) {
        const r = await am(...argv, "--json");
        const what = `am ${argv.join(" ")}`;
        assertEquals(r.code, 1, `${what}: ${r.all}`);
        assert(!r.out.includes('"ok":true'), `${what}: ${r.out}`);
        assertStringIncludes(r.all, "am backup is running", what);
        assertStringIncludes(r.all, `pid ${sleeper.pid}`, what);
        assert(alive(), `${what} killed the backup`);
      }

      // `am instances`: the hold as `am status` names it — not a booting app
      // with a `stopWith` that refuses — and its age from the op's start,
      // not from the heartbeat.
      const inst = await am("instances", "--json");
      assertEquals(inst.code, 0, inst.all);
      const row = (JSON.parse(inst.out) as Record<string, unknown>[])
        .find((r) => r.appId === APP);
      assert(row, inst.out);
      assertEquals(row.status, "maintenance", inst.out);
      assertEquals(row.op, "am backup", inst.out);
      assert(!("stopWith" in row), `a hold has no stopWith: ${inst.out}`);
      assert((row.uptime as number) >= 110, `uptime from since: ${inst.out}`);

      // `am kill`: interrupts the op, says so, and leaves its LOCK to it —
      // the op releases it once it has cleaned up.
      const k = await am("kill", "--json");
      assertEquals(k.code, 0, k.all);
      const kd = JSON.parse(k.out);
      assertEquals(kd.op, "am backup", k.out);
      assertEquals(kd.killed, true, k.out);
      const after = await am("status", "--json");
      assertEquals(after.code, 2, `the hold's lock must survive: ${after.all}`);
      assertEquals(JSON.parse(after.out).status, "maintenance", after.out);
    } finally {
      try {
        sleeper.kill("SIGKILL");
      } catch { /* gone */ }
      await sleeper.status;
      await dropTempDir(base);
    }
  },
});
