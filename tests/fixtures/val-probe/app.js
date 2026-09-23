// A sync cell with a `validate` and a store listener — the probe for "a
// refused op has no reactions, live or at boot"
// (tests/journal-sync-op-refused-at-boot.test.ts).
const { aio, cell } = await import(Deno.env.get("MOD"));
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = cell("notes", {
  sync: true,
  version: 1,
  state: { items: [] },
  validate: (s) => s.items.every((t) => t !== "bad") || "no bad",
  methods: {
    add(s, t) {
      s.items.push(t);
    },
  },
});
const tally = cell("tally", {
  state: { n: 0 },
  methods: {
    on(s) {
      s.n++;
    },
  },
  listensTo: { on: notes.add },
});
const app = await aio.run({
  cells: [notes, tally],
  appId: "val-probe",
  client: "server-only",
  journal: Deno.env.get("JOURNAL") !== "0",
  ...(Deno.env.get("PERSIST") === "0" ? { persist: false } : {}),
  port: PORT,
  appDir: DIR,
});
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const frames = [];
ws.onmessage = (e) => {
  try {
    const f = JSON.parse(e.data);
    if (f.t === "sync-ack" || f.t === "op-rejected") {
      frames.push(f.t + ":" + f.d.opId);
    }
  } catch { /* not a frame */ }
};
await new Promise((r) => (ws.onopen = r));
const send = (id, t) =>
  ws.send(JSON.stringify({
    v: 2,
    t: "op",
    d: {
      id,
      hlc: [Date.now(), 1, "c1"],
      cell: "notes",
      action: "add",
      payload: { args: [t] },
    },
  }));
const report = () => {
  const s = app.getState();
  Deno.writeTextFileSync(
    DIR + "/report.json",
    JSON.stringify({ frames, notes: s.notes.items, tally: s.tally.n }),
  );
};
if (PHASE === "seed") {
  send("op-1", "ok1");
  send("op-live-bad", "bad");
} else if (PHASE === "resend") {
  send(Deno.env.get("RESEND") ?? "op-inj", "bad");
}
const want = PHASE === "seed" ? 2 : PHASE === "resend" ? 1 : 0;
const until = Date.now() + 5000;
while (frames.length < want && Date.now() < until) {
  await sleep(10);
}
report();
// KILL=1: no clean stop — only what the boot itself saved survives.
Deno.kill(Deno.pid, Deno.env.get("KILL") === "1" ? "SIGKILL" : "SIGTERM");
await sleep(5000);
