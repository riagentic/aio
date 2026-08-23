// `am start` never kills an app that is still booting.
//
// `ensureSingleton` used to read a `starting` lock, probe the port it carried
// and kill the owner when nothing answered. `am start` writes that placeholder
// lock itself with `port: 0` when the app declared none — so the probe went to
// 127.0.0.1:0, failed by definition, and a second `am start` during the boot
// window SIGTERMed the first app with "stuck-starting". Two deciders: the
// runtime gives a starting owner STARTUP_GRACE_MS; `am` gave none.
import { assert, assertEquals } from "@std/assert";
import { ensureSingleton } from "../src/am/am-cmd-process.ts";
import { readPid, removePid, writePid } from "../src/am/am-utils.ts";
import {
  isProcessAlive,
  type LockData,
  STARTUP_GRACE_MS,
} from "../src/server/single-instance-lock.ts";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}
async function exitCode(fn: () => Promise<void>): Promise<number | null> {
  const real = Deno.exit;
  const realErr = console.error;
  const realLog = console.log;
  let code: number | null = null;
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  console.error = () => {};
  console.log = () => {};
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
    code = e.code;
  } finally {
    Deno.exit = real;
    console.error = realErr;
    console.log = realLog;
  }
  return code;
}

/** A child that lives until killed — the "booting app" whose pid the lock
 *  names. Its own liveness is the assertion. */
function bootingChild(): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    // A pending timer, not a bare never-resolving promise: Deno exits when
    // the event loop is empty, and a dead fixture makes the assertions moot.
    args: ["eval", "await new Promise((r) => setTimeout(r, 60_000))"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

const pf = (
  appId: string,
  o: Partial<LockData> & { pid: number },
): LockData => ({
  appId,
  port: 0,
  startedAt: Date.now(),
  status: "starting",
  cwd: Deno.cwd(),
  ...o,
});

Deno.test("am start: a 'starting' lock inside the grace is refused, never killed", async () => {
  const appId = `am-grace-${Deno.pid}-a`;
  const child = bootingChild();
  writePid(pf(appId, { pid: child.pid }));
  try {
    const code = await exitCode(() => ensureSingleton(appId, "json"));
    assertEquals(code, 1, "must refuse (exit 1)");
    await new Promise((r) => setTimeout(r, 200));
    assert(isProcessAlive(child.pid), "the booting app was killed");
    assert(readPid(appId) !== null, "its lock must survive");
  } finally {
    child.kill("SIGKILL");
    await child.status;
    removePid(appId);
  }
});

Deno.test("am start: past the grace with NO port to probe is still refused, never killed", async () => {
  const appId = `am-grace-${Deno.pid}-b`;
  const child = bootingChild();
  writePid(
    pf(appId, { pid: child.pid, startedAt: Date.now() - STARTUP_GRACE_MS * 2 }),
  );
  try {
    const code = await exitCode(() => ensureSingleton(appId, "json"));
    assertEquals(code, 1);
    await new Promise((r) => setTimeout(r, 200));
    assert(
      isProcessAlive(child.pid),
      "a port-0 lock must never be probed-and-killed",
    );
  } finally {
    child.kill("SIGKILL");
    await child.status;
    removePid(appId);
  }
});

Deno.test("am start: past the grace, a real port that does not answer IS a stuck instance", async () => {
  const appId = `am-grace-${Deno.pid}-c`;
  const child = bootingChild();
  // A port nothing listens on: reserve-and-release.
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  writePid(
    pf(appId, {
      pid: child.pid,
      port,
      startedAt: Date.now() - STARTUP_GRACE_MS * 2,
    }),
  );
  try {
    const code = await exitCode(() => ensureSingleton(appId, "json"));
    assertEquals(code, null, "a stuck instance is cleaned up, start proceeds");
    assert(!isProcessAlive(child.pid), "the stuck instance is killed");
    assertEquals(readPid(appId), null, "and its lock removed");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch { /* already dead */ }
    await child.status;
    removePid(appId);
  }
});
