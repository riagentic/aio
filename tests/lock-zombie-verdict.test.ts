// Taking the lock of a LIVE process — the most dangerous thing the lock does.
//
// It took one refused connect. Measured on a real Windows machine, 10 of 60
// double-click pairs: the first launch's record said `started` 56 ms before
// its pipe was bound, the second launch probed in between, called a healthy
// app a zombie, took its lock, opened the same database, died on the pipe —
// and removed the lock on its way out, so the running app had none and the
// next double-click did it again.
//
// Two rules now, both pinned here:
//  · the verdict needs sustained evidence — every one of several probes,
//    seconds apart, must find NOTHING listening, on a record that has not
//    changed for the startup grace;
//  · a zombie by that verdict is ENDED before its lock is taken — it still
//    has the database open — and one that cannot be ended refuses the start;
//  · and whatever the lock file says, a live process that holds the data
//    folder's own OS lock refuses the start.
//
// The owner, for its part, keeps its record filed: a lock file removed under
// a running app is put back within one tick.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  _probeDeps,
  _stopDeps,
  _zombieDeps,
  AppLock,
  claimHome,
  endpointOf,
  type EndpointProbe,
  isProcessAlive,
  lockPath,
  probeEndpoint,
  readLock,
  removeLock,
  stopInstance,
  writeLock,
  ZOMBIE_PROBE_GAP_MS,
  ZOMBIE_PROBES,
  zombieLine,
} from "../src/server/single-instance-lock.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import { lockTick } from "../src/server/aio-run-helpers.ts";
import { _renameDeps } from "../src/diagnostics/rename-over.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { childEnv } from "./e2e-app-harness.ts";
import { stopChild } from "./stop-child.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = join(import.meta.dirname!, "..");
/** The repo as a URL — an import map (and an `import`) takes URLs: a bare
 *  Windows path, \`C:\\…\`, is not one, and the fixture app died at load. */
const REPO_URL = toFileUrl(REPO).href;
const GONE: EndpointProbe = { state: "gone", why: "Connection refused" };

/** A second launch onto a lock held by a live process (a `sleep`) whose
 *  record is `age` ms old and whose endpoint answers `answers[n]` to probe
 *  n (the last answer repeats). */
async function launchOnto(
  o: {
    age: number;
    answers: EndpointProbe[];
    touchAfter?: number;
    /** The zombie cannot be ended. */
    unendable?: boolean;
  },
): Promise<{
  ok: boolean;
  unendable: boolean;
  /** Was the holder alive when the acquire returned? */
  holderAlive: boolean;
  holder: number;
  probes: number;
  waited: number;
  said: string[];
  stillHolder: boolean;
}> {
  const appId = `zombie-verdict-${crypto.randomUUID().slice(0, 8)}`;
  const sleeper = new Deno.Command(Deno.execPath(), {
    // A live process of our own on every OS (Windows has no `sleep`).
    args: ["eval", "setTimeout(() => {}, 60_000)"],
  }).spawn();
  const real = { ..._zombieDeps };
  const said: string[] = [];
  let probes = 0, waited = 0;
  try {
    writeLock({
      appId,
      pid: sleeper.pid,
      port: 1,
      startedAt: Date.now() - 3_600_000,
      status: "started",
      cwd: Deno.cwd(),
      socketPath: "/nowhere/app.sock",
    });
    _zombieDeps.recordAge = () => o.age;
    _zombieDeps.delay = (ms) => {
      waited += ms;
      return Promise.resolve();
    };
    _zombieDeps.probe = () => {
      const a = o.answers[Math.min(probes, o.answers.length - 1)]!;
      probes++;
      // The holder writes its record while it is being judged.
      if (probes === o.touchAfter) {
        writeLock({ ...readLock(appId)!, port: 2 });
      }
      return Promise.resolve(a);
    };
    setLogger({
      pub: (lvl: string, _c: string, msg: string) =>
        void said.push(`${lvl} ${msg}`),
    } as unknown as LogSink);
    if (o.unendable) _zombieDeps.end = () => Promise.resolve(false);
    const lock = new AppLock(appId);
    const r = await lock.acquire(4500);
    const holderAlive = isProcessAlive(sleeper.pid);
    const now = readLock(appId);
    if (r.ok) lock.release();
    return {
      ok: r.ok,
      unendable: !r.ok && r.unendable === true,
      holderAlive,
      holder: sleeper.pid,
      probes,
      waited,
      said,
      stillHolder: now?.pid === sleeper.pid && holderAlive,
    };
  } finally {
    setLogger(null);
    Object.assign(_zombieDeps, real);
    removeLock(appId);
    await stopChild(sleeper, { quiet: true });
  }
}

const OLD = 3_600_000;

Deno.test("zombie verdict: every probe finds nothing, on a settled record → the zombie is ENDED, then its lock is taken, and it says what it saw", async () => {
  const r = await launchOnto({ age: OLD, answers: [GONE] });
  assertEquals(r.ok, true);
  assertEquals(r.probes, ZOMBIE_PROBES);
  assertEquals(r.waited, (ZOMBIE_PROBES - 1) * ZOMBIE_PROBE_GAP_MS);
  assertEquals(r.holderAlive, false, "taken over from a process still alive");
  assert(r.said.some((l) => l.includes("Ending it to take over")));
  const line = r.said.find((l) => l.includes("stale instance"));
  assert(line?.startsWith("warn "), r.said.join("\n"));
  assertStringIncludes(line!, `pid ${r.holder} is alive but nothing listens`);
  assertStringIncludes(line!, `${ZOMBIE_PROBES} connection attempts`);
  assertStringIncludes(line!, "Connection refused");
  assertStringIncludes(line!, "/nowhere/app.sock");
});

Deno.test("zombie verdict: a zombie that cannot be ended refuses the start — its lock is not taken", async () => {
  const r = await launchOnto({ age: OLD, answers: [GONE], unendable: true });
  assertEquals([r.ok, r.unendable], [false, true]);
  assertEquals(r.stillHolder, true, "the lock still names the live process");
  assert(r.said.some((l) => l.includes("stale instance")), r.said.join("\n"));
});

Deno.test("zombie verdict: one refused connect is not evidence — refused once, then it answers", async () => {
  const r = await launchOnto({ age: OLD, answers: [GONE, { state: "up" }] });
  assertEquals([r.ok, r.stillHolder, r.unendable], [false, true, false]);
  assertEquals(r.probes, 2);
  assertEquals(r.said.filter((l) => l.includes("stale instance")), []);
});

Deno.test("zombie verdict: refused through all probes but the last → alive", async () => {
  const answers = Array.from({ length: ZOMBIE_PROBES - 1 }, () => GONE);
  const r = await launchOnto({
    age: OLD,
    answers: [...answers, { state: "up" }],
  });
  assertEquals([r.ok, r.stillHolder], [false, true]);
  assertEquals(r.probes, ZOMBIE_PROBES);
});

Deno.test("zombie verdict: an endpoint that is there but busy is a listener → alive", async () => {
  const busy: EndpointProbe = { state: "busy", why: "ERROR_PIPE_BUSY" };
  const r = await launchOnto({ age: OLD, answers: [busy] });
  assertEquals([r.ok, r.stillHolder, r.probes], [false, true, 1]);
  const late = await launchOnto({ age: OLD, answers: [GONE, GONE, busy] });
  assertEquals([late.ok, late.stillHolder, late.probes], [false, true, 3]);
});

Deno.test("zombie verdict: a record that changed within the startup grace is never judged", async () => {
  for (const age of [0, 56, 9_999]) {
    const r = await launchOnto({ age, answers: [GONE] });
    assertEquals([r.ok, r.stillHolder, r.probes], [false, true, 0], `${age}`);
  }
});

Deno.test("zombie verdict: a holder that writes its record while judged is judged afresh, not reclaimed on the old evidence", async () => {
  const r = await launchOnto({ age: OLD, answers: [GONE], touchAfter: 3 });
  // The record moved at probe 3: that verdict is dropped; the second one
  // (the stubbed age still says settled) runs its own full set.
  assertEquals(r.probes, 3 + ZOMBIE_PROBES);
  assertEquals(r.ok, true);
});

Deno.test("probeEndpoint: only 'nothing is there' is gone", async () => {
  const dir = await tempDir("probe-endpoint-");
  try {
    assertEquals(await probeEndpoint({ port: 0 }), null, "nothing to probe");
    // No socket file — on Windows, no pipe: an app's local endpoint there is
    // a named pipe (`connectLocal`), never a file path.
    const none = await probeEndpoint({
      port: 0,
      socketPath: Deno.build.os === "windows"
        ? `\\\\.\\pipe\\aio-none-${crypto.randomUUID()}`
        : join(dir, "none.sock"),
    });
    assertEquals(none?.state, "gone");
    // Unix socket FILES — POSIX only: Windows apps listen on named pipes, and
    // Deno has no unix transport there.
    if (Deno.build.os !== "windows") {
      // A socket file nobody listens on.
      // (left by a process that ended without closing its listener)
      const stale = join(dir, "stale.sock");
      await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `Deno.listen({ transport: "unix", path: ${
            JSON.stringify(stale)
          } });` +
          `Deno.exit(0);`,
        ],
        stdout: "null",
        stderr: "null",
      }).output();
      assert(Deno.statSync(stale).isSocket, "the fixture: a socket file");
      assertEquals(
        (await probeEndpoint({ port: 0, socketPath: stale }))?.state,
        "gone",
      );
      // A listener.
      const live = join(dir, "live.sock");
      const l = Deno.listen({ transport: "unix", path: live });
      try {
        assertEquals(
          (await probeEndpoint({ port: 0, socketPath: live }))?.state,
          "up",
        );
      } finally {
        l.close();
      }
    }
    // A TCP port: listening, then closed.
    const t = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (t.addr as Deno.NetAddr).port;
    const host = "127.0.0.1";
    assertEquals((await probeEndpoint({ port, host }))?.state, "up");
    assertEquals(await probeEndpoint({ port }), null, "no address: no probe");
    t.close();
    assertEquals((await probeEndpoint({ port, host }))?.state, "gone");
    // A listener on another address is probed THERE, not on 127.0.0.1.
    if (Deno.build.os === "linux") {
      const two = Deno.listen({ hostname: "127.0.0.2", port: 0 });
      const p2 = (two.addr as Deno.NetAddr).port;
      try {
        assertEquals(
          (await probeEndpoint({ port: p2, host: "127.0.0.2" }))?.state,
          "up",
        );
      } finally {
        two.close();
      }
    }
    // A socket that is there and will not take this caller (no permission
    // to connect): a listener — busy, never gone.
    if (Deno.build.os !== "windows" && Deno.uid() !== 0) {
      const shut = join(dir, "shut.sock");
      const s = Deno.listen({ transport: "unix", path: shut });
      try {
        Deno.chmodSync(shut, 0o000);
        const r = await probeEndpoint({ port: 0, socketPath: shut });
        assertEquals(r?.state, "busy", r?.why);
      } finally {
        s.close();
      }
    }
    // A plain file where the socket should be: nothing listens there.
    // POSIX only — a Windows app's endpoint is a pipe NAME, never a file
    // path, and Deno has no unix transport there to ask a file with (its
    // connect fails without saying "nothing there", so the probe stays
    // `busy`, the safe answer).
    if (Deno.build.os !== "windows") {
      const notASocket = join(dir, "file.sock");
      Deno.writeTextFileSync(notASocket, "x");
      assertEquals(
        (await probeEndpoint({ port: 0, socketPath: notASocket }))?.state,
        "gone",
        "a plain file refuses: nothing listens there",
      );
    }
  } finally {
    await dropTempDir(dir);
  }
});

// ── the data folder's own lock ────────────────────────────────────────────

Deno.test("claimHome: a live holder refuses whatever lock names it", async () => {
  const dir = await tempDir("claim-live-");
  try {
    const who = { appId: "claim-live", port: 0, key: "claim-live" };
    const first = claimHome(dir, who);
    assert(first.ok);
    try {
      // The same lock, the same lock dir — it used to be let through.
      const second = claimHome(dir, who);
      assertEquals(second.ok, false);
      assert(!second.ok && second.holder?.pid === Deno.pid);
      assertEquals(second.holder?.lock, lockPath("claim-live"));
    } finally {
      first.close();
    }
    const after = claimHome(dir, who);
    assert(after.ok, "free once its holder let go");
    after.close();
  } finally {
    await dropTempDir(dir);
  }
});

// ── the owner keeps its record filed ──────────────────────────────────────

Deno.test("reassert: a lock file that is gone, or names a dead process, is filed again as the owner last wrote it; a live rival's is left", async () => {
  const appId = `reassert-${crypto.randomUUID().slice(0, 8)}`;
  const lock = new AppLock(appId);
  const said: string[] = [];
  setLogger({
    pub: (lvl: string, _c: string, msg: string) =>
      void said.push(`${lvl} ${msg}`),
  } as unknown as LogSink);
  const rival = new Deno.Command(Deno.execPath(), {
    // A live process of our own on every OS (Windows has no `sleep`).
    args: ["eval", "setTimeout(() => {}, 60_000)"],
  }).spawn();
  try {
    assertEquals((await lock.acquire(4600)).ok, true);
    lock.update({ status: "started", port: 4601 });
    const mine = readLock(appId)!;
    assertEquals(lock.reassert(), false, "nothing to do while it is there");
    assertEquals(said, []);

    Deno.removeSync(lockPath(appId));
    assertEquals(lock.reassert(), true);
    assertEquals(readLock(appId), mine);
    assert(
      said.at(-1)!.startsWith("warn ") && said.at(-1)!.includes("was gone"),
    );
    // …and it is the owner's file again: the next change lands in it.
    lock.update({ port: 4602 });
    assertEquals(readLock(appId)!.port, 4602);

    // A dead owner's record in its place (another file under the name, as
    // a launch that took it leaves).
    Deno.removeSync(lockPath(appId));
    Deno.writeTextFileSync(
      lockPath(appId),
      JSON.stringify({ ...mine, pid: 2 ** 22 - 5, startToken: undefined }),
    );
    assertEquals(lock.reassert(), true);
    assertEquals(readLock(appId)!.pid, Deno.pid);
    assert(said.at(-1)!.includes("named a process that is gone"));

    // A LIVE process's record: not this owner's to remove.
    const theirs = JSON.stringify({
      ...mine,
      pid: rival.pid,
      startToken: undefined,
      startEpoch: undefined,
    });
    Deno.removeSync(lockPath(appId));
    Deno.writeTextFileSync(lockPath(appId), theirs);
    assertEquals(lock.reassert(), false);
    assertEquals(Deno.readTextFileSync(lockPath(appId)), theirs);
    removeLock(appId);
    assertEquals(lock.reassert(), true);

    // An UNREADABLE file there: a launch still writing it is not judged
    // while it is younger than a second; an older one is debris, replaced.
    Deno.removeSync(lockPath(appId));
    Deno.writeTextFileSync(lockPath(appId), "{");
    assertEquals(lock.reassert(), false, "young: not judged");
    assertEquals(Deno.readTextFileSync(lockPath(appId)), "{");
    const old = new Date(Date.now() - 5_000);
    Deno.utimeSync(lockPath(appId), old, old);
    assertEquals(lock.reassert(), true, "old: filed again");
    assertEquals(readLock(appId)!.pid, Deno.pid);

    // Released — shutting down: it files NOTHING again, ever.
    lock.release();
    assertEquals(lock.reassert(), false);
    assertEquals(readLock(appId), null);
  } finally {
    setLogger(null);
    lock.release();
    await stopChild(rival, { quiet: true });
  }
});

Deno.test({
  name:
    "zombie end: a process that is still there after it was asked and forced is NOT ended — false, and the launch refuses",
  ignore: Deno.build.os !== "linux", // a defunct pid, read from /proc
  async fn() {
    // A child that ended and was never reaped by its parent: every signal
    // is delivered, and it is still in the process table — "alive" to
    // every check the lock makes. `end` must say it did not end it.
    const parent = new Deno.Command("sh", {
      args: ["-c", "sleep 0 & echo $!; exec sleep 30"],
      stdout: "piped",
    }).spawn();
    const reader = parent.stdout.getReader();
    const pid = Number(new TextDecoder().decode((await reader.read()).value));
    reader.releaseLock();
    try {
      for (let i = 0; i < 100; i++) {
        if (Deno.readTextFileSync(`/proc/${pid}/stat`).split(" ")[2] === "Z") {
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      const ended = await _zombieDeps.end({
        appId: "zombie-end",
        pid,
        port: 0,
        startedAt: 0,
        status: "started",
        cwd: "/",
      });
      assertEquals([ended, isProcessAlive(pid)], [false, true]);
    } finally {
      parent.kill("SIGKILL");
      await parent.stdout.cancel();
      await parent.status;
    }
  },
});

// ── two real processes ────────────────────────────────────────────────────
//
// A: a real app, up and serving. B: a second launch of the same app, with the
// endpoint's answers planted (the seam) or A's lock file taken away.

const APP = `import { aio, cell } from "aio";
import { _zombieDeps } from "aio/server/single-instance-lock.ts";
import { acquireSingletonLock, LOCK_REFILE_MS } from "aio/server/aio-run-helpers.ts";
import { appHome } from "aio/server/app-dirs.ts";
const role = Deno.env.get("ROLE")!;
// HELD_FLAG: while that file exists, the lock file cannot be removed — what
// Windows answers while another program has it open without delete sharing.
const heldFlag = Deno.env.get("HELD_FLAG");
if (heldFlag) {
  const { _renameDeps } = await import("aio/diagnostics/rename-over.ts");
  const realRemove = _renameDeps.remove;
  _renameDeps.windows = () => true;
  _renameDeps.pause = () => {};
  _renameDeps.remove = (p) => {
    let held = false;
    try { Deno.statSync(heldFlag); held = true; } catch { /* free */ }
    if (held && p.endsWith(".lock")) {
      throw new Deno.errors.PermissionDenied("Access is denied. (os error 5)");
    }
    realRemove(p);
  };
}
// PLANT_DEAD: the previous run of this app was killed — its record names a
// pid that is gone, and its data folder is there.
if (Deno.env.get("PLANT_DEAD")) {
  const { writeLock } = await import("aio/server/single-instance-lock.ts");
  const { appHome } = await import("aio/server/app-dirs.ts");
  const gone = new Deno.Command(Deno.execPath(), { args: ["eval", "0"] }).spawn();
  await gone.status;
  Deno.mkdirSync(appHome(Deno.env.get("APP_ID")!), { recursive: true });
  writeLock({ appId: Deno.env.get("APP_ID")!, pid: gone.pid, port: 1,
    startedAt: Date.now() - 60_000, status: "started", cwd: Deno.cwd() });
}
const seam = Deno.env.get("SEAM");
if (seam) {
  const real = _zombieDeps.probe;
  const t0 = Date.now();
  let n = 0;
  _zombieDeps.probe = async (l) => {
    n++;
    console.log("PROBE " + n);
    if (seam === "once" && n === 1) return { state: "gone", why: "planted" };
    if (seam === "200ms" && Date.now() - t0 < 200) {
      return { state: "gone", why: "planted" };
    }
    if (seam === "busy") return { state: "busy", why: "planted" };
    return await real(l);
  };
}
// "settled": judge the holder although its record is fresh — the probes
// decide. The gaps are part of the rule; their length is not what is tested.
if (Deno.env.get("SETTLED")) {
  _zombieDeps.recordAge = () => 3_600_000;
  _zombieDeps.delay = (ms) => new Promise((r) => setTimeout(r, ms / 10));
}
if (Deno.env.get("REFILE")) LOCK_REFILE_MS.value = Number(Deno.env.get("REFILE"));
if (Deno.env.get("END") === "cannot") {
  _zombieDeps.end = () => Promise.resolve(false);
}
if (role === "Z") {
  // A zombie: alive, holding the app's lock and its data folder, its record
  // "started" on a port nothing listens on.
  // Port 1: nothing listens there, and no listener of the second launch is
  // ever given it — a port merely closed a moment ago is the next one the
  // kernel hands out, and the second launch's own listener then answered.
  const host = "127.0.0.1", dead = 1;
  const appId = Deno.env.get("APP_ID")!;
  Deno.mkdirSync(appHome(appId), { recursive: true });
  const lock = await acquireSingletonLock(appId, undefined, dead, true, false);
  lock!.update({ status: "started", port: dead, host });
  console.log("Z UP " + Deno.pid);
  // Deaf to SIGTERM, like a process stuck in a loop: only a forced end works.
  Deno.addSignalListener("SIGTERM", () => {});
  for await (const _ of Deno.stdin.readable) { /* hold */ }
  Deno.exit(0);
}
const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
const host = Deno.env.get("HOST"), appDir = Deno.env.get("APP_DIR");
// ONSTOP: a file the app's onStop writes after a 300 ms flush — it exists
// only if the app stopped gracefully, and was not cut off.
const onStopFile = Deno.env.get("ONSTOP");
const app = await aio.run({ appId: Deno.env.get("APP_ID")!, cells: [c],
  client: "server-only", port: 0, ...(host ? { host } : {}),
  ...(appDir ? { appDir } : {}),
  ...(Deno.env.get("TAKEOVER") ? { takeover: true } : {}),
  ...(onStopFile ? { onStop: async () => {
    await new Promise((r) => setTimeout(r, 300));
    Deno.writeTextFileSync(onStopFile, "ran");
  } } : {}) });
console.log(role + " UP " + Deno.pid);
if (role === "B") { await app.stop?.(); Deno.exit(0); }
// A stays until its stdin closes.
for await (const _ of Deno.stdin.readable) { /* hold */ }
await app.stop?.();
Deno.exit(0);
`;

/** The running app's log directory, under `dir` (where its `.rotate`
 *  claim is — its log files are created on their first line). */
function logDirOf(dir: string): string {
  const walk = (d: string): string | null => {
    for (const e of Deno.readDirSync(d)) {
      if (e.isFile && e.name === ".rotate") return d;
      if (e.isDirectory) {
        const r = walk(join(d, e.name));
        if (r) return r;
      }
    }
    return null;
  };
  const found = walk(dir);
  if (!found) throw new Error(`no log directory under ${dir}`);
  return found;
}

/** Start A, run `withA` once it is up, stop A. */
async function withRunningApp<T>(
  role: "A" | "Z",
  first: Record<string, string>,
  withA: (o: {
    pid: number;
    appId: string;
    dir: string;
    launchB: (env: Record<string, string>) => Promise<{
      code: number;
      out: string;
    }>;
    lockFile: string;
    alive: () => Promise<boolean>;
  }) => Promise<T>,
): Promise<T> {
  const dir = await tempDir("lock-two-procs-");
  const appId = `two-procs-${Deno.pid}-${crypto.randomUUID().slice(0, 6)}`;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: {
        "aio": `${spec(REPO_URL)}/mod.ts`,
        "aio/": `${spec(REPO_URL)}/src/`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@1.1.2",
      },
    }),
  );
  await Deno.writeTextFile(join(dir, "app.ts"), APP);
  const env = (extra: Record<string, string>) =>
    childEnv({ AIO_APPS_DIR: join(dir, "apps"), APP_ID: appId, ...extra });
  // ARGS: the app's own command line (`--prod`), space-separated.
  const argv = (e: Record<string, string>) => e.ARGS ? e.ARGS.split(" ") : [];
  const a = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(dir, "app.ts"), ...argv(first)],
    cwd: dir,
    env: env({ ROLE: role, ...first }),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const dec = new TextDecoder();
  let seen = "";
  const reader = a.stdout.getReader();
  // A's stderr, kept: every failure below carries it, so one that comes
  // from A explains itself.
  let aErr = "";
  let failed: unknown;
  const errs = a.stderr.pipeTo(
    new WritableStream({ write: (c) => void (aErr += dec.decode(c)) }),
  );
  try {
    let pid = 0;
    while (pid === 0) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`${role} ended before it was up:\n${seen}`);
      seen += dec.decode(value);
      pid = Number(new RegExp(`${role} UP (\\d+)`).exec(seen)?.[1] ?? 0);
    }
    // The lock dir is derived from AIO_APPS_DIR; ask a child where it is.
    const where = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { lockKey, lockPath } from "${
          spec(REPO_URL)
        }/src/server/single-instance-lock.ts";` +
        `import { appDirs } from "${spec(REPO_URL)}/src/server/app-dirs.ts";` +
        `const id = ${JSON.stringify(appId)}, dir = ${
          JSON.stringify(first.APP_DIR ?? "")
        };` +
        `console.log(lockPath(dir ? lockKey(id, appDirs(id, dir).home) : id));`,
      ],
      env: env({}),
      stdout: "piped",
      stderr: "null",
    }).output();
    const lockFile = dec.decode(where.stdout).trim();
    const rec = JSON.parse(Deno.readTextFileSync(lockFile));
    const servedOn = rec.port, servedAt = rec.host ?? "127.0.0.1";
    return await withA({
      pid,
      appId,
      dir,
      lockFile,
      alive: async () => {
        try {
          (await Deno.connect({ hostname: servedAt, port: servedOn }))
            .close();
          return true;
        } catch {
          return false;
        }
      },
      launchB: async (extra) => {
        const r = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", join(dir, "app.ts"), ...argv(extra)],
          cwd: dir,
          env: env({ ROLE: "B", ...extra }),
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
          signal: AbortSignal.timeout(60_000),
        }).output();
        return {
          code: r.code,
          out: dec.decode(r.stdout) + dec.decode(r.stderr),
        };
      },
    });
  } catch (e) {
    failed = e;
    throw e;
  } finally {
    reader.releaseLock();
    await a.stdin.close().catch(() => {/* aio-ok: A already ended */});
    await a.stdout.cancel().catch(() => {/* aio-ok: A already ended */});
    await errs.catch(() => {/* aio-ok: A already ended */});
    await a.status;
    if (failed instanceof Error) {
      failed.message += `\n--- ${role}'s stderr ---\n${aErr || "(empty)"}`;
    }
    await dropTempDir(dir);
  }
}

for (const seam of ["once", "200ms", "busy"]) {
  Deno.test({
    name: `two launches: the running app's endpoint ${
      seam === "once"
        ? "refuses ONE connect"
        : seam === "200ms"
        ? "refuses for 200 ms"
        : "is busy"
    } — the second launch does not take its lock, and never starts`,
    async fn() {
      await withRunningApp("A", {}, async (a) => {
        const b = await a.launchB({ SEAM: seam, SETTLED: "1" });
        assertEquals(b.code, 1, b.out);
        assertStringIncludes(b.out, "Already running");
        assert(!b.out.includes("B UP"), b.out);
        assert(!b.out.includes("stale instance"), b.out);
        assertStringIncludes(b.out, "PROBE 1");
        assertEquals(
          JSON.parse(Deno.readTextFileSync(a.lockFile)).pid,
          a.pid,
          "the running app keeps its lock",
        );
        assert(await a.alive());
      });
    },
  });
}

Deno.test({
  name:
    "two launches: a running app whose lock file is GONE still refuses the second launch — the data folder's own lock names it",
  async fn() {
    // REFILE: the running app's own slow tick files its lock again (every
    // 5 s) — a second launch that came after that tick met the lock FILE and
    // was refused in its words, not the data folder's. Held off here: this
    // is the launch that finds no file.
    await withRunningApp("A", { REFILE: "600000" }, async (a) => {
      // The running app's logs, as they are before the second launch (one
      // line it has written, so there is something a rotation would move).
      const logs = logDirOf(a.dir);
      Deno.writeTextFileSync(join(logs, "app.log"), "the running app\n", {
        append: true,
      });
      // Archives only: the refused launch appends its own refusal to the
      // live files, as every refused start does.
      const names = () =>
        [...Deno.readDirSync(logs)].map((e) => e.name)
          .filter((n) => /\.\d+$/.test(n)).sort();
      const before = names();
      // …and its own start long past: the once-per-start window of the log
      // pass is not what keeps a second launch's hands off here.
      const hourAgo = new Date(Date.now() - 3_600_000);
      Deno.utimeSync(join(logs, ".rotate"), hourAgo, hourAgo);
      const claim = Deno.readTextFileSync(join(logs, ".rotate"));
      const live = Deno.readTextFileSync(join(logs, "app.log"));
      Deno.removeSync(a.lockFile);
      const b = await a.launchB({});
      // A losing launch touches nothing of the running app: no rotation.
      assertEquals(names(), before, "the running app's logs were archived");
      assertEquals(Deno.readTextFileSync(join(logs, ".rotate")), claim);
      assert(
        live.includes("the running app\n") &&
          Deno.readTextFileSync(join(logs, "app.log")).startsWith(live),
        "the live app.log was replaced",
      );
      assertEquals(b.code, 1, b.out);
      assert(!b.out.includes("B UP"), b.out);
      assertStringIncludes(b.out, `is already running (pid ${a.pid})`);
      assertStringIncludes(b.out, "it holds the data folder");
      assert(!b.out.includes("sqlite: opened"), b.out);
      assert(await a.alive());
      // …and the launch that was refused left no lock of its own behind.
      let left = true;
      try {
        Deno.statSync(a.lockFile);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        left = false;
      }
      assertEquals(left, false);
    });
  },
});

Deno.test({
  name:
    "two launches: a running app whose record is fresh is not judged at all — the second launch makes no probe",
  async fn() {
    await withRunningApp("A", {}, async (a) => {
      // The probes are planted, and would count as they are made.
      const b = await a.launchB({ SEAM: "once" });
      assertEquals(b.code, 1, b.out);
      assertStringIncludes(b.out, "Already running");
      assert(!b.out.includes("PROBE"), b.out);
      assert(!b.out.includes("B UP"), b.out);
      assertEquals(JSON.parse(Deno.readTextFileSync(a.lockFile)).pid, a.pid);
    });
  },
});

// ── a real zombie: alive, deaf, holding the lock and the data folder ──

Deno.test({
  name:
    "a real zombie holding the data folder is ended first, then this launch takes over and starts",
  async fn() {
    await withRunningApp("Z", {}, async (z) => {
      const b = await z.launchB({ SETTLED: "1" });
      assertEquals(b.code, 0, b.out);
      assertStringIncludes(b.out, `pid ${z.pid} is alive but nothing listens`);
      assertStringIncludes(b.out, "Ending it to take over");
      assertStringIncludes(b.out, "B UP");
      assertEquals(isProcessAlive(z.pid), false, "the zombie is gone");
    });
  },
});

Deno.test({
  name:
    "a zombie that cannot be ended: the launch refuses, exit 1, names the pid and what to do — and never opens the database",
  async fn() {
    await withRunningApp("Z", {}, async (z) => {
      const b = await z.launchB({ SETTLED: "1", END: "cannot" });
      assertEquals(b.code, 1, b.out);
      assertStringIncludes(b.out, "could not be ended");
      assertStringIncludes(b.out, `kill -9 ${z.pid}`);
      assert(!b.out.includes("B UP"), b.out);
      assert(!b.out.includes("Already running"), b.out);
      assertEquals(isProcessAlive(z.pid), true);
      assertEquals(JSON.parse(Deno.readTextFileSync(z.lockFile)).pid, z.pid);
    });
  },
});

// ── the owner re-files its record ──

Deno.test({
  name:
    "a lock file deleted under a running app is filed again within one tick — the app is found again, and a second launch is a second launch",
  async fn() {
    await withRunningApp("A", { REFILE: "100" }, async (a) => {
      const before = JSON.parse(Deno.readTextFileSync(a.lockFile));
      Deno.removeSync(a.lockFile);
      // Found again: the same record, at the same path, by the same reader
      // `am` uses. Looked for until it is there (the tick is 100 ms here).
      let found: Record<string, unknown> | null = null;
      for (const until = Date.now() + 20_000; Date.now() < until;) {
        try {
          found = JSON.parse(Deno.readTextFileSync(a.lockFile));
          break;
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      assertEquals(found, before, "the record as the owner last wrote it");
      const b = await a.launchB({});
      assertEquals(b.code, 1, b.out);
      assertStringIncludes(b.out, "Already running");
      assert(!b.out.includes("it holds the data folder"), b.out);
      assert(await a.alive());
    });
  },
});

// ── an app bound to another address ──
//
// The record named a port and not the address: a reader connected to
// 127.0.0.1, an app bound to 127.0.0.2 (or a LAN address, or ::1) refused
// there forever, and once its record was 10 s old a second launch ENDED it.

Deno.test({
  name:
    "an app bound to 127.0.0.2: its record names that address, it is probed THERE, and a second launch is refused — the app keeps running",
  ignore: Deno.build.os !== "linux", // 127.0.0.0/8 is all loopback on Linux
  async fn() {
    await withRunningApp("A", { HOST: "127.0.0.2" }, async (a) => {
      const rec = JSON.parse(Deno.readTextFileSync(a.lockFile));
      assertEquals([rec.host, rec.status], ["127.0.0.2", "started"]);
      // Settled: judged as a record more than 10 s old; the probes are real.
      const b = await a.launchB({ SETTLED: "1" });
      assertEquals(b.code, 1, b.out);
      assertStringIncludes(b.out, "Already running");
      assertStringIncludes(b.out, `http://127.0.0.2:${rec.port}`);
      assert(!b.out.includes("stale instance"), b.out);
      assert(!b.out.includes("B UP"), b.out);
      assertEquals(JSON.parse(Deno.readTextFileSync(a.lockFile)).pid, a.pid);
      assert(await a.alive(), "the app was ended");
    });
  },
});

Deno.test({
  name:
    "a record that names a port but no address (an older aio wrote it) proves nothing: never a zombie — the launch is refused, naming the pid and how to stop it",
  ignore: Deno.build.os !== "linux", // 127.0.0.0/8 is all loopback on Linux
  async fn() {
    await withRunningApp("A", { HOST: "127.0.0.2" }, async (a) => {
      const rec = JSON.parse(Deno.readTextFileSync(a.lockFile));
      delete rec.host;
      writeLock(rec); // as 1.0.16 wrote it: the port, not where it is bound
      const b = await a.launchB({ SETTLED: "1" });
      assertEquals(b.code, 1, b.out);
      assertStringIncludes(b.out, "Already running");
      assertStringIncludes(b.out, `kill ${a.pid}`);
      assertStringIncludes(b.out, "am stop --app=");
      assert(!b.out.includes("stale instance"), b.out);
      assert(!b.out.includes("B UP"), b.out);
      assert(await a.alive(), "the app was ended");
    });
  },
});

Deno.test("endpointOf: the socket, else the address the record names — a wildcard on loopback (`::` on both families); nothing when the address is not there", () => {
  assertEquals(endpointOf({ port: 80, host: "x", socketPath: "/s" }), {
    socket: "/s",
  });
  const tcp = (host: string) => endpointOf({ port: 80, host });
  assertEquals(tcp("127.0.0.2"), { hostnames: ["127.0.0.2"], port: 80 });
  assertEquals(tcp("0.0.0.0"), { hostnames: ["127.0.0.1"], port: 80 });
  assertEquals(tcp("::"), { hostnames: ["::1", "127.0.0.1"], port: 80 });
  assertEquals(tcp("[::1]"), { hostnames: ["::1"], port: 80 });
  assertEquals(endpointOf({ port: 80 }), null, "a port alone names no address");
  assertEquals(tcp(""), null);
  assertEquals(endpointOf({ port: 0, host: "127.0.0.1" }), null);
});

/** Probe a `::` record on a machine whose candidates answer as `answers`
 *  says (by hostname): "ok" accepts, else the error is thrown. */
async function probeDual(
  answers: Record<string, "ok" | Error>,
): Promise<EndpointProbe | null> {
  const real = _probeDeps.connect;
  _probeDeps.connect = (o) => {
    const a = answers[o.hostname];
    if (a === undefined) throw new Error(`unexpected ${o.hostname}`);
    if (a === "ok") return Promise.resolve({ close() {} } as Deno.Conn);
    return Promise.reject(a);
  };
  try {
    return await probeEndpoint({ port: 4700, host: "::" });
  } finally {
    _probeDeps.connect = real;
  }
}

Deno.test("probeEndpoint on a `::` bind: both loopbacks — an address this machine cannot reach counts for nothing, never for 'busy' beside a definite refusal", async () => {
  const noV6 = () =>
    new Deno.errors.AddrNotAvailable(
      "Cannot assign requested address (os error 99)",
    );
  const refused = () =>
    new Deno.errors.ConnectionRefused("Connection refused (os error 111)");
  // A dual-stack zombie on a machine with no IPv6 loopback: gone.
  assertEquals(
    (await probeDual({ "::1": noV6(), "127.0.0.1": refused() }))?.state,
    "gone",
  );
  // A healthy `::` holder there: alive.
  assertEquals(
    (await probeDual({ "::1": noV6(), "127.0.0.1": "ok" }))?.state,
    "up",
  );
  // Any accept is alive.
  assertEquals(
    (await probeDual({ "::1": "ok", "127.0.0.1": refused() }))?.state,
    "up",
  );
  // Both refuse: gone.
  assertEquals(
    (await probeDual({ "::1": refused(), "127.0.0.1": refused() }))?.state,
    "gone",
  );
  // No definite answer from any: the safe side.
  assertEquals(
    (await probeDual({ "::1": noV6(), "127.0.0.1": noV6() }))?.state,
    "busy",
  );
  // A listener that is there and busy on one: busy, whatever the other says.
  assertEquals(
    (await probeDual({
      "::1": new Deno.errors.TimedOut("timed out"),
      "127.0.0.1": refused(),
    }))?.state,
    "busy",
  );
});

Deno.test("probeEndpoint on a `::` bind, for real: up while it listens, gone once it is closed", async () => {
  let l: Deno.Listener;
  try {
    l = Deno.listen({ hostname: "::", port: 0 });
  } catch {
    return; // aio-ok: no IPv6 on this machine — the seam cases above hold
  }
  const port = (l.addr as Deno.NetAddr).port;
  assertEquals((await probeEndpoint({ port, host: "::" }))?.state, "up");
  l.close();
  assertEquals((await probeEndpoint({ port, host: "::" }))?.state, "gone");
});

// ── a socket file removed under a running app ──

Deno.test({
  name:
    "lockTick: a socket file removed under the running app is said once per loss, loudly — and a launch that ends it says the file is gone",
  ignore: Deno.build.os === "windows", // a pipe name is no file to remove
  async fn() {
    const appId = `socket-gone-${crypto.randomUUID().slice(0, 8)}`;
    const dir = await tempDir("socket-gone-");
    const sock = join(dir, "app.sock");
    const said: string[] = [];
    setLogger({
      pub: (lvl: string, _c: string, msg: string) =>
        void said.push(`${lvl} ${msg}`),
    } as unknown as LogSink);
    const lock = new AppLock(appId);
    let l = Deno.listen({ transport: "unix", path: sock });
    try {
      assertEquals((await lock.acquire(0)).ok, true);
      lock.update({ status: "started", port: 0, socketPath: sock });
      const seen: { gone?: string } = {};
      lockTick(lock, seen);
      assertEquals(said, [], "there: nothing to say");
      Deno.removeSync(sock); // the cleaner
      lockTick(lock, seen);
      lockTick(lock, seen);
      assertEquals(said.length, 1, said.join("\n"));
      assert(said[0]!.startsWith("warn "), said[0]);
      assertStringIncludes(said[0]!, sock);
      assertStringIncludes(said[0]!, "END it");
      // What a launch judging it then says.
      assertStringIncludes(
        zombieLine(readLock(appId)!, { tries: 6, ms: 2500, why: "NotFound" }),
        "the socket file is gone",
      );
      // Back, then gone again: said again.
      l.close();
      l = Deno.listen({ transport: "unix", path: sock });
      lockTick(lock, seen);
      assertEquals(said.length, 1);
      Deno.removeSync(sock);
      lockTick(lock, seen);
      assertEquals(said.length, 2, said.join("\n"));
    } finally {
      setLogger(null);
      l.close();
      lock.release();
      await dropTempDir(dir);
    }
  },
});

// ── two different apps on one folder ──

Deno.test({
  name:
    "two DIFFERENT apps on one data folder: the refusal names the app that holds it, not the one launching",
  async fn() {
    const shared = await tempDir("one-folder-");
    try {
      await withRunningApp("A", { APP_DIR: shared }, async (a) => {
        const other = `${a.appId}-other`;
        const b = await a.launchB({ APP_DIR: shared, APP_ID: other });
        assertEquals(b.code, 1, b.out);
        assertStringIncludes(
          b.out,
          `${other} did not start: ${a.appId} is running`,
        );
        assert(!b.out.includes(`${other} is already running`), b.out);
        assert(!b.out.includes("B UP"), b.out);
        assert(await a.alive());
      });
    } finally {
      await dropTempDir(shared);
    }
  },
});

Deno.test("claimHome: a folder that cannot be claimed goes on — and says so, once", async () => {
  const home = await tempDir("claim-unguarded-");
  const said: string[] = [];
  setLogger({
    pub: (lvl: string, _c: string, msg: string) =>
      void said.push(`${lvl} ${msg}`),
  } as unknown as LogSink);
  try {
    // The claim's name taken by a directory: it cannot be opened as a file.
    Deno.mkdirSync(join(home, ".aio-instance.lock"));
    const who = { appId: "unguarded", port: 0, key: "unguarded" };
    const a = claimHome(home, who);
    const b = claimHome(home, who);
    assertEquals([a.ok, b.ok], [true, true]);
    assertEquals(said.length, 1, said.join("\n"));
    assert(said[0]!.startsWith("warn "), said[0]);
    assertStringIncludes(said[0]!, "without the folder guarantee");
  } finally {
    setLogger(null);
    await dropTempDir(home);
  }
});

// ── a dead owner's lock file that another program holds open ──
//
// Measured on Windows: after a forced kill, a scanner held the dead app's
// lock file for 10 s; the next start said "did not shut down cleanly" four
// times and then refused "Already running" — naming the DEAD pid. No window.

Deno.test({
  name:
    "a dead owner's lock file that cannot be removed: the start goes on under the data folder's lock, a second launch is refused naming the LIVE pid, and the record is filed once the file frees",
  async fn() {
    const flagDir = await tempDir("held-flag-");
    const flag = join(flagDir, "held");
    Deno.writeTextFileSync(flag, "");
    try {
      await withRunningApp(
        "A",
        { PLANT_DEAD: "1", HELD_FLAG: flag, REFILE: "100" },
        async (a) => {
          const dead = JSON.parse(Deno.readTextFileSync(a.lockFile)).pid;
          assert(dead !== a.pid && !isProcessAlive(dead), "the planted record");
          assert(isProcessAlive(a.pid), "the start went on");
          // A second launch meanwhile: refused, naming the live process.
          const b = await a.launchB({ HELD_FLAG: flag });
          assertEquals(b.code, 1, b.out);
          assert(!b.out.includes("B UP"), b.out);
          assertStringIncludes(b.out, `pid ${a.pid}`);
          // Never "running" about the dead one.
          assert(
            !new RegExp(`running[^\\n]*pid ${dead}\\b`, "i").test(b.out),
            b.out,
          );
          // The program lets go: the running app files its own record.
          Deno.removeSync(flag);
          let rec: { pid?: number; status?: string; port?: number } = {};
          for (const until = Date.now() + 20_000; Date.now() < until;) {
            try {
              rec = JSON.parse(Deno.readTextFileSync(a.lockFile));
            } catch {
              // Read while the app takes the dead record away and files its
              // own: gone for a moment, and Windows refuses the read of a
              // file that is going (ACCESS_DENIED). Looked at again — the
              // assert below is on the record that ends up there.
            }
            if (rec.pid === a.pid) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          assertEquals(rec.pid, a.pid, "filed again by the running app");
          // …as it is NOW: it came up while it ran without the file.
          const now = rec as { status?: string; port?: number };
          assertEquals(now.status, "started");
          assert((now.port ?? 0) > 0, JSON.stringify(rec));
        },
      );
    } finally {
      await dropTempDir(flagDir);
    }
  },
});

Deno.test("acquire over a dead owner whose file is held: 'held', said once — never 'already running' with the dead pid", async () => {
  const appId = `held-dead-${crypto.randomUUID().slice(0, 8)}`;
  const gone = new Deno.Command(Deno.execPath(), { args: ["eval", "0"] })
    .spawn();
  await gone.status;
  writeLock({
    appId,
    pid: gone.pid,
    port: 1,
    startedAt: Date.now() - 60_000,
    status: "started",
    cwd: "/",
  });
  const real = { ..._renameDeps };
  const said: string[] = [];
  setLogger({
    pub: (lvl: string, _c: string, msg: string) =>
      void said.push(`${lvl} ${msg}`),
  } as unknown as LogSink);
  _renameDeps.windows = () => true;
  _renameDeps.pause = () => {};
  _renameDeps.remove = (p) => {
    if (p.endsWith(".lock")) {
      throw new Deno.errors.PermissionDenied("Access is denied. (os error 5)");
    }
    real.remove(p);
  };
  const lock = new AppLock(appId);
  try {
    const r = await lock.acquire(4800);
    assert(!r.ok);
    assertEquals(r.existing.pid, gone.pid);
    assertStringIncludes(r.held ?? "", "os error 5");
    assertEquals(
      said.filter((l) => l.includes("did not shut down cleanly")).length,
      1,
      said.join("\n"),
    );
    assertEquals(readLock(appId)!.pid, gone.pid, "the file is as it was");
  } finally {
    setLogger(null);
    Object.assign(_renameDeps, real);
    _renameDeps.reset();
    lock.release();
    removeLock(appId);
  }
});

for (const prod of [false, true]) {
  Deno.test(`--takeover ASKS the running instance to stop (the control request \`am stop\` sends) — its onStop runs to the end; never a signal first${prod ? " (production)" : ""}`, async () => {
    const flagDir = await tempDir("takeover-asks-");
    const onStop = join(flagDir, "onstop");
    const ARGS = prod ? "--prod" : "";
    try {
      await withRunningApp("A", { ONSTOP: onStop, ARGS }, async (a) => {
        const b = await a.launchB({ TAKEOVER: "1", ARGS });
        assertEquals(b.code, 0, b.out);
        assertEquals(Deno.readTextFileSync(onStop), "ran", "onStop finished");
        const log = Deno.readTextFileSync(join(logDirOf(a.dir), "app.log"));
        assertStringIncludes(
          log,
          "stop requested over the control API (takeover by a new launch)",
        );
        assert(!/SIGTERM received/.test(log), log);
        // …and the launch that took over writes its own log from then on.
        const asked = log.indexOf("stop requested over the control API");
        assert(/\bstarted\b/.test(log.slice(asked)), log.slice(asked));
      });
    } finally {
      await dropTempDir(flagDir);
    }
  });
}

Deno.test("stopInstance: an instance that does not answer the request is ended as before", async () => {
  const p = new Deno.Command(Deno.execPath(), {
    args: ["eval", "setTimeout(() => {}, 60_000)"],
  }).spawn();
  const real = _stopDeps.ask;
  let asked = 0;
  _stopDeps.ask = () => (asked++, Promise.resolve(false));
  try {
    await stopInstance({
      appId: "unanswering",
      pid: p.pid,
      port: 0,
      startedAt: Date.now(),
      status: "started",
      cwd: "/",
    });
    assertEquals(asked, 1);
    assertEquals((await p.status).success, false, "ended by force");
  } finally {
    _stopDeps.ask = real;
  }
});

Deno.test("a refused second launch leaves ONE line in the running app's app.log — nothing in debug.log, no error.log, no other file", async () => {
  await withRunningApp("A", {}, async (a) => {
    const logs = logDirOf(a.dir);
    // A's own files exist once its first lines land (they are buffered).
    const has = (f: string) => {
      try {
        return Deno.statSync(join(logs, f)).isFile;
      } catch {
        return false; // aio-ok: not written yet
      }
    };
    for (let i = 0; i < 200 && !has("app.log"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const before = new Set([...Deno.readDirSync(logs)].map((e) => e.name));
    const b = await a.launchB({});
    assertEquals(b.code, 1, b.out);
    // B's line is written synchronously as it exits: nothing to wait for.
    const refusal = /Already running/;
    const entries = (f: string) =>
      has(f)
        ? Deno.readTextFileSync(join(logs, f)).split("\n")
          .filter((l) => /^\d{4}-\d\d-\d\d /.test(l) && refusal.test(l))
        : [];
    assertEquals(entries("app.log").length, 1, "one entry in app.log");
    assertStringIncludes(entries("app.log")[0]!, "ERROR");
    assertEquals(entries("debug.log"), [], "nothing in debug.log");
    assertEquals(entries("error.log"), [], "nothing in error.log");
    const created = [...Deno.readDirSync(logs)].map((e) => e.name)
      .filter((n) => !before.has(n));
    assertEquals(created, [], "no file created");
  });
});

Deno.test({
  name:
    "a lock file that cannot even be read (held open, not shared): the launch says ONCE what it waits for",
  ignore: Deno.build.os === "windows", // OPEN(windows): no stand-in found — a file held open with FileShare.None is still read by Deno there (only its removal fails), and chmod/icacls right after writeLock report the file NotFound
  async fn() {
    const appId = `unreadable-${crypto.randomUUID().slice(0, 8)}`;
    writeLock({
      appId,
      pid: 1,
      port: 1,
      startedAt: Date.now(),
      status: "started",
      cwd: "/",
    });
    const path = lockPath(appId);
    const said: string[] = [];
    setLogger({
      pub: (lvl: string, _c: string, msg: string) =>
        void said.push(`${lvl} ${msg}`),
    } as unknown as LogSink);
    Deno.chmodSync(path, 0o000);
    const lock = new AppLock(appId);
    try {
      const r = await lock.acquire(4900);
      assertEquals(r.ok, false);
      const waits = said.filter((l) => l.includes("cannot be read"));
      assertEquals(waits.length, 1, said.join("\n"));
      assertStringIncludes(waits[0]!, path);
      assertStringIncludes(waits[0]!, "waiting for it");
    } finally {
      lock.release();
      Deno.chmodSync(path, 0o600);
      removeLock(appId);
    }
  },
});
