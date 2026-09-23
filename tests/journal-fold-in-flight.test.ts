// A sync cell's fold re-bases its reaction chain on the snapshot it writes, so
// the line after a fold is a delta against that snapshot, not the whole cell
// (a 1.5 MB cell journalled 1.6 MB per fold — measured). The hard case is a
// line written WHILE the fold is in flight: it is a delta against the old
// chain, whose lines the fold's watermark drops the moment it lands. That
// line also carries `alsoSnapshot` — the same state against the fold's
// snapshot — so the chain resolves whichever way the crash falls.
//
// Real SIGKILL, at exactly that point: the child writes until a line with
// `alsoSnapshot` is the newest, waits for ITS fold's watermark to be on disk,
// and dies before any later fold. Recovery must hold every acked write.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const APP = "fold-in-flight-probe";

const CHILD = `
import { aio, cell } from "${MOD}";
import { DatabaseSync } from "node:sqlite";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
// Big enough that its fold takes a while — writes land inside it.
const pad = Array.from({ length: 30000 }, (_, i) => "pad-" + i);
const big = cell("big", {
  sync: true, version: 1, state: { pad, got: [] },
  methods: { add(s, t) { if (s.got.includes(t)) throw new Error("dup " + t); s.got.push(t); } },
});
const app = await aio.run({
  cells: [big], appId: "${APP}", client: "server-only", journal: true,
  port: PORT, appDir: DIR,
});
const got = () => app.getState().big.got;
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(got()));
  Deno.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newest = () => {
  let text = "";
  try { text = Deno.readTextFileSync(DIR + "/data/journal"); } catch { return; }
  const lines = text.trim().split("\\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === "__aioSyncReaction" && e.payload?.cell === "big") return { ...e.payload, seq: e.seq };
    } catch { /* torn */ }
  }
};
const wm = () => {
  let db;
  try { db = new DatabaseSync(DIR + "/data/state.db", { readOnly: true }); } catch { return; }
  try {
    const row = db.prepare("SELECT v FROM aio_kv WHERE k = ?")
      .get("${APP}:__journal_wm:big");
    return row ? JSON.parse(row.v) : undefined;
  } finally { db.close(); }
};
let n = 0;
if (PHASE === "size") {
  // Each write after a landed fold: a small delta on the snapshot, never
  // the whole 30 000-entry cell again.
  const kinds = [];
  for (let i = 0; i < 5; i++) {
    await big.add("s" + (++n));
    const p = newest();
    kinds.push(p.state ? "keyframe" : "delta");
    // Its fold lands (debounce 100 ms, max wait 500 ms): the watermark passes it.
    for (const wait = Date.now() + 10000; Date.now() < wait && !(wm() >= p.seq);) {
      await sleep(10);
    }
  }
  Deno.writeTextFileSync(DIR + "/kinds.json", JSON.stringify(kinds));
  Deno.exit(0);
}
for (const until = Date.now() + 20000; Date.now() < until;) {
  await big.add("w" + (++n)); // a server-origin write, journalled
  const p = newest();
  if (!p?.alsoSnapshot) { await sleep(4); continue; }
  // The line is written; wait for its fold — and only its fold — to land.
  for (const wait = Date.now() + 5000; Date.now() < wait;) {
    const w = wm();
    if (w === p.alsoSnapshot.at) {
      Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(got()));
      Deno.kill(Deno.pid, "SIGKILL");
    }
    if (w !== undefined && w > p.alsoSnapshot.at) break; // a later fold: again
    await sleep(1);
  }
}
Deno.writeTextFileSync(DIR + "/missed", "never caught a fold in flight");
Deno.exit(3);
`;

async function runChild(dir: string, phase: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase === "read" && !out.success) {
    throw new Error(`read child failed:\n${text}`);
  }
  return text;
}

Deno.test({
  name:
    "journal: SIGKILL right after a fold lands under a line written while it was in flight keeps every acked write",
  fn: async () => {
    const dir = await tempDir("aio-fold-in-flight-");
    try {
      await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
      const crashLog = await runChild(dir, "crash");
      const expected = JSON.parse(
        await Deno.readTextFile(join(dir, "expected.json")).catch(() => {
          throw new Error(`the child never reached its kill:\n${crashLog}`);
        }),
      ) as string[];
      assert(expected.length > 0);
      // Twice: the recovery must be durable and must not re-apply itself.
      const firstLog = await runChild(dir, "read");
      const bootLog = await runChild(dir, "read");
      const recovered = JSON.parse(
        await Deno.readTextFile(join(dir, "recovered.json")),
      ) as string[];
      assertEquals(recovered, expected, bootLog);
      assert(!/reaction chain|no keyframe/.test(firstLog), firstLog);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "journal: a write after a sync cell's fold is a delta on its snapshot, not the whole cell again",
  fn: async () => {
    const dir = await tempDir("aio-fold-rebase-size-");
    try {
      await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
      const log = await runChild(dir, "size");
      const kinds = JSON.parse(
        await Deno.readTextFile(join(dir, "kinds.json")).catch(() => {
          throw new Error(`the size child did not finish:\n${log}`);
        }),
      );
      // The first line after boot has no fold to rest on; every later one does.
      // (A delta on the snapshot, or — written between the fold's commit and
      // its callback — on the old chain with `alsoSnapshot`: never whole.)
      assertEquals(kinds, ["keyframe", "delta", "delta", "delta", "delta"]);
    } finally {
      await dropTempDir(dir);
    }
  },
});
