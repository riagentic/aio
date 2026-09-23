// What a `listensTo` listener sees of actions its owner refuses — a plain
// call (listeners run, as in 1.0.9) and a sync op (no reaction) — live and
// after a kill (tests/refused-action-no-reactions.test.ts).
const { aio, cell } = await import(Deno.env.get("MOD"));
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const src = cell("src", {
  state: { n: 0 },
  validate: (s) => s.n <= 2 || "max 2",
  methods: {
    inc(s) {
      s.n++;
    },
  },
});
const ssrc = cell("ssrc", {
  sync: true,
  version: 1,
  state: { n: 0 },
  validate: (s) => s.n <= 2 || "max 2",
  methods: {
    inc(s) {
      s.n++;
    },
  },
});
const audit = cell("audit", {
  state: { inc: 0, sinc: 0 },
  listensTo: { onInc: src.inc, onSinc: ssrc.inc },
  methods: {
    onInc(s) {
      s.inc++;
    },
    onSinc(s) {
      s.sinc++;
    },
  },
});
const app = await aio.run({
  cells: [src, ssrc, audit],
  appId: "refused-probe",
  client: "server-only",
  port: PORT,
  appDir: DIR,
  journal: true,
  persistDebounceMs: 999999,
});
const snap = () => {
  const s = app.getState();
  return {
    src: s.src.n,
    ssrc: s.ssrc.n,
    audit: { inc: s.audit.inc, sinc: s.audit.sinc },
  };
};
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  Deno.exit(0);
}
for (let i = 0; i < 4; i++) {
  await fetch(`http://127.0.0.1:${PORT}/__aio/trojan/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ type: "src:inc", payload: { args: [] } }),
  }).then((r) => r.text());
}
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const frames = [];
ws.onmessage = (e) => {
  try {
    const f = JSON.parse(e.data);
    if (f.t === "sync-ack" || f.t === "op-rejected") frames.push(f.t);
  } catch { /* not a frame */ }
};
await new Promise((r) => (ws.onopen = r));
for (let i = 1; i <= 4; i++) {
  ws.send(JSON.stringify({
    v: 2,
    t: "op",
    d: {
      id: "o" + i,
      hlc: [Date.now(), i, "c1"],
      cell: "ssrc",
      action: "inc",
      payload: { args: [] },
    },
  }));
}
while (frames.length < 4) await new Promise((r) => setTimeout(r, 10));
Deno.writeTextFileSync(
  DIR + "/live.json",
  JSON.stringify({ ...snap(), frames: frames.sort() }),
);
Deno.kill(Deno.pid, "SIGKILL");
