// `blocking.cancel(id)` on a task inside SYNCHRONOUS code says the thread
// lives on.
//
// Deno's `Worker.terminate()` stops a worker's event loop but does not
// interrupt running synchronous code (Deno 2.9.7, measured): a cancelled CPU
// loop kept its core until the loop returned, outside the pool's size — three
// "Cancel" clicks on a size-1 pool left three cores busy, and `cancel()`
// answered `true` each time with nothing said. The caller is still released at
// once; the surviving thread is now named, with the way to make the task
// stoppable (yield between chunks — a cancel stops it at the next yield).
import { assert, assertEquals } from "@std/assert";
import { createBlockingPool } from "../src/state/blocking.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

async function withLogs(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (level: string, _cat: string, msg: string) =>
        seen.push(`${level} ${msg}`),
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    await fn();
  } finally {
    setLogger(prev);
  }
  return seen;
}

/** CPU seconds per thread of this process (Linux), or null elsewhere. One
 *  thread, not the process: under `deno test --parallel` other test files
 *  burn CPU in this same process, and a process total blamed the pool. */
function threadCpu(): Map<string, number> | null {
  if (Deno.build.os !== "linux") return null;
  const out = new Map<string, number>();
  for (const t of Deno.readDirSync("/proc/self/task")) {
    try {
      const f = Deno.readTextFileSync(`/proc/self/task/${t.name}/stat`)
        .split(") ")[1]!.split(" ");
      out.set(t.name, (Number(f[11]) + Number(f[12])) / 100);
    } catch { /* aio-ok: the thread exited between readdir and read */ }
  }
  return out;
}

/** The thread that burned the most between two samples — the pool's worker
 *  while it crunches. Only threads the pool started count: under load another
 *  test file's busy thread in this process can out-burn it. */
function busiest(
  a: Map<string, number>,
  b: Map<string, number>,
  mine: Set<string>,
): string {
  let best = "", most = -1;
  for (const [tid, t] of b) {
    if (mine.size > 0 && !mine.has(tid)) continue;
    const d = t - (a.get(tid) ?? t);
    if (d > most) most = d, best = tid;
  }
  return best;
}

/** CPU seconds `tid` burned from `a` to now — 0 for a thread already gone
 *  at `a` (a cancelled worker that yielded exits at once). */
function burnedSince(a: Map<string, number>, tid: string): number {
  const at = a.get(tid);
  if (at === undefined) return 0;
  return (threadCpu()!.get(tid) ?? at) - at;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `done` every 50 ms until it holds or `ms` pass; answers whether it
 *  held. The wait ends on the condition, not on the clock. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** A size-1 pool whose worker is up: a cold worker can still be loading at
 *  the cancel, which is not the case under test. */
async function warmPool() {
  const before = threadCpu();
  const pool = createBlockingPool({ size: 1 });
  assertEquals(await pool.run("warm", () => 1), 1);
  const after = threadCpu();
  const mine = new Set(
    [...(after?.keys() ?? [])].filter((t) => !before?.has(t)),
  );
  return Object.assign(pool, { mine });
}

Deno.test("blocking: cancelling a task inside a sync loop warns that its thread keeps running", async () => {
  const pool = await warmPool();
  let tid: string | null = null;
  try {
    let burned: number | null = null;
    const logs = await withLogs(async () => {
      // 3 s of wall time: under a loaded 2-core CI runner the surviving
      // thread only gets a share of a core, so it needs room to SHOW it runs.
      const p = pool.run("crunch", () => {
        const end = performance.now() + 3000;
        while (performance.now() < end) { /* crunch */ }
        return "done";
      });
      const s0 = threadCpu();
      await sleep(300);
      tid = s0 && busiest(s0, threadCpu()!, pool.mine);
      assertEquals(pool.cancel("crunch"), true);
      const c0 = threadCpu();
      assertEquals(
        await p.catch((e) => e.message),
        "blocking task 'crunch' cancelled",
      );
      // Until the cancelled thread has burned more than 0.25 CPU-s since the
      // cancel — the claim — or its loop's own 3 s are over. A fixed 400 ms
      // window measured 0.25 s exactly on a busy runner: the thread was
      // running, just not on a whole core.
      if (c0 !== null) {
        await until(() => (burned = burnedSince(c0, tid!)) > 0.25, 3_000);
      }
    });
    const warn = logs.filter((l) => l.includes("cannot interrupt"));
    assertEquals(warn.length, 1, logs.join("\n"));
    assert(warn[0]!.startsWith("warn "), warn[0]);
    assert(warn[0]!.includes("'crunch'"), warn[0]);
    // The fact the warning reports. If Deno ever interrupts the loop, this
    // fails — and the warning (and the docs) should go.
    if (burned !== null) assert(burned > 0.25, `thread burned ${burned}s`);
  } finally {
    await pool.dispose();
  }
  // Let the surviving loop end before the next test: its thread leaves
  // /proc/self/task when the loop returns (bounded: the loop is 3 s of wall).
  if (tid) await until(() => !threadCpu()?.has(tid!), 4_000);
  else await sleep(3000);
});

Deno.test("blocking: a task that yields between chunks stops at cancel, with no warning", async () => {
  const pool = await warmPool();
  try {
    let burned: number | null = null;
    const logs = await withLogs(async () => {
      const p = pool.run("chunked", async () => {
        const end = performance.now() + 1500;
        while (performance.now() < end) {
          const slice = performance.now() + 20;
          while (performance.now() < slice) { /* crunch */ }
          await new Promise((r) => setTimeout(r));
        }
        return "done";
      });
      const s0 = threadCpu();
      await sleep(300);
      const tid = s0 && busiest(s0, threadCpu()!, pool.mine);
      assertEquals(pool.cancel("chunked"), true);
      await p.catch(() => {});
      await sleep(100); // the slice in flight ends
      const c0 = threadCpu();
      await sleep(400);
      if (c0 !== null) burned = burnedSince(c0, tid!);
    });
    assertEquals(logs.filter((l) => l.includes("cannot interrupt")), []);
    if (burned !== null) assert(burned < 0.2, `thread burned ${burned}s`);
  } finally {
    await pool.dispose();
  }
});
