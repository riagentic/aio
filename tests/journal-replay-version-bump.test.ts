// A journal line written by one cell version is not re-run through another's
// methods.
//
// Journal lines carried no version. A build that crashed with its tail
// unsnapshotted, then came back as a build that bumped the cell's `version`
// (with an `onMigrate`), re-ran the OLD build's actions through the NEW
// build's methods on the MIGRATED state. Measured: v1 `add(5)` meaning "+5
// units", v2 migrating units to cents — a clean stop recovered `cents: 500`,
// a SIGKILL recovered `cents: 5`, silently, reported as "recovered 1 action".
// The old method is gone, so no replay can be exact: the entry is refused and
// the refusal is said, like a redacted one.
//
// The same-version crash still replays (the stamp must not cost the journal
// its purpose), and so does a line from a journal written before the stamp.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { replayJournal } from "../src/server/journal.ts";
import type { JournalEntry } from "../src/server/journal.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const V1 = `const w = cell("w", {
  state: { units: 0 },
  methods: { add(s, v) { s.units += v; } },
});`;
const V2 = `const w = cell("w", {
  version: 2,
  state: { cents: 0 },
  onMigrate: (s, from) => {
    if (from < 2) { s.cents = (s.units ?? 0) * 100; delete s.units; }
    return s;
  },
  methods: { add(s, v) { s.cents += v; } },
});`;

const child = (cellSrc: string) => `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
${cellSrc}
const app = await aio.run({
  cells: [w],
  appId: "journal-version-probe",
  client: "server-only",
  journal: true,
  // The first write snapshots; the rest live only in the journal.
  persistDebounceMs: Number(Deno.env.get("DEBOUNCE")),
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
const phase = Deno.env.get("PHASE");
if (phase === "read") {
  Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify(w.cents ?? w.units));
  await app.close();
  Deno.exit(0);
}
await w.add(1);
await new Promise((r) => setTimeout(r, 1000));
await w.add(5);
if (phase === "kill") Deno.kill(Deno.pid, "SIGKILL");
await app.close();
Deno.exit(0);
`;

async function run(
  dir: string,
  src: string,
  phase: string,
  debounce: number,
): Promise<string> {
  await Deno.writeTextFile(`${dir}/app.ts`, src);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      DEBOUNCE: String(debounce),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase !== "kill" && !out.success) {
    throw new Error(`${phase} child failed:\n${text}`);
  }
  return text;
}

/** Run `first` to a stop, restart as `second`, and read the recovered value. */
async function restartAs(
  first: string,
  second: string,
  stop: "kill" | "clean",
): Promise<{ value: number; log: string }> {
  const dir = await tempDir(`aio-journal-version-${stop}-`);
  try {
    // A 100 ms debounce: `add(1)` is snapshotted in the 1 s pause, so the
    // restart has a stored v1 slice to migrate; `add(5)` is journal-only.
    await run(dir, child(first), stop, 100);
    const log = await run(dir, child(second), "read", 999999);
    return {
      value: JSON.parse(await Deno.readTextFile(`${dir}/out.json`)),
      log,
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("journal replay: a v1 action is not re-run through the v2 method after a version bump — refused, and said", async () => {
  const clean = await restartAs(V1, V2, "clean");
  assertEquals(clean.value, 600, "the clean-stop baseline: 6 units → cents");
  const killed = await restartAs(V1, V2, "kill");
  // `add(1)` was snapshotted and migrated (100 cents); `add(5)` ran through a
  // method this build does not have. Re-running it through v2's `add` gave
  // 105 — a value no build ever held.
  assertEquals(
    killed.value,
    100,
    "the v1 tail must not be replayed through the v2 method",
  );
  assertStringIncludes(killed.log, "COULD NOT be replayed");
  assertStringIncludes(killed.log, `"w" v0 → v2`);
});

Deno.test("journal replay: the same build's crash still recovers its whole tail", async () => {
  const killed = await restartAs(V2, V2, "kill");
  assertEquals(killed.value, 6);
  assert(!killed.log.includes("COULD NOT be replayed"), killed.log);
});

Deno.test("replayJournal: a stamped entry replays only under its own version; an unstamped one as it always did", () => {
  const reduce = (s: { n: number }, a: { payload?: unknown }) => ({
    state: { n: s.n + (a.payload as number) },
  });
  const e = (seq: number, v?: Record<string, number>): JournalEntry => ({
    seq,
    type: "w:add",
    payload: 1,
    ts: 0,
    ...(v ? { v } : {}),
  });
  const r = replayJournal(
    { n: 0 },
    [e(1, { w: 2 }), e(2, { w: 1 }), e(3)],
    reduce,
    undefined,
    (c) => (c === "w" ? 2 : 0),
  );
  assertEquals(r.state, { n: 2 });
  assertEquals(r.replayed, 2);
  assertEquals(r.skipped.map((s) => [s.seq, s.reason]), [[2, "version"]]);
});

// A version with no `onMigrate` converts nothing: boot keeps the stored
// snapshot as it is ("stamping w at version 1 — first time this cell declares
// one, so there is no older shape to convert"), so the tail on top of it is
// in that same shape. Refusing it threw away acked writes for nothing — on
// the ordinary first adoption of `version:` — and said the cell had been
// "migrated away from" when nothing had migrated. A crash must restore what a
// clean stop does.
const V1_STAMPED = `const w = cell("w", {
  version: 1,
  state: { units: 0 },
  methods: { add(s, v) { s.units += v; } },
});`;

Deno.test("journal replay: a version with no onMigrate converts nothing, so the tail under it still replays", async () => {
  const clean = await restartAs(V1, V1_STAMPED, "clean");
  assertEquals(clean.value, 6, "the clean-stop baseline");
  const killed = await restartAs(V1, V1_STAMPED, "kill");
  assertEquals(killed.value, 6, `the tail must replay:\n${killed.log}`);
  assert(!killed.log.includes("COULD NOT be replayed"), killed.log);
});

Deno.test("replayJournal: an older stamp replays on a cell that converts nothing; a converting cell and a downgrade still refuse", () => {
  const reduce = (s: { n: number }, a: { payload?: unknown }) => ({
    state: { n: s.n + (a.payload as number) },
  });
  const e = (seq: number, v: Record<string, number>): JournalEntry => ({
    seq,
    type: "w:add",
    payload: 1,
    ts: 0,
    v,
  });
  const run = (migrates: boolean) =>
    replayJournal(
      { n: 0 },
      [e(1, { w: 0 }), e(2, { w: 2 }), e(3, { w: 1 })],
      reduce,
      undefined,
      () => 1,
      () => migrates,
    );
  assertEquals(
    run(false).skipped.map((s) => s.seq),
    [2],
    "no onMigrate: the older stamp replays, the newer (downgrade) does not",
  );
  assertEquals(run(true).skipped.map((s) => s.seq), [1, 2]);
});
