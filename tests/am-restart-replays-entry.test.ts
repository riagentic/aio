// `am restart` must bring back the app `am start` launched — and never take
// down an app it cannot start again.
//
// `am start --entry=main.ts` recorded the entry in launch.json, but restart
// replayed only the recorded FLAGS: it stopped the app, then the start half
// failed "no src/app.ts found" and the app was left DOWN. Now the recorded
// entry is replayed, and the start is checked BEFORE anything is stopped: a
// restart that cannot start refuses with the app still up.
//
// Real app in a temp dir (dep/aio → this checkout), AIO_APPS_DIR in a temp
// dir, --client=server-only (no window).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { childEnv, makeApp } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { isProcessAlive } from "../src/server/single-instance-lock.ts";
import { restartEntry } from "../src/am/am-cmd-process.ts";

const dec = new TextDecoder();

Deno.test("restartEntry: explicit wins, else the recorded entry (against its cwd) while it exists", () => {
  const has = (set: string[]) => (p: string) => set.includes(p);
  assertEquals(
    restartEntry("x.ts", { entry: "a.ts", cwd: "/p" }, "/r", has([])),
    { entry: "x.ts" },
  );
  assertEquals(
    restartEntry(
      undefined,
      { entry: "main.ts", cwd: "/p" },
      "/r",
      has(["/p/main.ts"]),
    ),
    { entry: "/p/main.ts" },
  );
  // No recorded cwd (an older record): the project root.
  assertEquals(
    restartEntry(undefined, { entry: "main.ts" }, "/r", has(["/r/main.ts"])),
    { entry: "/r/main.ts" },
  );
  assertEquals(
    restartEntry(undefined, { entry: "main.ts", cwd: "/p" }, "/r", has([])),
    { gone: "/p/main.ts" },
  );
  assertEquals(restartEntry(undefined, null, "/r", has([])), {});
  assertEquals(restartEntry(undefined, { cwd: "/p" }, "/r", has([])), {});
});

Deno.test({
  name:
    "am restart: an app started with --entry comes back on it; a restart that cannot start leaves the app UP",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await makeApp("counter", "am-restart-entry-");
    const apps = await tempDir("am-restart-entry-apps-");
    // The entry is NOT the default: src/app.ts is gone, main.ts boots it.
    await Deno.rename(join(dir, "src", "app.ts"), join(dir, "src", "real.ts"));
    await Deno.writeTextFile(join(dir, "main.ts"), `import "./src/real.ts";\n`);
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
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: r.code,
        out: dec.decode(r.stdout),
        err: dec.decode(r.stderr),
      };
    };
    const pids: number[] = [];
    try {
      const s = await am(
        "start",
        "--entry=main.ts",
        "--client=server-only",
        "--json",
      );
      assertEquals(s.code, 0, s.out + s.err);
      const a = JSON.parse(s.out.trim().split("\n").at(-1)!);
      pids.push(a.pid);

      const r = await am("restart", "--json");
      assertEquals(r.code, 0, `restart left the app down:\n${r.out}${r.err}`);
      const b = JSON.parse(r.out.trim().split("\n").at(-1)!);
      pids.push(b.pid);
      assertEquals(b.status, "started", r.out);
      assert(b.pid !== a.pid, "a restart is a new process");

      // Now the entry is gone and there is no default to fall back to: the
      // restart must refuse BEFORE it stops anything.
      await Deno.remove(join(dir, "main.ts"));
      const f = await am("restart", "--json");
      assertEquals(f.code, 1, f.out + f.err);
      assertStringIncludes(f.out, "NOT restarted");
      assertStringIncludes(f.out, "no src/app.ts found");
      assert(isProcessAlive(b.pid), "the refused restart stopped the app");
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
