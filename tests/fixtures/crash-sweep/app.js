// Richer topology for the v1.0.9 -> tree sweep.
const realNow = Date.now;
let clockOff = 0;
Date.now = () => realNow() - clockOff;
// CHECKATOMIC=1: say how each journal write that marks a reduced `notes` op
// carries its reactions — in the same write, or not.
if (Deno.env.get("CHECKATOMIC") === "1") {
  const write = Deno.writeTextFileSync;
  Deno.writeTextFileSync = (path, data, opts) => {
    const text = String(data);
    if (
      String(path).endsWith("/journal") &&
      /"__aioSyncApplied".*"cell":"notes"/.test(text)
    ) {
      console.log(
        /__aioSyncReaction/.test(text) && /"tally"/.test(text)
          ? "ATOMIC-OK"
          : "ATOMIC-SPLIT",
      );
    }
    return write(path, data, opts);
  };
}
const { aio, cell } = await import(Deno.env.get("MOD"));
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const E = (k, d) => Deno.env.get(k) ?? d;
const notes = cell("notes", {
  sync: true,
  version: 1,
  state: { items: [] },
  methods: {
    add(s, t) {
      if (s.items.includes(t)) throw new Error("dup " + t);
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
const mirror = cell("mirror", {
  sync: true,
  version: 1,
  state: { got: [] },
  methods: {
    onAdd(s, t) {
      s.got.push(t);
    },
  },
  listensTo: { onAdd: notes.add },
});
// listener of a listener: KV and sync
const chain = cell("chain", {
  state: { n: 0 },
  methods: {
    on(s) {
      s.n++;
    },
  },
  listensTo: { on: mirror.onAdd },
});
const schain = cell("schain", {
  sync: true,
  version: 1,
  state: { n: 0 },
  methods: {
    on(s) {
      s.n++;
    },
  },
  listensTo: { on: mirror.onAdd },
});
const tasks = cell("tasks", {
  sync: true,
  version: 1,
  state: { list: [] },
  methods: {
    add(s, t) {
      s.list.push(t);
    },
  },
});
const tcount = cell("tcount", {
  sync: true,
  version: 1,
  state: { n: 0 },
  methods: {
    on(s) {
      s.n++;
    },
  },
  listensTo: { on: tasks.add },
});
const tkv = cell("tkv", {
  state: { n: 0 },
  methods: {
    on(s) {
      s.n++;
    },
  },
  listensTo: { on: tasks.add },
});
const inbox = cell("inbox", {
  state: { posts: [] },
  methods: {
    post(s, t) {
      s.posts.push(t);
    },
  },
});
const feed = cell("feed", {
  sync: true,
  version: 1,
  state: { seen: [] },
  methods: {
    onPost(s, t) {
      s.seen.push(t);
    },
  },
  listensTo: { onPost: inbox.post },
});
const kvl = cell("kvl", {
  state: { n: 0 },
  methods: {
    on(s) {
      s.n++;
    },
  },
  listensTo: { on: inbox.post },
});
const app = await aio.run({
  cells: [
    notes,
    tally,
    mirror,
    chain,
    schain,
    tasks,
    tcount,
    tkv,
    inbox,
    feed,
    kvl,
  ],
  appId: "legacy-sweep2",
  client: "server-only",
  journal: E("JOURNAL", "1") !== "0",
  ...(E("PERSIST", "1") === "0" ? { persist: false } : {}),
  ...(E("MULTI", "") ? { persistMode: "multi" } : {}),
  ...(E("PDM", "") ? { persistDebounceMs: Number(E("PDM")) } : {}),
  port: PORT,
  appDir: DIR,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => {
  const s = app.getState();
  return {
    notes: s.notes.items,
    tally: s.tally.n,
    mirror: s.mirror.got,
    chain: s.chain.n,
    schain: s.schain.n,
    tasks: s.tasks.list,
    tcount: s.tcount.n,
    tkv: s.tkv.n,
    inbox: s.inbox.posts,
    feed: s.feed.seen,
    kvl: s.kvl.n,
  };
};
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  Deno.exit(0);
}
if (PHASE === "clean") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  await sleep(200);
  Deno.kill(Deno.pid, "SIGTERM");
  await sleep(20000);
}
let seed = Number(E("SEED", "1"));
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
let tokens = 0;
setInterval(() => {
  tokens = 60;
}, 1000);
let stopping = false;
const trojan = async (type, arg) => {
  while (tokens <= 0) await sleep(20);
  tokens--;
  // A clean stop closes the server under a call in flight: that is the
  // stop, not a failure of the app — wait for the exit.
  const res = await fetch(
    "http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ type, payload: { args: [arg] } }),
    },
  ).catch(async (e) => {
    if (!stopping) throw e;
    await sleep(1e9);
  });
  const text = await res.text().catch(async (e) => {
    if (!stopping) throw e;
    await sleep(1e9);
    return "";
  });
  if (res.status !== 200) console.log("TROJAN", res.status, text.slice(0, 100));
};
const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
const acks = new Set();
ws.onmessage = (e) => {
  try {
    const f = JSON.parse(e.data);
    if (f.t === "sync-ack" || f.t === "op-rejected") acks.add(f.d.opId);
  } catch {}
};
await new Promise((r) => (ws.onopen = r));
// NBASE: a later run of the same data dir issues ids and items of its own.
let n = Number(E("NBASE", "0"));
const mk = (cellName, action, arg) => ({
  id: "op-" + (++n),
  hlc: [realNow(), n, "c1"],
  cell: cellName,
  action,
  payload: { args: [arg] },
});
const op = async (c, a, arg) => {
  const o = mk(c, a, arg);
  ws.send(JSON.stringify({ v: 2, t: "op", d: o }));
  while (!acks.has(o.id)) await sleep(1);
};
const burst = (k, dupEvery) => {
  const ps = [];
  for (let i = 0; i < k; i++) {
    const r = rnd();
    if (r < 0.6) {
      ps.push(
        mk(
          "notes",
          "add",
          dupEvery && i % dupEvery === 1 ? "x-dup" : "b" + (n + 1),
        ),
      );
    } else if (r < 0.8) ps.push(mk("tasks", "add", "t" + (n + 1)));
    else ps.push(mk("mirror", "onAdd", "d" + (n + 1)));
  }
  ws.send(
    JSON.stringify({
      v: 2,
      t: "sync-req",
      d: { clientId: "c1", cells: {}, pendingOps: ps },
    }),
  );
};
const STEPS = Number(E("STEPS", "60"));
const JUMPAT = Number(E("JUMPAT", "-1"));
const killAt = realNow() + Number(E("KILLMS", "3000"));
// STOPK=term: a clean stop at that moment instead of the kill.
setTimeout(() => {
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(snap()));
  stopping = true;
  Deno.kill(Deno.pid, E("STOPK", "kill") === "term" ? "SIGTERM" : "SIGKILL");
}, Number(E("KILLMS", "3000")));
if (E("DUPS", "")) await op("notes", "add", "x-dup");
for (let st = 0; st < STEPS * 10 && !stopping; st++) {
  if (st === JUMPAT) {
    clockOff = Number(E("JUMPMS", "5000"));
    console.log("CLOCK JUMP BACK", clockOff);
  }
  const r = rnd();
  if (r < 0.25) await op("notes", "add", "n" + (n + 1));
  else if (r < 0.35) await op("tasks", "add", "t" + (n + 1));
  else if (r < 0.42) await op("mirror", "onAdd", "d" + (n + 1));
  else if (r < 0.52) await trojan("inbox:post", "p" + (++n));
  else if (r < 0.57) await trojan("notes:add", "srv" + (++n));
  else if (r < 0.60) await trojan("mirror:onAdd", "sm" + (++n));
  else if (r < 0.62) await trojan("tasks:add", "st" + (++n));
  else if (r < 0.64) {
    burst(
      Math.floor(rnd() * Number(E("BURST", "300"))),
      E("DUPS", "") ? 2 + Math.floor(rnd() * 3) : 0,
    );
  } else await sleep(Math.floor(rnd() * Number(E("GAP", "30"))));
}
await sleep(1e9);
