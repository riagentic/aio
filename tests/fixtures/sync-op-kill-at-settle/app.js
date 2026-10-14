// The app of tests/sync-op-killed-at-settle.test.ts: one sync cell with a
// `validate` that refuses without throwing, a store cell that listens to it,
// and a process that KILLS itself at the statement that settles op-2 — the
// mark of an accepted op, the delete of a refused one. The op is reduced and
// its journal line is on disk by then.
const { aio, cell } = await import(Deno.env.get("MOD"));
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const ARG = Deno.env.get("ARG");
if (PHASE === "kill") {
  // Every statement crosses to the SQLite worker as a message.
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, ...rest) {
    let s = "";
    try {
      s = JSON.stringify(m);
    } catch { /* not a statement */ }
    if (
      s.includes('"op-2"') &&
      /UPDATE sync_ops SET settled = 1|DELETE FROM sync_ops WHERE id/.test(s)
    ) Deno.kill(Deno.pid, "SIGKILL");
    return post.call(this, m, ...rest);
  };
}
const notes = cell("notes", {
  sync: true,
  version: 1,
  state: { items: [] },
  // REFUSE: the validate as a later deploy changed it — it refuses what it
  // once accepted.
  validate: (s) =>
    s.items.every((t) => t !== "bad" && t !== Deno.env.get("REFUSE")) ||
    "no bad",
  methods: {
    add(s, t) {
      s.items.push(t);
    },
  },
});
const tally = cell("tally", {
  state: { n: 0 },
  methods: {
    onAdd(s) {
      s.n++;
    },
  },
  listensTo: { onAdd: notes.add },
});
const app = await aio.run({
  cells: [notes, tally],
  appId: "kill-at-settle-probe",
  client: "server-only",
  journal: Deno.env.get("JOURNAL") === "1",
  port: PORT,
  appDir: DIR,
});
const result = (answer) => {
  const s = app.getState();
  console.log(
    "RESULT " + JSON.stringify({ answer, items: s.notes.items, n: s.tally.n }),
  );
  Deno.exit(0);
};
if (PHASE === "read") result();
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const answers = new Map();
ws.onmessage = (e) => {
  try {
    const f = JSON.parse(e.data);
    if (f.t === "sync-ack" || f.t === "op-rejected") {
      answers.set(f.d.opId, f.t);
    }
  } catch { /* not a frame */ }
};
await new Promise((r) => (ws.onopen = r));
const send = (n, arg) =>
  ws.send(JSON.stringify({
    v: 2,
    t: "op",
    d: {
      id: "op-" + n,
      hlc: [Date.now(), n, "c1"],
      cell: "notes",
      action: "add",
      payload: { args: [arg] },
    },
  }));
/** The server's answer to op `n` — or exit 3: none came. */
const answered = async (n) => {
  for (let i = 0; i < 10000 && !answers.has("op-" + n); i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  if (!answers.has("op-" + n)) Deno.exit(3);
  return answers.get("op-" + n);
};
if (PHASE === "kill") {
  send(1, "n1");
  await answered(1);
  send(2, ARG);
  await answered(2);
  Deno.exit(3); // the kill never came
}
// Both ops answered, then a kill: nothing in flight.
if (PHASE === "acked") {
  send(1, "n1");
  await answered(1);
  send(2, ARG);
  await answered(2);
  Deno.kill(Deno.pid, "SIGKILL");
}
// PHASE resend: the author never heard, and sends op-2 again.
send(2, ARG);
result(await answered(2));
