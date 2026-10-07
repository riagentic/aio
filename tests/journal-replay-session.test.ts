// A boot's journal replay is its OWN session: what an earlier replay in the
// same process spent is not this boot's debt.
//
// The replay ceiling (`journal.replay.entries`, src/server/journal.ts) exists
// to stop a recovery path that re-enters replay. It was counted for the life
// of the PROCESS and never reset, so an in-process restart — or a legitimately
// large tail — reached it with no loop anywhere, and the app was told it had a
// control-flow bug. `replayJournal` now charges only a RE-ENTRY within one
// session; this pins the half that lives in the boot: it opens the session —
// once, when the boot starts. Opened beside the replay, whatever reached the
// replay a second time opened a new session for itself, and the ceiling could
// not fire at all.
import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fromFileUrl } from "@std/path";
import { spec } from "./module-spec-helper.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const JOURNAL = new URL("../src/server/journal.ts", import.meta.url).href;
const LEDGER =
  new URL("../src/diagnostics/memory-ledger.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

const APP = `
import { aio, cell } from "${spec(MOD)}";
import { replayJournal } from "${spec(JOURNAL)}";
import { readGauges } from "${spec(LEDGER)}";
const DIR = Deno.env.get("DIR");
const phase = Deno.env.get("PHASE");
const spent = () => readGauges().find((g) => g.name === "journal.replay.entries")?.value;
let before;
if (phase === "read") {
  // What an earlier boot in this process leaves behind: one replay, and one
  // re-entry of five entries.
  const e = { seq: 1, ts: 0, type: "c:noop" };
  replayJournal({}, [e], (s) => ({ state: s }));
  replayJournal({}, [e, e, e, e, e], (s) => ({ state: s }));
  before = spent();
}
const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n += 1; } } });
let restores = 0;
const app = await aio.run({
  cells: [c],
  // "reenter": something INSIDE the boot replays before the boot's own replay
  // does — which makes the boot's replay the second of its session.
  onRestore: (s) => {
    if (phase === "reenter" && restores++ === 0) {
      replayJournal({}, [{ seq: 1, ts: 0, type: "c:noop" }], (x) => ({ state: x }));
    }
    return s;
  },
  appId: "journal-replay-session-probe",
  client: "server-only",
  journal: true,
  persistDebounceMs: 999999,
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
if (phase === "die") Deno.kill(Deno.pid, "SIGKILL");
if (phase !== "kill") {
  Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify({ n: c.n, before, after: spent(), restores }));
  await app.close();
  Deno.exit(0);
}
await c.inc();
await c.inc();
await c.inc();
Deno.kill(Deno.pid, "SIGKILL");
`;

async function run(dir: string, phase: string): Promise<string | void> {
  await Deno.writeTextFile(`${dir}/app.ts`, APP);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (phase === "refused") {
    return new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
  }
  if (phase !== "kill" && phase !== "die" && !out.success) {
    throw new Error(
      `${phase} child failed:\n${new TextDecoder().decode(out.stdout)}${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
}

Deno.test({
  name:
    "replay session: a boot recovering its journal starts from zero — an earlier replay in the process is not its debt",
  async fn() {
    const dir = await tempDir("aio-journal-replay-session-");
    try {
      await run(dir, "kill");
      await run(dir, "read");
      const out = JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
      assertEquals(out.n, 3, "the tail was recovered — the replay ran");
      assertEquals(out.before, 5, "the earlier re-entry was on the counter");
      assertEquals(
        out.after,
        0,
        "the boot opened a new session: its own tail is free, and nothing " +
          "carried over",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "replay session: a second replay INSIDE one boot is charged — the boot does not open a session beside its own replay",
  async fn() {
    const dir = await tempDir("aio-journal-replay-reenter-");
    try {
      await run(dir, "kill");
      await run(dir, "reenter");
      const out = JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
      assertEquals(out.n, 3, "the tail was recovered — the replay ran");
      assert(out.restores > 0, "the hook that replays first did run");
      assertEquals(
        out.after,
        3,
        "the boot's own three entries came second in its session, so they " +
          "are what the ceiling counted",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

/** The one `<journal>.replayed` under `dir`, as `[fromSeq, charged]`. */
async function marker(dir: string): Promise<{ path: string; is: number[] }[]> {
  const found: { path: string; is: number[] }[] = [];
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.name.endsWith(".replayed")) {
        found.push({
          path: p,
          is: (await Deno.readTextFile(p)).split(" ").map(Number),
        });
      }
    }
  };
  await walk(dir);
  return found;
}

// `beginReplaySession` makes each boot a new session — so a loop that re-runs
// the WHOLE boot was never counted, in one process or across a supervisor's
// restarts: every pass replayed the tail "for the first time". The marker
// beside the journal carries the count from boot to boot, and a save ends it.
Deno.test({
  name:
    "replay session: boot after boot over a tail no save compacted is charged — and a crash, a restart and a save costs nothing",
  async fn() {
    const dir = await tempDir("aio-journal-replay-boots-");
    try {
      await run(dir, "kill");
      assertEquals(await marker(dir), [], "nothing replayed yet");
      // Three boots that die after their replay and before any save.
      await run(dir, "die");
      const first = await marker(dir);
      assertEquals(first.length, 1);
      assertEquals(first[0]!.is[1], 0, "the first replay of a tail is free");
      await run(dir, "die");
      assertEquals((await marker(dir))[0]!.is, [first[0]!.is[0]!, 3]);
      await run(dir, "die");
      assertEquals((await marker(dir))[0]!.is, [first[0]!.is[0]!, 6]);
      // At the ceiling the boot is refused, by name — that boot only: the
      // count starts over, so recovery is never why an app stays down.
      await Deno.writeTextFile(first[0]!.path, `${first[0]!.is[0]} 2000000`);
      const said = await run(dir, "refused") as string;
      assert(said.includes("MEMORY_UNBOUNDED"), said);
      assert(said.includes('"journal.replay.entries"'), said);
      assert(said.includes(".replayed"), said);
      assertEquals((await marker(dir))[0]!.is, [first[0]!.is[0]!, 0]);
      // The next start replays; it saves on its way out, and the boot after
      // that has nothing to replay: the marker is gone.
      await run(dir, "read");
      const out = JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
      assertEquals(out.n, 3, "the tail was recovered");
      assertEquals(out.after, 3, "counted from zero again: this replay only");
      await run(dir, "read");
      assertEquals(await marker(dir), [], "no tail, no marker");
    } finally {
      await dropTempDir(dir);
    }
  },
});
