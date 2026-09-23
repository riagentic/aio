// Three silent losses around a sync cell quarantined at boot, and around a
// journal line's version stamp. Real processes, real SIGKILLs, `--prod` (dev
// refuses to boot a cell it would quarantine).
//
//  1. Retiring a quarantined cell's journal lines retired the ones from
//     BEFORE the crash too: not replayed (fine — the cell cannot take them)
//     but compacted away on the first save, so fixing the version afterwards
//     recovered nothing. Only this boot's lines retire now; the older ones
//     are kept, named, and replayed once the cell is fixed.
//  2. A server-origin write to a quarantined cell was applied, acked `ok`,
//     and never saved — said once, then never again. Every one is now
//     answered `unsaved` and logged.
//  3. A `listensTo` reaction line's KEYFRAME carried no version stamp: after
//     a migration and a crash, the old-shape slice was replayed into the new
//     shape (`{"list":[]}`). Stamped now, and refused by name.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { parseJournal } from "../src/server/journal.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function run(
  dir: string,
  src: string,
  phase: string,
): Promise<string> {
  await Deno.writeTextFile(join(dir, "app.ts"), src);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts"), "--prod"],
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

const COMMON = `
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async () => {
  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
  const frames = new Map();
  ws.onmessage = (e) => {
    try {
      const f = JSON.parse(e.data);
      if (f.t === "sync-ack" || f.t === "op-rejected") frames.set(f.d.opId, f);
      if (f.t === "ack") frames.set(f.d.cid, f);
    } catch { /* not a frame */ }
  };
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const wait = async (id) => { while (!frames.has(id)) await sleep(2); return frames.get(id).d; };
  return {
    op: (cell, action, arg) => {
      const id = PHASE + "-op-" + (++n);
      ws.send(JSON.stringify({ v: 2, t: "op", d: { id, hlc: [Date.now(), n, "c1"], cell, action, payload: { args: [arg] } } }));
      return wait(id);
    },
    call: (type, arg) => {
      const cid = PHASE + "-call-" + (++n);
      ws.send(JSON.stringify({ v: 2, t: "action", d: { type, payload: { args: [arg] }, cid } }));
      return wait(cid);
    },
    close: () => ws.close(),
  };
};
`;

const QUARANTINE = `
import { aio, cell } from "${MOD}";
${COMMON}
// "two" declares a version its op-log cannot fold into (no onMigrate): the
// cell is quarantined. "three" is the fix — the version the log was written by.
const mirror = cell("mirror", {
  sync: true, version: PHASE === "two" ? 2 : 1, state: { got: [] },
  methods: { own(s, t) { s.got.push(t); } },
});
const k = cell("k", { state: { n: 0 }, methods: { bump(s) { s.n++; } } });
const app = await aio.run({
  cells: [mirror, k], appId: "quarantine-kept-probe", client: "server-only",
  journal: true, port: PORT, appDir: DIR,
});
const c = await connect();
if (PHASE === "one") {
  for (let i = 0; i < 3; i++) await c.op("mirror", "own", "x" + i);
  await mirror.own("SERVER-WRITE"); // journalled; its fold is ~100 ms away
  Deno.kill(Deno.pid, "SIGKILL");
}
const out = {};
if (PHASE === "two") {
  out.op = await c.op("mirror", "own", "client-p2");
  out.call = await c.call("mirror:own", "server-p2");
  out.call2 = await c.call("mirror:own", "server-p2b");
  // Store-persisted writes: saves, and compactions, happen past the lines kept.
  for (let i = 0; i < 3; i++) await k.bump();
  await sleep(700);
}
out.got = app.getState().mirror.got;
Deno.writeTextFileSync(DIR + "/" + PHASE + ".json", JSON.stringify(out));
c.close();
await app.close();
Deno.exit(0);
`;

Deno.test({
  name:
    "quarantine: the lines from before the crash are kept and named, its server writes are unsaved, and the fix recovers them",
  fn: async () => {
    const dir = await tempDir("aio-quarantine-kept-");
    try {
      await run(dir, QUARANTINE, "one");
      const log2 = await run(dir, QUARANTINE, "two");
      const two = JSON.parse(
        await Deno.readTextFile(join(dir, "two.json")).catch(() => {
          throw new Error(`phase two never finished:\n${log2}`);
        }),
      );
      assertMatch(log2, /QUARANTINED/);
      // 1: kept, and named with their seq range.
      assertMatch(
        log2,
        /"mirror" is quarantined — \d+ journalled lines? written for it before this boot \(seq \d+–\d+\) are KEPT/,
      );
      // 2: a client op is refused; a server-origin write is `unsaved`, each.
      assert(two.op.reason !== undefined, JSON.stringify(two.op));
      for (const call of [two.call, two.call2]) {
        assert(call.ok, JSON.stringify(call));
        assertMatch(
          String(call.unsaved),
          /^persist failed: "mirror" is quarantined/,
        );
      }
      assertMatch(log2, /a write to "mirror" is quarantined/);
      // Fixed: every acked write from before the crash is back.
      const log3 = await run(dir, QUARANTINE, "three");
      const three = JSON.parse(
        await Deno.readTextFile(join(dir, "three.json")).catch(() => {
          throw new Error(`phase three never finished:\n${log3}`);
        }),
      );
      assertEquals(three.got, ["x0", "x1", "x2", "SERVER-WRITE"], log3);
    } finally {
      await dropTempDir(dir);
    }
  },
});

const STAMPED = `
import { aio, cell } from "${MOD}";
${COMMON}
const notes = cell("notes", {
  sync: true, version: 1, state: { items: [] },
  methods: { add(s, t) { s.items.push(t); } },
});
// A store-persisted listener: its reaction to a sync op is journalled as a
// keyframe of its stored slice. "two" migrates it to a new shape.
const tally = PHASE === "one"
  ? cell("tally", {
    version: 1, state: { got: [] },
    methods: { onAdd(s, t) { s.got.push(t); } }, listensTo: { onAdd: notes.add },
  })
  : cell("tally", {
    version: 2, state: { list: [] },
    onMigrate: (s) => ({ list: s.got ?? [] }),
    methods: { onAdd(s, t) { s.list.push(t); } }, listensTo: { onAdd: notes.add },
  });
const app = await aio.run({
  cells: [notes, tally], appId: "stamped-keyframe-probe", client: "server-only",
  journal: true, port: PORT, appDir: DIR,
});
const c = await connect();
if (PHASE === "one") {
  await c.op("notes", "add", "a");
  await sleep(800); // persisted
  await c.op("notes", "add", "b"); // its reaction: a keyframe line, unsaved
  Deno.kill(Deno.pid, "SIGKILL");
}
await sleep(300);
Deno.writeTextFileSync(DIR + "/two.json", JSON.stringify(app.getState().tally));
c.close();
await app.close();
Deno.exit(0);
`;

Deno.test({
  name:
    "journal: a listensTo keyframe carries its cell's version — after a migration it is refused by name, never replayed into the new shape",
  fn: async () => {
    const dir = await tempDir("aio-stamped-keyframe-");
    try {
      await run(dir, STAMPED, "one");
      const journal = await Deno.readTextFile(join(dir, "data", "journal"));
      const kf = (parseJournal(journal, { quiet: true }) as {
        payload?: { keyframes?: Record<string, unknown> };
        v?: Record<string, number>;
      }[])
        .find((e) => e.payload?.keyframes?.tally !== undefined);
      assert(kf, `no keyframe line for tally:\n${journal}`);
      assertEquals(kf.v?.tally, 1, JSON.stringify(kf));
      const log = await run(dir, STAMPED, "two");
      const tally = JSON.parse(
        await Deno.readTextFile(join(dir, "two.json")).catch(() => {
          throw new Error(`phase two never finished:\n${log}`);
        }),
      );
      // The migrated snapshot, not the v1 slice poured into the v2 shape.
      assertEquals(tally.list, ["a"], log);
      assertMatch(log, /"tally" v1 → v2/);
    } finally {
      await dropTempDir(dir);
    }
  },
});
