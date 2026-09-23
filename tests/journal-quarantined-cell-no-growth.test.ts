// A QUARANTINED sync cell (its log cannot be folded into this build's shape —
// prod runs on) never saves, so its journal watermark never moves. A listener
// cell in that state got a reaction line per op of the cell it listens to,
// and none was ever compacted: 300 ops → 298 lines, 1500 → 1487, rewritten
// on every compaction, while boot refuses them anyway. It gets no lines now
// (said once), and the journal drops any line kept for such a cell alone.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createJournal } from "../src/server/journal.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const notes = cell("notes", { sync: true, version: 1, state: { items: [] },
  methods: { add(s, t) { s.items.push(t); } } });
const mirror = cell("mirror", { sync: true, version: PHASE === "one" ? 1 : 2, state: { got: [] },
  methods: { onAdd(s, t) { s.got.push(t); }, own(s, t) { s.got.push("own" + t); } },
  listensTo: { onAdd: notes.add } });
const app = await aio.run({ cells: [notes, mirror], appId: "journal-quarantine-growth",
  client: "server-only", journal: true, port: PORT, appDir: DIR });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const acks = new Set();
ws.onmessage = (e) => { try { const f = JSON.parse(e.data); if (f.t === "sync-ack") acks.add(f.d.opId); } catch { /* not a frame */ } };
await new Promise((r) => (ws.onopen = r));
let n = 0;
const op = async (c, a, arg) => {
  const id = PHASE + "-op-" + (++n);
  ws.send(JSON.stringify({ v: 2, t: "op", d: { id, hlc: [Date.now(), n, "c1"], cell: c, action: a, payload: { args: [arg] } } }));
  while (!acks.has(id)) await sleep(1);
  await sleep(12); // inside the per-client frame budget
};
if (PHASE === "one") {
  for (let i = 0; i < 3; i++) await op("mirror", "own", "x" + i);
  Deno.kill(Deno.pid, "SIGKILL"); // before any fold: the v1 ops stay in the log
}
for (let i = 0; i < 60; i++) await op("notes", "add", "n" + i);
await sleep(700); // folds and a persist land
let text = "";
try { text = Deno.readTextFileSync(DIR + "/data/journal"); } catch { /* never created */ }
Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify({
  notes: app.getState().notes.items.length,
  mirrorLines: text.split("\\n").filter((l) => l.includes('"mirror"')).length,
}));
await app.close();
Deno.exit(0);
`;

async function run(dir: string, phase: string, prod: boolean): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      CONFIG,
      join(dir, "app.ts"),
      ...(prod ? ["--prod"] : []),
    ],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

Deno.test("journal: a quarantined listener cell gets no reaction lines — the journal does not grow per op", async () => {
  const dir = await tempDir("aio-quarantine-growth-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    await run(dir, "one", true);
    const log = await run(dir, "two", true);
    assert(/QUARANTINED/.test(log), log);
    const out = JSON.parse(
      await Deno.readTextFile(join(dir, "out.json")).catch(() => {
        throw new Error(log);
      }),
    );
    assertEquals(out.notes, 60, "the other cell works on");
    assertEquals(out.mirrorLines, 0, "no line for the quarantined cell");
    assertEquals(
      log.match(/"mirror" is quarantined — its writes are not journalled/g)
        ?.length,
      1,
      "said once",
    );
    assertEquals(
      log.match(/compaction of "mirror" skipped/g)?.length,
      1,
      "said once",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal: lines kept for a cell that will never fold do not pin compaction", async () => {
  const dir = await tempDir("aio-journal-retire-");
  try {
    const path = join(dir, "journal");
    const j = createJournal(path, {});
    j.trackCells({ q: 0, s: 0 });
    j.retireCells(["q"]);
    j.append(
      { type: "__aioSyncReaction", payload: { cell: "q" }, only: ["q"] },
      1,
    );
    j.append({ type: "q:own", payload: {} }, 2);
    j.append({ type: "__x", payload: {}, only: ["q", "s"] }, 3); // held by s
    j.append({ type: "k:add", payload: {} }, 4);
    assertEquals(
      j.readTail().map((e) => e.seq),
      [3, 4],
      "q's alone are not replayed",
    );
    j.setWatermark(4);
    const kept = Deno.readTextFileSync(path).split("\n").filter(Boolean)
      .map((l) => JSON.parse(l).seq);
    assertEquals(kept, [3], "only the line s still has to hold");
    j.close();
  } finally {
    await dropTempDir(dir);
  }
});
