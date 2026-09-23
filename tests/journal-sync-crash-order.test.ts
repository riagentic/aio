// Two crash-recovery orders the journal got wrong (hunt round 1, area A):
//
//  1. A state line (a `listensTo` reaction recorded as data, a time-travel
//     jump) was restored as `{ ...live, ...stored }`. A key the line's state
//     no longer has — a reaction that `delete`d it — is absent from `stored`,
//     so the spread kept the live value, which at boot is the OLDER store
//     snapshot's: `err: "boom"` back after a SIGKILL, `""` after a clean
//     restart. Now rebuilt as a restart rebuilds it: declared ⊕ stored.
//  2. A SERVER write to a sync cell (a trojan/plain call, no op) was journalled
//     as a call only, and boot replays calls after the whole op-log: `clear`,
//     then an acked client `add("new")`, SIGKILL → boot folded `add` and then
//     cleared it: `[]`, and the op row stays so the client never resends. Now
//     it is also journalled as the state it left AT its op-log position, and
//     boot puts it back between the ops.
//
// Real SIGKILL, real disk, real boot.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = cell("notes", { sync: true, version: 1, state: { items: [] },
  methods: { add(s, t) { s.items.push(t); }, clear(s) { s.items = []; } } });
const status = cell("status", {
  state: { n: 0, err: "" },
  methods: {
    setErr(s, e) { s.err = e; },
    onAdd(s) { s.n++; delete s.err; },
  },
  listensTo: { onAdd: notes.add },
});
const app = await aio.run({ cells: [notes, status], appId: "journal-sync-crash-order",
  client: "server-only", journal: true, port: PORT, appDir: DIR });
const snap = () => ({ notes: app.getState().notes.items, err: app.getState().status.err ?? null,
  n: app.getState().status.n });
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  await app.close();
  Deno.exit(0);
}
const trojan = (type, args) => fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", {
  method: "POST", headers: { "Content-Type": "application/json", "X-AIO": "1" },
  body: JSON.stringify({ type, payload: { args } }) }).then((r) => r.text());
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const acks = new Set();
ws.onmessage = (e) => { try { const f = JSON.parse(e.data); if (f.t === "sync-ack") acks.add(f.d.opId); } catch { /* not a frame */ } };
await new Promise((r) => (ws.onopen = r));
let n = 0;
const op = async (t) => {
  const id = "op-" + (++n);
  ws.send(JSON.stringify({ v: 2, t: "op", d: { id, hlc: [Date.now(), n, "c1"], cell: "notes",
    action: "add", payload: { args: [t] } } }));
  while (!acks.has(id)) await sleep(2);
};
if (MODE === "deleted") {
  await trojan("status:setErr", ["boom"]);
  await sleep(1500); // the store's snapshot now holds err: "boom"
  await op("x"); // its reaction deletes err — journalled as data
} else {
  await op("old");
  await sleep(1200); // folded: "old" is in the snapshot
  await trojan("notes:clear", []);
  await op("new");
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

async function go(mode: string) {
  const dir = await tempDir(`aio-sync-crash-order-${mode}-`);
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const log = await run(dir, "go", mode);
    const read = async (f: string) =>
      JSON.parse(
        await Deno.readTextFile(join(dir, f)).catch(() => {
          throw new Error(`${mode}: the child never reached its kill:\n${log}`);
        }),
      );
    const expected = await read("expected.json");
    await run(dir, "read", mode);
    return { expected, recovered: await read("recovered.json") };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("journal: a key a reaction deleted stays deleted after a SIGKILL — restored as a restart restores it", async () => {
  const { expected, recovered } = await go("deleted");
  assertEquals(expected, { notes: ["x"], err: null, n: 1 }, "live");
  // A restart rebuilds a deleted key from its declared default — never from
  // the older snapshot's value.
  assertEquals(recovered, { notes: ["x"], err: "", n: 1 });
});

Deno.test("journal: a server write to a sync cell comes back BETWEEN the ops it was applied between", async () => {
  for (let i = 0; i < 2; i++) {
    const { expected, recovered } = await go("order");
    assertEquals(expected.notes, ["new"], "live");
    assertEquals(recovered.notes, ["new"], `run ${i}`);
  }
});
