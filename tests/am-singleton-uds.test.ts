// Single-instance protection for a prod+UDS app.
//
// `ensureSingleton` decided "is the other instance alive?" by fetching
// `http://127.0.0.1:<port>/` — and a prod app on the Unix-socket transport
// listens on its socket and NOWHERE else, so that probe can never succeed for
// it. The protection was therefore INVERTED for that transport: `am start`
// never refused, it killed the healthy running instance every single time,
// while `am status` (which has always carried the socket fallback) reported
// the app as up.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureSingleton } from "../src/am/am-cmd-process.ts";
import { removePid, writePid } from "../src/am/am-utils.ts";
import { isProcessAlive } from "../src/server/single-instance-lock.ts";
import { freePort } from "../src/testing/server-test.ts";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

/** Run `fn` with Deno.exit converted to a throw, capturing stdout. */
async function withExitStub(
  fn: () => Promise<void>,
): Promise<{ code: number | null; logs: string[] }> {
  const realExit = Deno.exit;
  const realLog = console.log;
  const logs: string[] = [];
  let code: number | null = null;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else throw e;
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = realExit;
    console.log = realLog;
  }
  return { code, logs };
}

/** A process that stays alive until killed — stands in for the running app. */
function spawnChild(): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: ["eval", "await new Promise(() => {})"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

Deno.test({
  name: "am: a running UDS app is DETECTED, not killed, by ensureSingleton",
  ignore: Deno.build.os === "windows", // no unix sockets
  async fn() {
    const appId = `am-uds-singleton-${Deno.pid}`;
    const dir = await Deno.makeTempDir({ prefix: "am-uds-" });
    const socketPath = join(dir, "app.sock");
    const listener = Deno.listen({ transport: "unix", path: socketPath });
    // Accept and drop — the probe only needs the connect to succeed.
    (async () => {
      for await (const conn of listener) {
        try {
          conn.close();
        } catch { /* already gone */ }
      }
    })();
    const child = spawnChild();
    writePid({
      appId,
      pid: child.pid,
      // A port nothing listens on: that is the whole point — a UDS app has no
      // TCP listener, so the HTTP probe MUST come back dead.
      port: freePort(),
      startedAt: Date.now(),
      status: "started",
      cwd: Deno.cwd(),
      socketPath,
    });
    try {
      const { code, logs } = await withExitStub(() =>
        ensureSingleton(appId, "json")
      );
      assertEquals(code, 1, "starting a second instance must be refused");
      assert(
        logs.some((l) => l.includes("already running")),
        `and say why — got ${JSON.stringify(logs)}`,
      );
      assert(
        isProcessAlive(child.pid),
        "the HEALTHY instance must still be running — killing it is the bug",
      );
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* already dead */ }
      await child.status;
      listener.close();
      removePid(appId);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "am: a genuinely dead instance is still reaped (the fallback is not a blanket yes)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const appId = `am-uds-zombie-${Deno.pid}`;
    const dir = await Deno.makeTempDir({ prefix: "am-uds-z-" });
    const child = spawnChild();
    writePid({
      appId,
      pid: child.pid,
      port: freePort(),
      startedAt: Date.now(),
      status: "started",
      cwd: Deno.cwd(),
      // A socket path that exists in the lock but has no listener behind it —
      // exactly what a crashed UDS app leaves behind.
      socketPath: join(dir, "gone.sock"),
    });
    try {
      const { code, logs } = await withExitStub(() =>
        ensureSingleton(appId, "json")
      );
      assertEquals(code, null, "no refusal: nothing is actually serving");
      assert(
        logs.some((l) => l.includes("unresponsive")),
        `the zombie is reported — got ${JSON.stringify(logs)}`,
      );
      assertEquals(isProcessAlive(child.pid), false, "and reaped");
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* already dead */ }
      await child.status;
      removePid(appId);
      await Deno.remove(dir, { recursive: true });
    }
  },
});
