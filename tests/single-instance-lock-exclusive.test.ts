// The single-instance lock is EXCLUSIVE — measured with real processes racing.
//
// It was not: the file was created empty and filled a moment later, a racer
// read the empty file as "unreadable lock, names no owner" and deleted it, and
// the dead-owner reclaim deleted whatever was at the path — possibly the fresh
// lock a live racer had just taken. 6 processes on a barrier: more than one
// holder in 11 of 15 rounds, once three — two instances on one `state.db`.
//
// So this races N processes on a wall-clock barrier, round after round, and
// asserts that no two HOLD intervals ever overlap (a late starter taking the
// lock after the holder released is legitimate; two at once never is). The
// second case starts every round from a lock whose owner is DEAD, so all N
// racers try to reclaim it at once — the delete-by-path hole.
import { assert } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const N = 6;
const ROUNDS = 8;
const HOLD_MS = 300;

// Ready-signal barrier: each racer loads the module, says READY, and waits on
// stdin for the start time; the test sends it once ALL are ready. Each racer
// sleeps until 5 ms before the barrier and spins only those last 5 ms — the
// start stays tight (the race needs it) without burning a core per racer.
const RACER = `const { AppLock } = await import(${
  JSON.stringify(
    toFileUrl(join(REPO, "src/server/single-instance-lock.ts")).href,
  )
});
const l = new AppLock("racer", Deno.env.get("RACE_HOME"));
console.log("READY");
const buf = new Uint8Array(64);
const n = await Deno.stdin.read(buf);
const at = Number(new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim());
const lead = at - Date.now() - 5;
if (lead > 0) await new Promise((res) => setTimeout(res, lead));
while (Date.now() < at) { /* the last few ms: spin to the barrier */ }
const r = await l.acquire(0);
if (!r.ok) { console.log("NO"); Deno.exit(0); }
const t0 = performance.timeOrigin + performance.now();
await new Promise((res) => setTimeout(res, ${HOLD_MS}));
const t1 = performance.timeOrigin + performance.now();
l.release();
console.log("HELD " + t0 + " " + t1);
Deno.exit(0);
`;

/** A pid no process has right now. */
function deadPid(): number {
  for (let p = 3_999_999; p > 1_000_000; p -= 7919) {
    try {
      Deno.kill(p, 0);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return p;
    }
  }
  throw new Error("no free pid found");
}

async function round(
  dir: string,
  racer: string,
): Promise<[number, number][]> {
  const dec = new TextDecoder();
  const procs = Array.from({ length: N }, () =>
    new Deno.Command("deno", {
      args: ["run", "-A", "--config", join(REPO, "deno.json"), racer],
      env: {
        AIO_APPS_DIR: join(dir, "apps"),
        RACE_HOME: join(dir, "home"),
        AIO_NO_OPEN: "1",
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn());
  // Each racer's stdout, collected; `ready` resolves on its READY line.
  const outs = procs.map((p) => {
    let text = "";
    let onReady!: () => void;
    const ready = new Promise<void>((r) => onReady = r);
    const done = (async () => {
      for await (const c of p.stdout) {
        text += dec.decode(c);
        if (text.includes("READY")) onReady();
      }
      onReady();
    })();
    return { ready, done, text: () => text };
  });
  const errs = procs.map((p) => new Response(p.stderr).text());
  await Promise.all(outs.map((o) => o.ready));
  const at = Date.now() + 50;
  for (const p of procs) {
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(`${at}\n`));
    await w.close();
  }
  await Promise.all(procs.map((p) => p.status));
  await Promise.all(outs.map((o) => o.done));
  const stderr = await Promise.all(errs);
  const held: [number, number][] = [];
  outs.forEach((o, i) => {
    const line = o.text().trim().split("\n").pop()!;
    assert(
      line === "NO" || line.startsWith("HELD "),
      `racer said ${line}\n${stderr[i]!.slice(-2000)}`,
    );
    if (line.startsWith("HELD ")) {
      const [, a, b] = line.split(" ");
      held.push([Number(a), Number(b)]);
    }
  });
  return held;
}

function overlaps(held: [number, number][]): string | null {
  const s = [...held].sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < s.length; i++) {
    if (s[i]![0] < s[i - 1]![1]) {
      return `${held.length} holders, two at once: ${JSON.stringify(s)}`;
    }
  }
  return null;
}

async function race(withDeadOwner: boolean): Promise<string[]> {
  const dir = await tempDir("lock-excl-");
  const racer = join(dir, "racer.ts");
  await Deno.writeTextFile(racer, RACER);
  const bad: string[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    if (withDeadOwner) {
      // A lock left by a process that died: planted through the real module,
      // so its path and shape are exactly what a crashed instance leaves.
      const plant = await new Deno.Command("deno", {
        args: [
          "eval",
          "--config",
          join(REPO, "deno.json"),
          `const m = await import(${
            JSON.stringify(
              toFileUrl(join(REPO, "src/server/single-instance-lock.ts")).href,
            )
          });
           m.writeLock({ appId: "racer", pid: ${deadPid()}, port: 0,
             startedAt: Date.now() - 60000, status: "started", cwd: "/",
             home: ${JSON.stringify(join(dir, "home"))} });
           console.log(m.readLock(m.lockKey("racer", ${
            JSON.stringify(join(dir, "home"))
          })) ? "PLANTED" : "NOT");`,
        ],
        env: { AIO_APPS_DIR: join(dir, "apps") },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const said = new TextDecoder().decode(plant.stdout).trim();
      assert(
        said === "PLANTED",
        `could not plant the dead owner's lock: ${said}\n` +
          new TextDecoder().decode(plant.stderr),
      );
    }
    const held = await round(dir, racer);
    if (held.length === 0) bad.push(`round ${r}: nobody got the lock`);
    const two = overlaps(held);
    if (two) bad.push(`round ${r}: ${two}`);
  }
  return bad;
}

Deno.test({
  name: `single-instance lock: ${N} racers on a barrier, never two holders`,
  fn: async () => {
    const bad = await race(false);
    assert(bad.length === 0, `the lock is not exclusive:\n${bad.join("\n")}`);
  },
});

Deno.test({
  name:
    `single-instance lock: a dead owner and ${N} racers reclaiming it — never two holders`,
  fn: async () => {
    const bad = await race(true);
    assert(bad.length === 0, `the lock is not exclusive:\n${bad.join("\n")}`);
  },
});
