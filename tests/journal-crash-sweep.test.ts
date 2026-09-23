// Crash recovery of THIS build's own data, swept: a random workload over sync
// and store-persisted listeners (bursts, refused duplicates, server calls, a
// clock that steps back) is SIGKILLed at a random moment; its first recovery
// boot is sometimes killed too; then it boots twice
// (tests/fixtures/crash-sweep/README.md).
//
// Property, for every run: no listener holds a reaction twice, every
// listener holds every reaction to the ops its source recovered (or the
// boot NAMED the shortfall), and the second boot changes nothing and says
// nothing new. The re-verify of the legacy redesign found the one it pins:
// an op persisted but not yet reduced at the kill was replayed into its own
// cell only — `notes` held it, `tally` and `mirror` did not (4 of 35 runs).
//
// `AIO_CRASH_SWEEP_N` widens the sweep, `AIO_CRASH_SWEEP_SEED` replays one.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { rngOf } from "./sync/properties/_prop.ts";

const APP = new URL("./fixtures/crash-sweep/app.js", import.meta.url)
  .pathname;
const TREE = new URL("..", import.meta.url).pathname;

type Snap = {
  notes: string[];
  tally: number;
  mirror: string[];
  chain: number;
  schain: number;
  tasks: string[];
  tcount: number;
  tkv: number;
  inbox: string[];
  feed: string[];
  kvl: number;
};

/** Run the app; `killAfterMs` SIGKILLs it (a recovery boot killed midway). */
async function run(
  dir: string,
  phase: string,
  env: Record<string, string>,
  killAfterMs?: number,
): Promise<string> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(TREE, "deno.json"), APP],
    env: {
      ...env,
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      PHASE: phase,
      MOD: new URL(`file://${join(TREE, "mod.ts")}`).href,
      AIO_NO_OPEN: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timer = killAfterMs === undefined ? undefined : setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* aio-ok: it already exited */ }
  }, killAfterMs);
  const out = await child.output();
  clearTimeout(timer);
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}
const readSnap = async (f: string): Promise<Snap> =>
  JSON.parse(await Deno.readTextFile(f));

/** What the boots named for listener `k`: a count held, or an open loss. */
function named(log: string, k: string): { held: number; open: boolean } {
  // A crash's in-flight op held back from a listener (counted), or an op no
  // record covers (named, uncounted).
  const held = [
    ...log.matchAll(
      new RegExp(`"${k}": (\\d+) listensTo reactions? of the sync op`, "g"),
    ),
  ].reduce((n, m) => n + Number(m[1]), 0);
  const open = new RegExp(
    `cannot tell whether "${k}" holds its listensTo reactions`,
  ).test(log);
  return { held, open };
}
const count = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/** Every violation of the property in one recovered state. `unjournaled`:
 *  a run with no journal (or no store) was killed — what it did since its
 *  last save is gone by contract (said by the lock's "did not shut down
 *  cleanly" warning), and the cells it saved on different clocks (a store
 *  cell's save, a sync cell's fold) need not agree about it; only writes
 *  twice and the clean runs' writes are checked then. */
function violations(r: Snap, log: string, unjournaled = false): string[] {
  const out: string[] = [];
  const counter = (k: keyof Snap, have: number, want: number) => {
    if (unjournaled) return;
    const { held, open } = named(log, k);
    if (have > want) out.push(`${k} OVER +${have - want}`);
    else if (want - have > held && !open) {
      out.push(`${k} UNNAMED LOSS ${want - have}`);
    }
  };
  const list = (k: keyof Snap, got: string[], want: string[]) => {
    const c = count(got);
    const dup = want.filter((x) => (c.get(x) ?? 0) > 1);
    if (dup.length > 0) out.push(`${k} DOUBLE ${dup.length}`);
    if (unjournaled) return;
    const miss = want.filter((x) => (c.get(x) ?? 0) === 0);
    const { held, open } = named(log, k);
    if (miss.length > held && !open) {
      out.push(`${k} UNNAMED LOSS ${miss.length}`);
    }
  };
  // Every item the app writes is unique: a second copy is a write applied
  // twice.
  for (const k of ["notes", "mirror", "tasks", "inbox", "feed"] as const) {
    const twice = [...count(r[k])].filter(([, n]) => n > 1);
    if (twice.length > 0) out.push(`${k} TWICE ${twice.map(([x]) => x)}`);
  }
  counter("tally", r.tally, r.notes.length);
  list("mirror", r.mirror, r.notes);
  const direct = r.mirror.filter((x) => /^(d|sm)/.test(x));
  counter("chain", r.chain, direct.length);
  counter("schain", r.schain, direct.length);
  counter("tcount", r.tcount, r.tasks.length);
  counter("tkv", r.tkv, r.tasks.length);
  list("feed", r.feed, r.inbox);
  counter("kvl", r.kvl, r.inbox.length);
  return out;
}

Deno.test("journal crash sweep: this build killed at random points — no reaction twice, none lost unnamed, the second boot changes nothing", async () => {
  const replay = Deno.env.get("AIO_CRASH_SWEEP_SEED") !== undefined
    ? fuzzEnvInt("AIO_CRASH_SWEEP_SEED", 0)
    : undefined;
  const n = fuzzEnvInt("AIO_CRASH_SWEEP_N", 3, 1);
  const seeds = replay !== undefined
    ? [replay]
    : Array.from({ length: n }, (_, i) => (0xc4a5 + i * 0x9E3779B9) >>> 0);
  assert(seeds.length > 0);
  let checked = 0;
  for (const seed of seeds) {
    const rng = rngOf(seed);
    const env: Record<string, string> = {
      PDM: String(rng.pick([0, 0, 5, 20, 100, 300])),
      KILLMS: String(rng.int(4000) + 300),
      SEED: String(rng.int(30000) + 1),
      GAP: String(rng.int(60)),
      BURST: String(rng.int(800)),
    };
    if (rng.chance(1 / 3)) env.DUPS = "1";
    if (rng.chance(1 / 4)) {
      env.JUMPAT = String(rng.int(200));
      env.JUMPMS = String(rng.int(3000) + 50);
    }
    if (rng.chance(1 / 3)) env.MULTI = "1";
    // Toggles (round 6): half the seeds run the workload more than once over
    // the same data — each run with the journal on or off, persistence on or
    // off (off needs the journal off), stopped by a kill or cleanly — before
    // the recovery boots (journal on). A journal-on run killed, then a
    // journal-off run that saved newer data, then the journal back on lost
    // every write of the middle run once (the stale journal replayed).
    const runs: Record<string, string>[] = [{}];
    if (rng.chance(1 / 2)) {
      runs.length = 0;
      for (let r = rng.int(3) + 2; r > 0; r--) {
        const journal = rng.chance(1 / 2);
        const persist = journal || rng.chance(3 / 4);
        runs.push({
          JOURNAL: journal ? "1" : "0",
          ...(persist ? {} : { PERSIST: "0" }),
          STOPK: rng.chance(1 / 2) ? "kill" : "term",
          KILLMS: String(rng.int(2500) + 300),
          SEED: String(rng.int(30000) + 1),
        });
        // A run with no journal records no op intent: a kill between a
        // refused op's row and its removal leaves a row no later boot can
        // tell from an accepted one (dev refuses to boot, prod quarantines
        // the cell — as 1.0.9). Refusals everywhere else, including a
        // journal-on kill followed by journal-off boots (its intents
        // resolve it).
        const last = runs.at(-1)!;
        if (last.JOURNAL === "0" && last.STOPK === "kill") last.DUPS = "";
      }
    }
    const midKill = rng.chance(1 / 3) ? rng.int(2500) : undefined;
    const what = `seed ${seed} (${JSON.stringify(env)} runs=${
      JSON.stringify(runs)
    } midKill=${midKill}) — replay: AIO_CRASH_SWEEP_SEED=${seed}`;
    const dir = await tempDir("aio-crash-sweep-");
    try {
      await Deno.copyFile(APP, join(dir, "app.js"));
      let logR = "";
      /** What each cleanly stopped run that SAVED had acked. */
      const kept: Snap[] = [];
      for (const [i, over] of runs.entries()) {
        const crash = await run(dir, "x", {
          ...env,
          ...over,
          NBASE: String(i * 1_000_000),
        });
        logR += crash;
        const live = await readSnap(join(dir, "expected.json")).catch(() => {
          throw new Error(`${what}: run ${i} never reached its stop\n${crash}`);
        });
        await Deno.remove(join(dir, "expected.json"));
        if (over.STOPK === "term" && over.PERSIST !== "0") kept.push(live);
      }
      let log0 = "";
      if (midKill !== undefined) log0 = await run(dir, "read", env, midKill);
      const log1 = await run(dir, "read", env);
      const got = await readSnap(join(dir, "recovered.json")).catch(() => {
        throw new Error(`${what}: no boot\n${log1}`);
      });
      // …and so is a journal a journal-off run moved aside, unreplayed, and
      // a run that persisted no store at all (its op-log is kept, its store
      // cells' reactions are not — by what `persist: false` means).
      const unjournaled = runs.some((o) =>
        o.PERSIST === "0" || (o.STOPK !== "term" && o.JOURNAL === "0")
      ) || /this run has the journal off, but/.test(logR);
      const bad = violations(got, logR + log0 + log1, unjournaled);
      // A clean stop that saved: every source write it had acked is still
      // there, whatever ran after it (the runs after it start from it).
      for (const live of kept) {
        for (const k of ["notes", "tasks", "inbox"] as const) {
          const lost = live[k].filter((x) =>
            !got[k].includes(x)
          );
          if (lost.length > 0) bad.push(`${k} LOST AFTER CLEAN ${lost}`);
        }
      }
      assertEquals(bad, [], `${what}\n${logR}\n${log0}\n${log1}`);
      const log2 = await run(dir, "read", env);
      assertEquals(await readSnap(join(dir, "recovered.json")), got, log2);
      assert(
        !/the crash caught|older aio build|cannot tell whether|of the sync ops? a crash caught/
          .test(log2),
        `${what}: the second boot recovered again\n${log2}`,
      );
      checked++;
    } finally {
      await dropTempDir(dir);
    }
  }
  assertEquals(checked, seeds.length);
});
