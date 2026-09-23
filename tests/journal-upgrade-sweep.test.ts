// The upgrade over REAL v1.0.9 data, swept: random workloads that v1.0.9-beta
// itself runs and is killed in (bursts whose `server_ts` runs ahead of the
// clock, saves and folds landing mid-stream, server writes, KV posts), then
// this build boots the directory twice. The fixtures pin four such runs; this
// is the class (tests/fixtures/v1.0.9-sweep/README.md).
//
// Property, for every run: nothing is counted twice and nothing is
// re-derived, every cell's own writes come back exactly, a listener short of
// live is NAMED, and the second boot changes nothing and names nothing.
//
// Needs the `v1.0.9-beta` tag (git archive), or `AIO_V109_TREE` naming an
// export of it. `AIO_UPGRADE_SWEEP_N` widens the sweep,
// `AIO_UPGRADE_SWEEP_SEED` replays one run.
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { rngOf } from "./sync/properties/_prop.ts";

const APP = new URL("./fixtures/v1.0.9-sweep/app.js", import.meta.url)
  .pathname;
const TREE = new URL("..", import.meta.url).pathname;

type Snap = {
  notes: string[];
  tally: number;
  mirror: string[];
  inbox: string[];
  feed: string[];
  shaped: number;
};

async function exportTag(tag: string): Promise<string> {
  const dir = await tempDir("aio-old-tree-");
  const tar = join(dir, "tree.tar");
  const a = await new Deno.Command("git", {
    args: ["-C", TREE, "archive", "--format=tar", "-o", tar, tag],
    stderr: "piped",
  }).output();
  assert(
    a.success,
    `git archive ${tag}: ${new TextDecoder().decode(a.stderr)}`,
  );
  const x = await new Deno.Command("tar", {
    args: ["-xf", tar, "-C", dir],
    stderr: "piped",
  }).output();
  assert(x.success, new TextDecoder().decode(x.stderr));
  return dir;
}

async function run(
  dir: string,
  tree: string,
  phase: string,
  env: Record<string, string> = {},
): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      join(tree, "deno.json"),
      join(dir, "app.js"),
    ],
    env: {
      ...env,
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      MOD: new URL(`file://${join(tree, "mod.ts")}`).href,
      AIO_NO_OPEN: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

/** What v1.0.9 kept of the sync listener `mirror`: its snapshot and its own
 *  ops. A reaction to a `notes` op is in neither until a fold. */
function mirrorRecords(db: string): Set<string> {
  const d = new DatabaseSync(db);
  try {
    const out = new Set<string>();
    const snap = d.prepare(
      "SELECT state FROM sync_snapshots WHERE cell = 'mirror'",
    ).get() as { state: string } | undefined;
    for (const x of JSON.parse(snap?.state ?? "{}").got ?? []) out.add(x);
    const ops = d.prepare(
      "SELECT payload FROM sync_ops WHERE cell = 'mirror'",
    ).all() as { payload: string }[];
    for (const o of ops) out.add(JSON.parse(o.payload).args[0]);
    return out;
  } finally {
    d.close();
  }
}

const readSnap = async (f: string): Promise<Snap> =>
  JSON.parse(await Deno.readTextFile(f));

/** Whether boot 1 named listener `k` as possibly lacking reactions — the
 *  one warning per listener (aio.ts), or a crash's held in-flight reaction. */
function named(log: string, k: string): boolean {
  return new RegExp(
    `"${k}"'s listensTo reactions to [^\\n]*are in no record[^\\n]*` +
      `nothing is counted twice`,
  ).test(log) ||
    new RegExp(`"${k}": \\d+ listensTo reactions? of the sync op`).test(log);
}

/** `got` holds nothing `live` does not, as often as it does (a reaction
 *  applied twice is a duplicate item). Returns how many are missing. */
function shortfall(got: string[], live: string[]): number {
  const left = new Map<string, number>();
  for (const x of live) left.set(x, (left.get(x) ?? 0) + 1);
  for (const x of got) {
    const n = left.get(x) ?? 0;
    assert(n > 0, `"${x}" recovered more often than it was written`);
    left.set(x, n - 1);
  }
  return [...left.values()].reduce((a, b) => a + b, 0);
}

const PHASES = [
  // A burst whose every DUPEVERY-th op is refused: v1.0.9 issued its
  // server_ts, then deleted the row — a gap in the values no row shows.
  "rejdrift",
  // The compaction base's write is refused (BLOCKBASE): a stale base, with
  // the same watermark, and a stale mtime.
  "stalebase",
  "mixed",
  "streaming",
  "after-fold",
  "fold-lags-persist",
  "synconly",
  "drift",
  "before-fold",
] as const;

Deno.test("journal upgrade sweep: v1.0.9 killed at random points — this build never counts twice, and names every shortfall", async () => {
  // An exported v1.0.9 tree may be named instead (a copy with no .git).
  const given = Deno.env.get("AIO_V109_TREE");
  const old = given ?? await exportTag("v1.0.9-beta");
  const replay = Deno.env.get("AIO_UPGRADE_SWEEP_SEED") !== undefined
    ? fuzzEnvInt("AIO_UPGRADE_SWEEP_SEED", 0)
    : undefined;
  const n = fuzzEnvInt("AIO_UPGRADE_SWEEP_N", 4, 1);
  const seeds = replay !== undefined
    ? [replay]
    : Array.from({ length: n }, (_, i) => (0xa10 + i * 0x9E3779B9) >>> 0);
  assert(seeds.length > 0);
  let namedRuns = 0;
  try {
    for (const seed of seeds) {
      const rng = rngOf(seed);
      const phase = rng.pick(PHASES);
      const env = {
        PDM: String(rng.pick([0, 10, 50, 100, 300, 1000])),
        KILLAT: String(rng.int(400)),
        GAP: String(rng.int(80)),
        PGAP: "15",
        BURST: "400",
        K: String(rng.int(40) + 1),
        OGAP: String(rng.int(30)),
        // No journal: the older build is known by the store's stamp alone,
        // and what it re-derived is saved and folded, not journalled.
        JOURNAL: rng.chance(0.25) ? "0" : "1",
        DUPEVERY: String(2 + rng.int(3)),
        BLOCKBASE: rng.chance(0.5) ? "1" : "0",
        WAITMS: String(500 + rng.int(2500)),
      };
      const what = `seed ${seed} (${phase} ${JSON.stringify(env)}) — ` +
        `replay: AIO_UPGRADE_SWEEP_SEED=${seed}`;
      const dir = await tempDir("aio-upgrade-sweep-");
      try {
        await Deno.copyFile(APP, join(dir, "app.js"));
        const crash = await run(dir, old, phase, env);
        const live = await readSnap(join(dir, "expected.json")).catch(() => {
          throw new Error(`${what}: v1.0.9 never reached its kill\n${crash}`);
        });
        const recorded = mirrorRecords(join(dir, "data", "state.db"));
        const log1 = await run(dir, TREE, "read", env);
        const got = await readSnap(join(dir, "recovered.json")).catch(() => {
          throw new Error(`${what}: this build did not boot\n${log1}`);
        });
        const ctx = `${what}\n${log1}`;
        assert(!/COULD NOT be replayed/.test(log1), ctx);
        assert(/last run by an older aio build/.test(log1), ctx);
        // A cell's own writes: exact (server calls come back after the ops,
        // as v1.0.9 put them — the same items). With no journal, a write in
        // the save window before the kill is gone in any build: never more.
        for (const k of ["notes", "inbox"] as const) {
          const short = shortfall(got[k], live[k]);
          assert(env.JOURNAL === "0" || short === 0, `${k}: ${ctx}`);
        }
        // With no journal, a SERVER write (`srv-…`, `sm-…`: no op, so no
        // op-log row) and its reactions live only in the save window any
        // build loses on a kill (docs/persistence/crdt.md): not the
        // upgrade's to name.
        const server = (xs: string[]) =>
          env.JOURNAL === "0" ? xs.filter((x) => /^(srv|sm)-/.test(x)) : [];
        const windowed = server(live.notes).length;
        for (const k of ["tally", "shaped"] as const) {
          assert(got[k] <= live[k], `${k} counted twice: ${ctx}`);
          assert(
            named(log1, k) || live[k] - got[k] <= windowed,
            `${k} short, unnamed: ${ctx}`,
          );
        }
        for (const k of ["mirror", "feed"] as const) {
          const short = shortfall(got[k], live[k]);
          assert(
            named(log1, k) || short <= server(live[k]).length,
            `${k} short ${short}, unnamed: ${ctx}`,
          );
        }
        // Nothing re-derived: a reaction is back only where a record held
        // it — never one v1.0.9 kept in no record.
        assertEquals(
          got.mirror.filter((x) => !recorded.has(x) && !/^(srv|sm)-/.test(x))
            .length,
          0,
          ctx,
        );
        if (named(log1, "mirror")) namedRuns++;
        const log2 = await run(dir, TREE, "read", env);
        assertEquals(await readSnap(join(dir, "recovered.json")), got, log2);
        assert(!/older aio build|are in no record/.test(log2), log2);
      } finally {
        await dropTempDir(dir);
      }
    }
  } finally {
    if (given === undefined) await dropTempDir(old);
  }
  // Non-vacuity: the sync listener's missing reactions were named.
  if (replay === undefined) assert(namedRuns > 0, "no run named a listener");
});

// Downgrade interleavings: this build, then v1.0.9 on the same data (crashed
// or stopped cleanly), then this build again. v1.0.9 writes ops with no
// intent and no commit (journal.ts J3) and keeps this build's stamp on the
// op-log — so nothing but the per-op records may decide. Its OWN boot
// re-derives reactions through the whole root, over-counting a saved one
// (its bug), and ignores this build's journal lines (so it can hold FEWER
// than this build recovers): the property is that this build counts no
// reaction or item twice, holds the same on its second boot, and names
// nothing twice.
Deno.test("journal downgrade interleavings: this build → v1.0.9 → this build never counts twice", async () => {
  const given = Deno.env.get("AIO_V109_TREE");
  const old = given ?? await exportTag("v1.0.9-beta");
  const replay = Deno.env.get("AIO_DOWNGRADE_SWEEP_SEED") !== undefined
    ? fuzzEnvInt("AIO_DOWNGRADE_SWEEP_SEED", 0)
    : undefined;
  const n = fuzzEnvInt("AIO_DOWNGRADE_SWEEP_N", 3, 1);
  const seeds = replay !== undefined
    ? [replay]
    : Array.from({ length: n }, (_, i) => (0xd0 + i * 0x9E3779B9) >>> 0);
  assert(seeds.length > 0);
  let namedRuns = 0;
  try {
    for (const seed of seeds) {
      const rng = rngOf(seed);
      const first = rng.pick(["before-fold", "synconly", "mixed"] as const);
      const second = rng.pick(["synconly", "synconly", "mixed"] as const);
      const base = {
        PDM: String(rng.pick([0, 10, 100, 1000])),
        GAP: String(rng.int(60)),
        PGAP: "15",
        OGAP: String(rng.int(20)),
      };
      const env1 = {
        ...base,
        K: String(rng.int(6) + 1),
        KILLAT: String(rng.int(200)),
        ...(rng.chance(0.5) ? { CLEAN: "1" } : {}),
      };
      const env2: Record<string, string> = {
        ...base,
        NBASE: "1000",
        K: String(rng.pick([1, 1, 2, 3, 8])),
        KILLAT: String(rng.int(200)),
        ...(rng.chance(0.5) ? { CLEAN: "1" } : {}),
      };
      // v1.0.9 with the journal OFF (round 6): it saves the store past this
      // build's unreplayed journal, which must then never be replayed over
      // it (store-gen.ts).
      if (rng.chance(0.4)) env2.JOURNAL = "0";
      const what = `seed ${seed} (${first} ${JSON.stringify(env1)} → v1.0.9 ` +
        `${second} ${JSON.stringify(env2)}) — replay: ` +
        `AIO_DOWNGRADE_SWEEP_SEED=${seed}`;
      const dir = await tempDir("aio-downgrade-sweep-");
      try {
        await Deno.copyFile(APP, join(dir, "app.js"));
        const l0 = await run(dir, TREE, first, env1);
        await readSnap(join(dir, "expected.json")).catch(() => {
          throw new Error(`${what}: this build never reached its stop\n${l0}`);
        });
        await Deno.remove(join(dir, "expected.json"));
        const l1 = await run(dir, old, second, env2);
        const live = await readSnap(join(dir, "expected.json")).catch(() => {
          throw new Error(`${what}: v1.0.9 never reached its stop\n${l1}`);
        });
        const log1 = await run(dir, TREE, "read");
        const got = await readSnap(join(dir, "recovered.json"));
        const ctx = `${what}\n${log1}`;
        assert(!/COULD NOT be replayed/.test(log1), ctx);
        // A reaction per add, at most: this build's journal can hold more
        // than v1.0.9 kept (1.0.9 ignores this build's lines), never more
        // than there were adds — unless 1.0.9 itself counted them again.
        for (const k of ["tally", "shaped"] as const) {
          assert(
            got[k] <= Math.max(live[k], got.notes.length),
            `${k} counted twice (${got[k]}; v1.0.9 ${
              live[k]
            }, ${got.notes.length} adds): ${ctx}`,
          );
        }
        // Every item is written once: a second copy is a reaction or a
        // write applied twice.
        for (const k of ["notes", "mirror", "feed"] as const) {
          const twice = got[k].filter((x, i) => got[k].indexOf(x) !== i);
          assertEquals(twice, [], `${k} twice: ${ctx}`);
        }
        // v1.0.9 stopped cleanly: what it held of the source cells is what
        // this build holds — nothing rolled back, nothing older applied
        // late on top.
        if (env2.CLEAN === "1") {
          assertEquals(got.inbox, live.inbox, `inbox: ${ctx}`);
          assertEquals(
            [...got.notes].sort(),
            [...live.notes].sort(),
            `notes: ${ctx}`,
          );
        }
        if (/cannot tell whether/.test(log1)) namedRuns++;
        const log2 = await run(dir, TREE, "read");
        assertEquals(await readSnap(join(dir, "recovered.json")), got, log2);
        assert(
          !/cannot tell whether|in no record|the crash caught|older aio build/
            .test(log2),
          `named again: ${what}\n${log2}`,
        );
      } finally {
        await dropTempDir(dir);
      }
    }
  } finally {
    if (given === undefined) await dropTempDir(old);
  }
  // Non-vacuity: v1.0.9's ops reached this build uncovered, and were named.
  if (replay === undefined) {
    assert(namedRuns > 0, "no run named an op v1.0.9 wrote");
  }
});
