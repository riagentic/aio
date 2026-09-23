// A sync cell `s` and a store-persisted cell `k`, written by server calls
// (`W` of each) and by client sync ops on `s` (`N`), then killed or closed.
// Prints BOOT (the state this boot restored) and LIVE (before the stop).
const { aio, cell } = await import(Deno.env.get("MOD"));
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const E = (k, d) => Deno.env.get(k) ?? d;
const s = cell("s", {
  sync: true,
  version: 1,
  state: { items: [] },
  methods: {
    add(x, t) {
      x.items.push(t);
    },
  },
});
const k = cell("k", {
  state: { n: 0 },
  methods: {
    inc(x) {
      x.n++;
    },
  },
});
// A store-persisted listener of `s` — and no sync one, so no fold takes a
// value after the last op.
const tally = cell("tally", {
  state: { n: 0 },
  methods: {
    on(x) {
      x.n++;
    },
  },
  listensTo: { on: s.add },
});
const app = await aio.run({
  cells: [s, k, tally],
  appId: "journal-toggle",
  client: "server-only",
  port: PORT,
  appDir: DIR,
  journal: E("J", "1") === "1",
  ...(E("MULTI", "") === "1" ? { persistMode: "multi" } : {}),
  persistDebounceMs: 50,
});
const snap = () => {
  const st = app.getState();
  return { s: st.s.items, k: st.k.n, tally: st.tally.n };
};
console.log("BOOT", JSON.stringify(snap()));
if (PHASE === "read") {
  await app.close();
  Deno.exit(0);
}
const call = async (type) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/__aio/trojan/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ type, payload: { args: [E("TAG", "a")] } }),
  });
  await r.text();
};
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const acks = new Set();
ws.onmessage = (e) => {
  try {
    const f = JSON.parse(e.data);
    if (f.t === "sync-ack" || f.t === "op-rejected") acks.add(f.d.opId);
  } catch { /* not a frame */ }
};
await new Promise((r) => (ws.onopen = r));
const tag = E("TAG", "a");
let i = 0;
const add = async (t) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/__aio/trojan/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ type: "s:add", payload: { args: [t] } }),
  });
  await r.text();
};
for (; i < Number(E("W", "0")); i++) {
  await add(`${tag}w${i}`);
  await call("k:inc");
}
for (let o = 1; o <= Number(E("N", "0")); o++) {
  const id = `${tag}o${o}`;
  ws.send(JSON.stringify({
    v: 2,
    t: "op",
    d: {
      id,
      hlc: [Date.now(), o, `c${tag}`],
      cell: "s",
      action: "add",
      payload: { args: [id] },
    },
  }));
  while (!acks.has(id)) await new Promise((r) => setTimeout(r, 2));
}
// A server write after the ops: its fold compacts `s` past them.
if (E("LATE", "0") === "1") await add(`${tag}late`);
await new Promise((r) => setTimeout(r, Number(E("SETTLE", "0"))));
console.log("LIVE", JSON.stringify(snap()));
if (E("STOP", "kill") === "kill") Deno.kill(Deno.pid, "SIGKILL");
ws.close();
await app.close();
Deno.exit(0);
