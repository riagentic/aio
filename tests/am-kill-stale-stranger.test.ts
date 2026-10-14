// `am kill --stale`, as the command a user runs, against a port whose
// `/__aio/health` names a pid. The pid arrives over an unauthenticated loopback
// socket: anything listening there can name any process of the user's. The
// decision (`stalePidRefusal`) is unit-tested in am-process-safety.test.ts;
// here it is what the command DOES with it — a stranger is still running
// afterwards, and an aio process with no lock is not. On Windows the only
// thing that tells the two apart is the image name `tasklist` reports.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { isProcessAlive } from "../src/server/single-instance-lock.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { sleeper } from "./proc-helper.ts";

const AM = fromFileUrl(new URL("../src/am.ts", import.meta.url));
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

/** A long-lived program that is nobody's aio app. */
const STRANGER = Deno.build.os === "windows"
  ? { cmd: "ping", args: ["-n", "60", "127.0.0.1"] }
  : { cmd: "sleep", args: ["60"] };

/** `am kill --stale --port=<a port whose health names pid>`, in a world of
 *  its own (no lock, no app, no launch record), and what it answered. */
async function killStale(
  dir: string,
  pid: number,
): Promise<
  { killed: { pid: number }[]; spared: { pid: number; why: string }[] }
> {
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen() {} },
    () => Response.json({ status: "healthy", appId: "claimed", pid }),
  );
  try {
    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "-c",
        CONFIG,
        AM,
        "kill",
        "--stale",
        `--port=${port}`,
        "--json",
      ],
      cwd: dir,
      env: { AIO_APPS_DIR: dir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    assert(o.success, d.decode(o.stdout) + d.decode(o.stderr));
    return JSON.parse(d.decode(o.stdout));
  } finally {
    await server.shutdown();
  }
}

Deno.test("am kill --stale: a port that names a stranger's pid leaves it running; an aio process with no lock is ended", async () => {
  const dir = await tempDir("am-kill-stale-");
  const quiet = { stdin: "null", stdout: "null", stderr: "null" } as const;
  const stranger = new Deno.Command(STRANGER.cmd, {
    args: STRANGER.args,
    ...quiet,
  }).spawn();
  // What an orphaned aio app is to the process table: a deno process.
  const orphan = sleeper(quiet);
  try {
    const left = await killStale(dir, stranger.pid);
    assertEquals(left.killed, []);
    assertEquals(left.spared.map((s) => s.pid), [stranger.pid]);
    assertStringIncludes(left.spared[0]!.why, "is not an aio process");
    assert(isProcessAlive(stranger.pid), "am ended a stranger's process");

    const ended = await killStale(dir, orphan.pid);
    assertEquals(ended.spared, []);
    assertEquals(ended.killed.map((k) => k.pid), [orphan.pid]);
    assert(!(await orphan.status).success, "the orphan was not ended");
  } finally {
    for (const p of [stranger, orphan]) {
      try {
        p.kill("SIGKILL");
      } catch { /* aio-ok: ended by the command under test, or already gone */ }
      await p.status;
    }
    await dropTempDir(dir);
  }
});
