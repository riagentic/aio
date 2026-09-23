// The journal's STATE lines — a `listensTo` reaction, a time-travel jump —
// must survive a SIGKILL under two conditions that used to lose them
// (external review, rev8):
//
//  1. A refused append. Its stand-in is the save of the clock that holds the
//     write: the fold of the sync cell, the store's persist for a KV cell. One
//     app-wide "a flush is pending" flag let the sync reaction's refused line
//     swallow the KV reaction's persist in the same burst — the KV reaction
//     was then in no line and no save, and a kill lost it. Coalesced per
//     clock now (aio.ts `_saveNow`).
//  2. A `redactActions` pattern that matches a state line's TYPE. The type
//     names no cell (`aio:__timeTravel`, `__aioSyncReaction`), yet `"a*"` or
//     `"__*"` blanked every such line to "[redacted]": nothing protected,
//     the state lost. Their redaction is per cell, decided where they are
//     written; the journal no longer blanks them by type.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const MODE = Deno.env.get("MODE");
const notes = cell("notes", { sync: true, version: 1, state: { items: [] },
  methods: { add(s, t) { s.items.push(t); } } });
const mirror = cell("mirror", { sync: true, version: 1, state: { got: [] },
  methods: { onAdd(s, t) { s.got.push(t); } }, listensTo: { onAdd: notes.add } });
const kv = cell("kv", { state: { got: [] },
  methods: { onAdd(s, t) { s.got.push(t); } }, listensTo: { onAdd: notes.add } });
const pad = cell("pad", { state: { v: 0 }, methods: { set(s, v) { s.v = v; } } });
const app = await aio.run({
  cells: [notes, mirror, kv, pad],
  appId: "journal-state-lines-durable",
  client: "server-only",
  journal: true,
  // Patterns that match the state lines' TYPES, and no cell of this app.
  ...(MODE === "patterns" ? { redactActions: ["a*", "__*"] } : {}),
  // The store saves only when told to: a KV write lives in its journal line,
  // or in the save that stands in for a refused one — nowhere else.
  persistDebounceMs: 999999,
  port: PORT,
  appDir: DIR,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => {
  const s = app.getState();
  return { notes: s.notes.items, mirror: s.mirror.got, kv: s.kv.got, pad: s.pad.v };
};
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  Deno.exit(0);
}
const post = async (path, body) => {
  const res = await fetch("http://127.0.0.1:" + PORT + path, { method: "POST",
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
const J = DIR + "/data/journal";
await op("notes", "add", "a1");
if (MODE === "refused") {
  // Every append refused (the journal path is a directory) for one op: its
  // sync AND its KV reaction line both fail in the same burst.
  Deno.renameSync(J, J + ".save");
  Deno.mkdirSync(J);
  await op("notes", "add", "F1");
  await sleep(400); // the stand-in saves land
  Deno.removeSync(J);
  Deno.renameSync(J + ".save", J);
  // Killed with no later line: a later reaction line would start a new
  // chain (whole state) and carry F1 back by itself, hiding a lost save.
} else {
  await post("/__aio/trojan/dispatch", { type: "pad:set", payload: { args: [1] } });
  await post("/__aio/trojan/dispatch", { type: "pad:set", payload: { args: [2] } });
  await post("/__aio/trojan/tt", { cmd: "undo" });
  await post("/__aio/trojan/tt", { cmd: "resume" });
  await op("notes", "add", "a2");
}
Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(snap()));
Deno.kill(Deno.pid, "SIGKILL");
`;

async function run(dir: string, phase: string, mode: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      MODE: mode,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase === "read" && !out.success) throw new Error(text);
  return text;
}

for (
  const [mode, want] of [
    ["refused", { notes: ["a1", "F1"], pad: 0 }],
    ["patterns", { notes: ["a1", "a2"], pad: 1 }],
  ] as const
) {
  Deno.test(`journal state lines: a ${mode === "refused" ? "refused append" : "type-matching redactActions pattern"} loses no reaction or jump to a SIGKILL`, async () => {
    const dir = await tempDir(`aio-journal-state-lines-${mode}-`);
    try {
      await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
      const log = await run(dir, "go", mode);
      const expected = JSON.parse(
        await Deno.readTextFile(join(dir, "expected.json")).catch(() => {
          throw new Error(`${mode}: the child never reached its kill:\n${log}`);
        }),
      );
      assertEquals(expected, {
        notes: want.notes,
        mirror: want.notes,
        kv: want.notes,
        pad: want.pad,
      }, "live");
      await run(dir, "read", mode);
      const boot = await run(dir, "read", mode);
      assertEquals(
        JSON.parse(await Deno.readTextFile(join(dir, "recovered.json"))),
        expected,
        boot,
      );
    } finally {
      await dropTempDir(dir);
    }
  });
}
