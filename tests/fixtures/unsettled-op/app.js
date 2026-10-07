// The app of tests/sync-op-killed-before-settle.test.ts: one sync cell whose
// method refuses a duplicate, and KILLS the process at a chosen point INSIDE
// the method — after the op's row is stored, before the server decides it.
const { aio, cell } = await import(Deno.env.get("MOD"));
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const die = () => Deno.kill(Deno.pid, "SIGKILL");
const notes = cell("notes", {
  sync: true,
  version: 1,
  state: { items: [] },
  // A refusal that does not throw.
  validate: (s) => s.items.every((t) => t !== "bad") || "no bad",
  methods: {
    add(s, t) {
      // STRICT: the method as a later deploy changed it — it refuses what it
      // once accepted.
      if (Deno.env.get("STRICT") === "1") throw new Error("strict " + t);
      if (s.items.includes(t)) {
        if (PHASE === "kill-refused") die();
        throw new Error("dup " + t);
      }
      if (PHASE === "kill-accepted" && t === "n2") die();
      if (PHASE === "kill-invalid" && t === "bad") die();
      s.items.push(t);
    },
  },
});
const cells = [notes];
if (Deno.env.get("LISTEN") === "1") {
  cells.push(cell("tally", {
    state: { n: 0 },
    methods: {
      onAdd(s) {
        s.n++;
      },
    },
    listensTo: { onAdd: notes.add },
  }));
}
const app = await aio.run({
  cells,
  appId: "unsettled-op-probe",
  client: "server-only",
  journal: Deno.env.get("JOURNAL") === "1",
  port: PORT,
  appDir: DIR,
});
if (PHASE === "read") {
  Deno.writeTextFileSync(
    DIR + "/recovered.json",
    JSON.stringify(app.getState().notes.items),
  );
  Deno.exit(0);
}
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const acks = new Set();
ws.onmessage = (e) => {
  try {
    const f = JSON.parse(e.data);
    if (f.t === "sync-ack") acks.add(f.d.opId);
  } catch { /* not a frame */ }
};
await new Promise((r) => (ws.onopen = r));
let n = 0;
const send = (arg) => {
  const id = "op-" + (++n);
  ws.send(JSON.stringify({
    v: 2,
    t: "op",
    d: {
      id,
      hlc: [Date.now(), n, "c1"],
      cell: "notes",
      action: "add",
      payload: { args: [arg] },
    },
  }));
  return id;
};
// PENDING: the op arrives in a `sync-req`'s pending list — the reconnect
// door — not as an `op` frame.
const sendPending = (arg) => {
  const id = "op-" + (++n);
  ws.send(JSON.stringify({
    v: 2,
    t: "sync-req",
    d: {
      clientId: "c1",
      cells: {},
      pendingOps: [{
        id,
        hlc: [Date.now(), n, "c1"],
        cell: "notes",
        action: "add",
        payload: { args: [arg] },
      }],
    },
  }));
  return id;
};
const first = (Deno.env.get("PENDING") === "1" ? sendPending : send)("n1");
while (!acks.has(first)) await new Promise((r) => setTimeout(r, 2));
// op-2: the method kills the process while it is in flight.
if (PHASE === "kill-refused") send("n1");
if (PHASE === "kill-accepted") send("n2");
if (PHASE === "kill-invalid") send("bad");
if (PHASE === "acked") die(); // op-1 acknowledged, nothing in flight
await new Promise((r) => setTimeout(r, 30000));
Deno.exit(3); // the kill never came
