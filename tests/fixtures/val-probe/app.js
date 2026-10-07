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
if (Deno.env.get("KILL") === "1") Deno.kill(Deno.pid, "SIGKILL");
else if (Deno.build.os !== "windows") Deno.kill(Deno.pid, "SIGTERM");
else {
  // Windows has no SIGTERM — `Deno.kill` is TerminateProcess there, a kill —
  // so the clean stop is the request `am stop` sends, with this boot's
  // control credential (a build before 1.0.17 mints none, and asks for none).
  let key;
  try {
    key = Deno.readTextFileSync(DIR + "/data/control.key").trim();
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const res = await fetch(
    "http://127.0.0.1:" + PORT + "/__aio/trojan/shutdown",
    {
      method: "POST",
      headers: { "X-AIO": "1", ...(key ? { "X-Aio-Control": key } : {}) },
    },
  );
  const text = await res.text();
  if (res.status !== 200) throw new Error(res.status + " " + text);
}
await sleep(5000);
