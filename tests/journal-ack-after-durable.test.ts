// An ack is a durability promise — also when the write's journal line could
// not be written and a SAVE stands in for it (a refused append, a redacted
// cell's state). That save used to be fire-and-forget: the `sync-ack` and the
// trojan/WS reply went out first, and a SIGKILL right at the ack lost the
// write it confirmed (external review, rev9: 1 in 48 under load). Every ack
// path now waits for what the action owes (aio.ts `_durableFor`).
//
// And a time-travel jump over a SYNC cell is made durable the same way a
// `listensTo` reaction is: a jump went live but a restart put the cell back
// where its op-log left it — undo half applied (rev9).
//
// Big slices make each save take real time, so a kill "right at the ack"
// lands inside it unless the ack waited.
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
const BIG = Array.from({ length: 20000 }, (_, i) => "x".repeat(90) + i);
const notes = cell("notes", { sync: true, version: 1, state: { items: [] },
  methods: { add(s, t) { s.items.push(t); } } });
const inbox = cell("inbox", { state: { posts: [] },
  methods: { post(s, t) { s.posts.push(t); } } });
const mirror = cell("mirror", { sync: true, version: 1, state: { big: BIG, got: [] },
  methods: { onAdd(s, t) { s.got.push(t); }, onPost(s, t) { s.got.push(t); } },
  listensTo: { onAdd: notes.add, onPost: inbox.post } });
const kv = cell("kv", { state: { big: BIG, got: [] },
  methods: { onAdd(s, t) { s.got.push(t); } }, listensTo: { onAdd: notes.add } });
const app = await aio.run({
  cells: [notes, inbox, mirror, kv],
  appId: "journal-ack-after-durable",
  client: "server-only",
  journal: true,
  // The redacted listener's state never goes in the journal: its own save
  // stands in for the line, on every reaction.
  ...(MODE === "redacted" ? { redactActions: ["mirror"] } : {}),
  persistDebounceMs: 999999,
  port: PORT,
  appDir: DIR,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => {
  const s = app.getState();
  return { notes: s.notes.items, inbox: s.inbox.posts, mirror: s.mirror.got,
    kv: s.kv.got, big: [s.mirror.big.length, s.kv.big.length] };
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
  while (!acks.has(id)) await sleep(0);
};
const kill = () => {
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(snap()));
  Deno.kill(Deno.pid, "SIGKILL");
};
await op("notes", "add", "a1");
if (MODE === "refused") {
  // Every append refused (the journal path is a directory): the reactions'
  // lines stand in as saves — the ack must wait for them.
  const J = DIR + "/data/journal";
  Deno.renameSync(J, J + ".save");
  Deno.mkdirSync(J);
  await op("notes", "add", "F1"); // the sync-ack path
  // The trojan reply path: the action's own line is refused too, so nothing
  // in the journal re-creates its reaction — only the saves hold it.
  await post("/__aio/trojan/dispatch", { type: "inbox:post", payload: { args: ["P1"] } });
  kill();
} else if (MODE === "redacted") {
  await op("notes", "add", "F1");
  kill();
} else if (MODE === "jump") {
  await op("notes", "add", "a2");
  await post("/__aio/trojan/tt", { cmd: "undo" });
  kill();
}
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

const LIVE = {
  refused: { notes: ["a1", "F1"], inbox: ["P1"], mirror: ["a1", "F1", "P1"] },
  redacted: { notes: ["a1", "F1"], inbox: [], mirror: ["a1", "F1"] },
  // Undo: back to before `a2` — in the sync cells too.
  jump: { notes: ["a1"], inbox: [], mirror: ["a1"] },
} as const;

for (const mode of ["refused", "redacted", "jump"] as const) {
  Deno.test(`journal: a SIGKILL right at the ${mode} ack keeps what it confirmed`, async () => {
    // Three runs: the window the kill must not land in is milliseconds wide.
    for (let i = 0; i < 3; i++) {
      const dir = await tempDir(`aio-ack-after-durable-${mode}-`);
      try {
        await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
        const log = await run(dir, "go", mode);
        const expected = JSON.parse(
          await Deno.readTextFile(join(dir, "expected.json")).catch(() => {
            throw new Error(
              `${mode}: the child never reached its kill:\n${log}`,
            );
          }),
        );
        const live = LIVE[mode];
        assertEquals(expected, {
          ...live,
          kv: mode === "jump" ? ["a1"] : live.notes,
          big: [20000, 20000],
        }, "live");
        if (mode === "refused") {
          // The journal path is still a directory: put the file back, as an
          // operator would, before the recovery boot.
          await Deno.remove(join(dir, "data", "journal"));
          await Deno.rename(
            join(dir, "data", "journal.save"),
            join(dir, "data", "journal"),
          );
        }
        await run(dir, "read", mode);
        const boot = await run(dir, "read", mode);
        assertEquals(
          JSON.parse(await Deno.readTextFile(join(dir, "recovered.json"))),
          expected,
          `${mode} run ${i}:\n${boot}`,
        );
      } finally {
        await dropTempDir(dir);
      }
    }
  });
}
