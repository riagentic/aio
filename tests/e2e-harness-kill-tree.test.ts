// The e2e harness's `kill()` ends what the process it is given STARTED, on
// every OS. On Windows it ended the direct child alone — the descendant walk
// asks `pgrep`, which is not there — so the app under a shell (a task runner,
// `run.ps1`) outlived its test, holding its port and its lock.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { kill } from "./e2e-app-harness.ts";
import { processParents } from "./proc-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("e2e harness kill(): the process a shell started goes with the shell", async () => {
  const dir = await tempDir("harness-kill-");
  const pidFile = join(dir, "pid");
  // The app under the shell: says its pid, then stays.
  const app = [
    "eval",
    "Deno.writeTextFileSync(Deno.env.get('PID_FILE'), String(Deno.pid)); setTimeout(() => {}, 600000);",
  ];
  const windows = Deno.build.os === "windows";
  const shell = new Deno.Command(windows ? "cmd" : "sh", {
    // `& wait`: a shell given one command would exec it, and be the app.
    args: windows
      ? ["/c", Deno.execPath(), ...app]
      : ["-c", '"$0" "$@" & wait', Deno.execPath(), ...app],
    env: { PID_FILE: pidFile },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  let appPid = NaN;
  try {
    for (let i = 0; i < 300 && !(appPid > 0); i++) {
      appPid = Number(await Deno.readTextFile(pidFile).catch(() => ""));
      if (!(appPid > 0)) await new Promise((r) => setTimeout(r, 100));
    }
    assert(appPid > 0, "the app under the shell did not start");
    assert(appPid !== shell.pid, "the shell became the app");
  } finally {
    await kill(shell);
  }
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    alive = (await processParents()).has(appPid);
    if (alive) await new Promise((r) => setTimeout(r, 100));
  }
  if (alive) {
    try {
      Deno.kill(appPid, "SIGKILL");
    } catch { /* gone in between */ }
  }
  await dropTempDir(dir);
  assert(!alive, `kill() left the app (pid ${appPid}) running`);
});
