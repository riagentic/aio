// Three ways the journalled `listensTo` reaction (aio.ts `_journalReaction`)
// could be turned against the app, each through a REAL door and a real
// SIGKILL (external review, rev7):
//
//  1. A forged op-log position. The host records how far a sync cell's live
//     state holds its op-log from `_syncTs`, which only the sync handler may
//     stamp. A client that sent `_syncTs: 9e15` on a plain action pinned it:
//     every later reaction line claimed ops the state never held, boot seeded
//     from it and folded none of them — acked ops gone for good once
//     compaction dropped the log. Honoured only with `_syncOp` now, and
//     stripped at every network door (said, like every forged trusted field).
//  2. A redacted cell's state in cleartext. `redactActions` keeps a cell's
//     values out of every sink; reaction lines — and a user's time-travel
//     line — wrote them into the journal anyway. Withheld now, and made
//     durable by the cell's own save instead.
//  3. The cost of a reaction line. The whole slice per reaction was 8× the
//     op cost on a 2 MB listener; a line is now what the reaction changed
//     (a delta chain from a keyframe), and recovery is still exact.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  parseJournal,
  SYNC_REACTION_TYPE,
  type SyncReaction,
  type TimeTravelRestore,
  TT_RESTORE_TYPE,
} from "../src/server/journal.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const SIZE = 4000;
// Every byte the journal is ever given, before any compaction drops it.
const write = Deno.writeTextFileSync;
Deno.writeTextFileSync = (p, d, o) => {
  if (String(p).endsWith("/journal")) write(DIR + "/journal-all.log", d, { append: true });
  return write(p, d, o);
};
const notes = cell("notes", { sync: true, version: 1, state: { items: [] },
  methods: { add(s, t) { s.items.push(t); } } });
const mirror = cell("mirror", { sync: true, version: 1, state: { got: [] },
  methods: { onAdd(s, t) { s.got.push(t); } }, listensTo: { onAdd: notes.add } });
// secretK is not listening in the cost phase: a redacted store-persisted
// listener makes every reaction a store save (its stand-in for the journal
// line), and a store save restarts every store chain — that cost is the
// redaction's, measured apart. secretS listens: its stand-in is a fold of
// secretS ALONE, which must leave bigS's chain running.
const secretOn = PHASE === "big" ? {} : { onAdd: notes.add };
const secretS = cell("secretS", { sync: true, version: 1, state: { keys: [] },
  methods: { onAdd(s, t) { s.keys.push("SECRET-s-" + t); } }, listensTo: { onAdd: notes.add } });
const secretK = cell("secretK", { state: { keys: [] },
  methods: { onAdd(s, t) { s.keys.push("SECRET-k-" + t); } }, listensTo: secretOn });
const pad = cell("pad", { state: { v: "" }, methods: { set(s, v) { s.v = v; } } });
const bigS = cell("bigS", { sync: true, version: 1,
  state: { rows: Array.from({ length: SIZE }, (_, i) => "r".repeat(90) + i), n: 0 },
  methods: { onAdd(s) { s.n++; } }, listensTo: { onAdd: notes.add } });
const bigK = cell("bigK", {
  state: { rows: Array.from({ length: SIZE }, (_, i) => "k".repeat(90) + i), n: 0 },
  methods: { onAdd(s) { s.n++; } }, listensTo: { onAdd: notes.add } });
const app = await aio.run({
  cells: [notes, mirror, secretS, secretK, pad, bigS, bigK],
  appId: "journal-reaction-hardening",
  client: "server-only",
  journal: true,
  redactActions: ["secretS", "secretK", "pad"],
  // The store saves only when told to (a withheld cell's own save does):
  // every store-persisted reaction stays in the tail, to be counted.
  persistDebounceMs: 999999,
  port: PORT,
  appDir: DIR,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => {
  const s = app.getState();
  return { notes: s.notes.items, mirror: s.mirror.got, secretS: s.secretS.keys,
    secretK: s.secretK.keys, pad: s.pad.v, bigS: [s.bigS.n, s.bigS.rows.length],
    bigK: [s.bigK.n, s.bigK.rows.length] };
};
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  Deno.exit(0);
}
const base = "http://127.0.0.1:" + PORT;
const post = async (path, body) => {
  const res = await fetch(base + path, { method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status !== 200) throw new Error(res.status + " " + text);
};
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const acks = new Set();
ws.onmessage = (e) => {
  try { const f = JSON.parse(e.data); if (f.t === "sync-ack") acks.add(f.d.opId); }
  catch { /* not a frame */ }
};
await new Promise((r) => (ws.onopen = r));
let n = 0;
const op = async (c, a, arg) => {
  const id = "op-" + (++n);
  ws.send(JSON.stringify({ v: 2, t: "op", d: { id, hlc: [Date.now(), n, "c1"],
    cell: c, action: a, payload: { args: [arg] } } }));
  while (!acks.has(id)) await sleep(1);
};
const done = () => {
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(snap()));
  Deno.kill(Deno.pid, "SIGKILL");
};
if (PHASE.startsWith("forge-")) {
  await op("notes", "add", "a1");
  const forged = { type: "mirror:onAdd", payload: { args: ["x"] }, _syncTs: 9e15 };
  if (PHASE === "forge-trojan") await post("/__aio/trojan/dispatch", forged);
  if (PHASE === "forge-ws") {
    ws.send(JSON.stringify({ v: 2, t: "action", d: forged }));
    while (!app.getState().mirror.got.includes("x")) await sleep(2);
  }
  // Server code is no door — the host itself must not trust the field.
  if (PHASE === "forge-server") await app.dispatch(forged);
  await sleep(1200); // folded AND compacted: the ops below a1 leave the log
  await op("mirror", "onAdd", "direct1");
  await op("notes", "add", "a2");
  await op("mirror", "onAdd", "direct2");
  done();
} else if (PHASE === "redact") {
  await op("notes", "add", "a1");
  await post("/__aio/trojan/dispatch", { type: "pad:set", payload: { args: ["SECRET-pad-1"] } });
  await post("/__aio/trojan/dispatch", { type: "pad:set", payload: { args: ["SECRET-pad-2"] } });
  await post("/__aio/trojan/tt", { cmd: "undo" });
  await post("/__aio/trojan/tt", { cmd: "resume" });
  await op("notes", "add", "a2");
  await sleep(400); // the withheld cells' own saves land
  done();
} else if (PHASE === "big") {
  for (let i = 0; i < 40; i++) await op("notes", "add", "b" + i);
  done();
}
`;

async function run(dir: string, phase: string): Promise<string> {
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
  if (phase === "read" && !out.success) throw new Error(text);
  return text;
}

async function crash(phase: string) {
  const dir = await tempDir(`aio-reaction-hardening-${phase}-`);
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const log = await run(dir, phase);
    const expected = JSON.parse(
      await Deno.readTextFile(join(dir, "expected.json")).catch(() => {
        throw new Error(`${phase}: the child never reached its kill:\n${log}`);
      }),
    );
    const journal = await Deno.readTextFile(join(dir, "data", "journal"))
      .catch(() => "");
    const written = await Deno.readTextFile(join(dir, "journal-all.log"))
      .catch(() => "");
    await run(dir, "read");
    const boot = await run(dir, "read");
    const recovered = JSON.parse(
      await Deno.readTextFile(join(dir, "recovered.json")),
    );
    return { expected, recovered, log, boot, journal, written };
  } finally {
    await dropTempDir(dir);
  }
}

for (const door of ["trojan", "ws", "server"]) {
  Deno.test(`journal reactions: a forged _syncTs (${door}) cannot move a sync cell's op-log position`, async () => {
    const { expected, recovered, log, boot } = await crash(`forge-${door}`);
    assertEquals(
      expected.mirror,
      ["a1", "x", "direct1", "a2", "direct2"],
      "live",
    );
    assertEquals(recovered, expected, boot);
    if (door !== "server") {
      assert(
        /trusted field\(s\)[^\n]*_syncTs/.test(log),
        `the ${door} door strips and names the forged field:\n${log}`,
      );
    }
  });
}

Deno.test("journal reactions: a redacted cell's state never reaches the journal — and still survives the kill", async () => {
  const { expected, recovered, written, boot } = await crash("redact");
  assertEquals(expected.secretS, ["SECRET-s-a1", "SECRET-s-a2"]);
  assertEquals(expected.secretK, ["SECRET-k-a1", "SECRET-k-a2"]);
  assertEquals(expected.pad, "SECRET-pad-1", "the undo landed");
  const lines = parseJournal(written);
  assert(
    lines.some((e) => e.type === SYNC_REACTION_TYPE) &&
      lines.some((e) =>
        e.type === TT_RESTORE_TYPE &&
        (e.payload as TimeTravelRestore).cmd === "undo"
      ),
    `the journal saw the reactions and the jump:\n${written}`,
  );
  assert(
    !written.includes("SECRET"),
    `a redacted value reached the journal:\n${written}`,
  );
  assertEquals(recovered, expected, boot);
});

Deno.test("journal reactions: a line costs what the reaction changed, and recovery stays exact", async () => {
  const { expected, recovered, written, boot } = await crash("big");
  assertEquals(expected.bigS, [40, 4000]);
  assertEquals(expected.bigK, [40, 4000]);
  // Not secretS: killed at once, its last reaction may not have reached its
  // own fold yet (the redact test waits for it).
  const { secretS: _r, ...rest } = recovered;
  const { secretS: _e, ...want } = expected;
  assertEquals(rest, want, boot);
  // Every line the run wrote, not only the tail the kill left.
  const lines = parseJournal(written);
  // Each entry's own serialized size (an entry inside a batch line — one
  // sync op's reduce, journal.ts `BATCH_TYPE` — is measured alone).
  const rawOf = new Map(lines.map((e) => [e.seq, JSON.stringify(e)]));
  const syncLines = lines.filter((e) =>
    e.type === SYNC_REACTION_TYPE &&
    (e.payload as SyncReaction).cell === "bigS"
  );
  const kvLines = lines.filter((e) => {
    const p = e.payload as TimeTravelRestore;
    return e.type === TT_RESTORE_TYPE &&
      (p.cells?.bigK !== undefined || p.deltas?.bigK !== undefined);
  });
  for (
    const [what, all, isKey] of [
      [
        "bigS",
        syncLines,
        (p: unknown) => (p as SyncReaction).state !== undefined,
      ],
      [
        "bigK",
        kvLines,
        (p: unknown) => (p as TimeTravelRestore).cells?.bigK !== undefined,
      ],
    ] as const
  ) {
    const keys = all.filter((e) => isKey(e.payload));
    const deltas = all.filter((e) => !isKey(e.payload));
    assert(
      deltas.length > keys.length,
      `${what}: ${deltas.length} delta line(s), ${keys.length} whole-slice`,
    );
    for (const d of deltas) {
      const bytes = rawOf.get(d.seq)!.length;
      assert(bytes < 4096, `${what}: a delta line of ${bytes} bytes`);
    }
  }
});
