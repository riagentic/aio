// A lock file must survive a round trip through `readLock`, whatever port the
// app runs on.
//
// `readLock` validated its fields with truthiness — `if (!data.appId ||
// !data.pid || !data.port) return null` — and `port: 0` is falsy. `port: 0` is
// not a corrupt value: it is the documented "pick a free port" setting, and it
// is written into the lock verbatim. So the lock of a port-0 app read back as
// INVALID, and the consequences compound in the worst possible direction:
//
//   1. `release()` guards on `readLock(...)` matching our pid, so it removed
//      nothing — the lock survived a fully GRACEFUL shutdown;
//   2. staleness is decided from the lock's own data, which `readLock` refuses
//      to hand over, so the leftover could never be recognised as stale either;
//   3. therefore the next launch refused to start, permanently, with
//      "Already running" — an app bricked until someone finds and deletes a
//      file in a runtime directory they have no reason to know about.
//
// A validity check must test the SHAPE of a field, never its truthiness, when
// zero is a legal value.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  AppLock,
  lockDir,
  readLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test("lock: a port-0 lock round-trips through readLock", () => {
  const appId = `lockzero-${crypto.randomUUID().slice(0, 8)}`;
  writeLock({
    appId,
    pid: Deno.pid,
    port: 0,
    startedAt: Date.now(),
    status: "starting",
    cwd: Deno.cwd(),
  });
  try {
    const back = readLock(appId);
    assert(
      back !== null,
      "a lock with port 0 must read back — 0 is a legal port ('pick a free " +
        "one'), not a missing field",
    );
    assertEquals(back.port, 0);
    assertEquals(back.pid, Deno.pid);
  } finally {
    try {
      Deno.removeSync(join(lockDir(), `${appId}.lock`));
    } catch { /* fine */ }
  }
});

Deno.test("lock: genuinely malformed records are still rejected", () => {
  // The fix must not turn the validity check into a rubber stamp.
  const appId = `lockbad-${crypto.randomUUID().slice(0, 8)}`;
  const path = join(lockDir(), `${appId}.lock`);
  const bad = [
    `{"pid":123,"port":80}`, // no appId
    `{"appId":"x","port":80}`, // no pid
    `{"appId":"x","pid":123}`, // no port
    `{"appId":"","pid":123,"port":80}`, // empty appId
    `{"appId":"x","pid":0,"port":80}`, // pid 0 is not a real process
    `{"appId":"x","pid":"123","port":80}`, // wrong type
    `not json at all`,
  ];
  try {
    for (const raw of bad) {
      Deno.writeTextFileSync(path, raw);
      assertEquals(readLock(appId), null, `must reject: ${raw}`);
    }
  } finally {
    try {
      Deno.removeSync(path);
    } catch { /* fine */ }
  }
});

Deno.test("lock: release() removes a port-0 lock", async () => {
  const appId = `lockrel-${crypto.randomUUID().slice(0, 8)}`;
  const lock = new AppLock(appId);
  const res = await lock.acquire(0, false);
  assertEquals(res.ok, true, "acquire must succeed");
  const path = join(lockDir(), `${appId}.lock`);
  assertEquals(exists(path), true, "lock file must exist while held");
  lock.release();
  assertEquals(
    exists(path),
    false,
    "release() must remove the lock file even when the app runs on port 0 — " +
      "otherwise a graceful shutdown leaks a lock that blocks the next launch",
  );
});

Deno.test({
  name: "lock: a port-0 app can be started, closed, and STARTED AGAIN",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // The end-to-end consequence, through a real app and a real graceful
    // close. This is what a developer actually hits: it worked once, and then
    // the app would never boot again.
    const dir = await Deno.makeTempDir({ prefix: "aio-lock-portzero-" });
    const appId = `portzero-${crypto.randomUUID().slice(0, 8)}`;
    const src = join(dir, "app.ts");
    await Deno.writeTextFile(
      src,
      `import { aio, cell } from "${REPO}/mod.ts";
const c = cell("p", { state: { n: 0 }, visible: "all", methods: {} });
const app = await aio.run({
  cells: [c], appId: ${JSON.stringify(appId)}, appVersion: "0.0.0",
  client: "server-only", persist: false, port: 0, appDir: ${
        JSON.stringify(dir)
      },
});
console.log("BOOTED");
await app.close();
console.log("CLOSED");
`,
    );
    const run = async () => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(REPO, "deno.json"), src],
        env: { ...Deno.env.toObject(), AIO_APPS_DIR: dir },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
    };

    const first = await run();
    assert(first.includes("BOOTED"), `first run must boot:\n${first}`);
    assert(first.includes("CLOSED"), `first run must close cleanly:\n${first}`);

    const second = await run();
    assert(
      !second.includes("Already running"),
      `the second launch was refused — the first app's graceful close leaked ` +
        `its lock, and nothing could recognise it as stale:\n${second}`,
    );
    assert(second.includes("BOOTED"), `second run must boot:\n${second}`);

    await Deno.remove(dir, { recursive: true }).catch(() => {});
  },
});

/** The recorded status of a lock file, or null when it is gone/unreadable. */
function statusOf(path: string): string | null {
  try {
    return (JSON.parse(Deno.readTextFileSync(path)) as { status?: string })
      .status ?? null;
  } catch {
    return null;
  }
}

Deno.test({
  name:
    "lock: SIGTERM marks EVERY lock in the process stopping, not just the first",
  ignore: Deno.build.os === "windows", // no POSIX signals
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // The signal listeners are installed once per process — correct — but the
    // handler used to close over ONE instance. A second locked app in the same
    // process (a supported shape: `singleton` defaults to true outside
    // libraryMode) saw the registration flag already set, returned early, and
    // got no handler at all — so whatever the signal does to a lock, it
    // happened to only one of two apps.
    //
    // What the signal DOES is mark the lock `stopping` — not release it. The
    // lock is released by shutdown's Phase 6, after the final persist; a
    // release at signal time left the app alive, listening and unlocked for
    // its whole shutdown (see tests/lock-lifetime.test.ts). So the assertion
    // here is: BOTH locks carry the mark, i.e. both are covered by the one
    // process-wide handler.
    const appsDir = await Deno.makeTempDir({ prefix: "aio-lock-multi-" });
    const src = join(appsDir, "probe.ts");
    await Deno.writeTextFile(
      src,
      `import { AppLock, lockDir } from "${REPO}/src/server/single-instance-lock.ts";
const a = new AppLock("multi-a");
const b = new AppLock("multi-b");
await a.acquire(31111, false);
await b.acquire(31112, false);
console.log("LOCKDIR " + lockDir());
console.log("READY");
// A real timer, not a never-resolving promise: an unresolved promise does NOT
// hold Deno's event loop open, so the child would exit as a side effect of the
// signal listeners being removed — making this test pass or hang for reasons
// that have nothing to do with the locks.
setInterval(() => {}, 1000);
`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(REPO, "deno.json"), src],
      env: { ...Deno.env.toObject(), AIO_APPS_DIR: appsDir },
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 20_000;
    while (!seen.includes("READY") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    assert(seen.includes("READY"), `probe never became ready:\n${seen}`);
    const dir = seen.match(/LOCKDIR (.+)/)?.[1]?.trim();
    assert(dir, `probe did not report its lock dir:\n${seen}`);

    const lockA = join(dir, "multi-a.lock");
    const lockB = join(dir, "multi-b.lock");
    assertEquals(exists(lockA), true, "app A must hold a lock");
    assertEquals(exists(lockB), true, "app B must hold a lock");

    // Signal, give the handler time to run, then INSPECT — never wait on the
    // child to exit. A regression here must fail with a clear assertion, not
    // hang until a CI timeout, and whether the process chooses to exit after
    // handling SIGTERM is a separate question from what it did to its locks.
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    const markA = statusOf(lockA);
    const markB = statusOf(lockB);
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
    await child.status;
    reader.cancel().catch(() => {});
    child.stderr.cancel().catch(() => {});

    assertEquals(
      markA,
      "stopping",
      "app A's lock must be marked stopping (and still held) on SIGTERM",
    );
    assertEquals(
      markB,
      "stopping",
      "app B's lock must be marked too — the SECOND lock in a process got " +
        "no signal handler at all",
    );

    await Deno.remove(appsDir, { recursive: true }).catch(() => {});
  },
});

Deno.test({
  name: "lock: one app closing must not un-protect the apps still running",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // The mirror image of the bug above, reached from the other side. The
    // signal listeners belong to the PROCESS, but they were torn down by
    // whichever lock released first. So in a two-app process where app A shuts
    // down normally and the process is signalled later, app B — still running,
    // still holding its lock — had no handler left and leaked.
    const appsDir = await Deno.makeTempDir({ prefix: "aio-lock-unreg-" });
    const src = join(appsDir, "probe.ts");
    await Deno.writeTextFile(
      src,
      `import { AppLock, lockDir } from "${REPO}/src/server/single-instance-lock.ts";
const a = new AppLock("unreg-a");
const b = new AppLock("unreg-b");
await a.acquire(31211, false);
await b.acquire(31212, false);
a.release();               // app A shuts down normally, B keeps running
console.log("LOCKDIR " + lockDir());
console.log("READY");
setInterval(() => {}, 1000);
`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(REPO, "deno.json"), src],
      env: { ...Deno.env.toObject(), AIO_APPS_DIR: appsDir },
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 20_000;
    while (!seen.includes("READY") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    assert(seen.includes("READY"), `probe never became ready:\n${seen}`);
    const dir = seen.match(/LOCKDIR (.+)/)?.[1]?.trim();
    assert(dir, `probe did not report its lock dir:\n${seen}`);

    const lockB = join(dir, "unreg-b.lock");
    assertEquals(
      exists(join(dir, "unreg-a.lock")),
      false,
      "app A released explicitly",
    );
    assertEquals(exists(lockB), true, "app B must still hold its lock");

    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    const markB = statusOf(lockB);
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
    await child.status;
    reader.cancel().catch(() => {});
    child.stderr.cancel().catch(() => {});

    assertEquals(
      markB,
      "stopping",
      "app B's lock must still be marked stopping on SIGTERM — app A's " +
        "earlier, unrelated shutdown must not remove the process's signal " +
        "handlers while another lock is still held",
    );

    await Deno.remove(appsDir, { recursive: true }).catch(() => {});
  },
});
