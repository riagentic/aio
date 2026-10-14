// The lock dir under load: N processes share ONE scoped lock dir, and each
// makes a file and a socket in it, removes them, and prunes the dir — what an
// app's start, its stop, and a sibling's exit do — over and over.
//
// Every create here has run into each of these, and each was a start that
// failed because a sibling quit: the dir gone between "make sure it is there"
// and the create (ENOENT; macOS, EINVAL as well); gone between its mkdir and
// the look at it; there for a moment at the umask's mode; on Windows, a
// create refused while the dir is being removed; on macOS, gone AFTER a create
// that succeeded (what it made is then in no dir). They were found one by one
// with a script run by hand. This is that script as a gate: 0 failures.
//
// `AIO_STRESS_ROUNDS` sets the rounds per process (the hand run: 3 000),
// `AIO_STRESS_PROCS` the processes.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const MOD = toFileUrl(join(REPO, "src/server/single-instance-lock.ts")).href;
// Three on macOS: the Mac this runs on is small and shared.
const N = Number(
  Deno.env.get("AIO_STRESS_PROCS") ?? (Deno.build.os === "darwin" ? 3 : 6),
);
const ROUNDS = Number(Deno.env.get("AIO_STRESS_ROUNDS") ?? 1000);

// A pipe on Windows is a kernel name, not a file in the dir: no socket there.
//
// The wait for a pruned dir is bounded by TIME (2 s), and a worker the
// machine does not run for a while — six of these beside a suite — spent it
// descheduled: a create "failed" that was never tried again. That is the
// load, not the rule under test. So each worker's clock is moved by its own
// PAUSES alone (`_lockDeps.now`/`pause`, each pause still slept): the bound
// is the same 2 000 ms of waiting, which is 2 000 tries, and a create that
// 2 000 tries do not get through is a failure on any machine.
const WORKER = `const m = await import(${JSON.stringify(MOD)});
let clock = 0;
const sleep = m._lockDeps.pause;
m._lockDeps.now = () => clock;
m._lockDeps.pause = (ms) => { clock += ms; sleep(ms); };
const who = Deno.env.get("WHO");
const WIN = Deno.build.os === "windows";
const seen = {};
let ok = 0;
const rm = (p) => { try { Deno.removeSync(p); } catch { /* none */ } };
for (let i = 0; i < ${ROUNDS}; i++) {
  let dir = "?";
  try {
    dir = m.lockDir();
    const f = dir + "/w" + who + ".tmp", s = dir + "/w" + who + ".sock";
    try {
      m.createInLockDir(f, () => Deno.openSync(f, { createNew: true, write: true })).close();
      rm(f);
      if (!WIN) m.listenInLockDir(s, false).close();
      ok++;
    } finally {
      rm(f);
      rm(s);
    }
  } catch (e) {
    const k = (e.name + ": " + e.message).replaceAll(dir, "<dir>");
    seen[k] = (seen[k] ?? 0) + 1;
  }
  m.pruneLockDir();
}
console.log("RESULT " + JSON.stringify({ ok, seen }));
`;

// The same dir, and what an app's START does in it: each process takes its
// OWN lock (its record goes in by a temp file and a hard link — the first
// file of that process in the dir where nothing else of it pins it), lets it
// go, and prunes. A start must not fail because a sibling quit.
const ACQUIRER = `const m = await import(${JSON.stringify(MOD)});
let clock = 0;
const sleep = m._lockDeps.pause;
m._lockDeps.now = () => clock;
m._lockDeps.pause = (ms) => { clock += ms; sleep(ms); };
const lock = new m.AppLock("w" + Deno.env.get("WHO"));
const seen = {};
let ok = 0;
for (let i = 0; i < ${ROUNDS}; i++) {
  let dir = "?";
  try {
    dir = m.lockDir();
    const r = await lock.acquire(1);
    if (!r.ok) throw new Error("refused its own lock: " + JSON.stringify(r));
    ok++;
  } catch (e) {
    const k = (e.name + ": " + e.message).replaceAll(dir, "<dir>")
      .replace(/\\.[0-9a-f.]+\\.tmp/g, ".<tmp>");
    seen[k] = (seen[k] ?? 0) + 1;
  }
  lock.release();
  m.pruneLockDir();
}
console.log("RESULT " + JSON.stringify({ ok, seen }));
`;

async function stress(
  source: string,
): Promise<{ ok: number; failures: Record<string, number> }> {
  const dir = await tempDir("lock-dir-stress-");
  const worker = join(dir, "worker.js");
  await Deno.writeTextFile(worker, source);
  const outs = await Promise.all(
    Array.from({ length: N }, (_, who) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(REPO, "deno.json"), worker],
        env: { AIO_APPS_DIR: join(dir, "apps"), WHO: String(who) },
        stdout: "piped",
        stderr: "piped",
      }).output()),
  );
  const dec = new TextDecoder();
  assertEquals(outs.length, N, "every worker ran");
  const failures: Record<string, number> = {};
  let ok = 0;
  for (const o of outs) {
    const line = dec.decode(o.stdout).trim().split("\n").pop() ?? "";
    assert(
      o.success && line.startsWith("RESULT "),
      `worker failed: ${line}\n${dec.decode(o.stderr).slice(-1500)}`,
    );
    const r = JSON.parse(line.slice(7)) as {
      ok: number;
      seen: Record<string, number>;
    };
    ok += r.ok;
    for (const [k, n] of Object.entries(r.seen)) {
      failures[k] = (failures[k] ?? 0) + n;
    }
  }
  return { ok, failures };
}

Deno.test(
  "lock dir: processes making and pruning one scoped dir — no create fails",
  async () => {
    const r = await stress(WORKER);
    assertEquals(r.failures, {}, "a create in the lock dir failed");
    assertEquals(r.ok, N * ROUNDS, "every round of every process");
  },
);

Deno.test(
  "lock dir: processes taking and releasing their own lock in one scoped dir — no start fails",
  async () => {
    const r = await stress(ACQUIRER);
    assertEquals(r.failures, {}, "a start failed on its own lock");
    assertEquals(r.ok, N * ROUNDS, "every round of every process");
  },
);
