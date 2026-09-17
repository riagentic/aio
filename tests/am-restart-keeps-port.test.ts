// `am restart` keeps the port the app bound (h7 finding 5).
//
// An app that declares no port picks a free one; `am restart` used to let it
// pick AGAIN (55095 → 51159, measured), so every open tab died — while a dev
// restart keeps the port. Now the last bound port is reused when it is free.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { childEnv, makeApp } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { readLaunchInfo } from "../src/server/single-instance-lock.ts";

const dec = new TextDecoder();

Deno.test({
  name: "am restart: an app with no declared port comes back on the SAME port",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await makeApp("counter", "am-restart-port-");
    const apps = await tempDir("am-restart-port-apps-");
    const env = {
      ...Deno.env.toObject(),
      ...childEnv({ AIO_APPS_DIR: apps }),
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    };
    const am = async (...args: string[]) => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", join(dir, "dep", "aio", "src", "am.ts"), ...args],
        cwd: dir,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = dec.decode(r.stdout);
      return { code: r.code, out, err: dec.decode(r.stderr) };
    };
    const pids: number[] = [];
    try {
      const s = await am("start", "--client=server-only", "--json");
      assertEquals(s.code, 0, s.out + s.err);
      const a = JSON.parse(s.out.trim().split("\n").at(-1)!);
      pids.push(a.pid);
      const r = await am("restart", "--json");
      assertEquals(r.code, 0, r.out + r.err);
      const b = JSON.parse(r.out.trim().split("\n").at(-1)!);
      pids.push(b.pid);
      assertEquals(b.status, "started", r.out);
      assertEquals(b.port, a.port, "the restart moved the app to a new port");
      // The reused port is the restart's answer, never recorded as declared.
      const prev = Deno.env.get("AIO_APPS_DIR");
      Deno.env.set("AIO_APPS_DIR", apps);
      try {
        const appId = JSON.parse(
          await Deno.readTextFile(join(dir, "deno.json")),
        ).name ?? a.appId;
        const info = readLaunchInfo(a.appId ?? appId);
        assertEquals(
          info?.flags.some((f) => f.startsWith("--port=")),
          false,
          JSON.stringify(info),
        );
      } finally {
        if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
        else Deno.env.set("AIO_APPS_DIR", prev);
      }
    } finally {
      await am("stop", "--wait").catch(() => {});
      for (const pid of pids) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* gone */ }
      }
      await dropTempDir(apps);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
