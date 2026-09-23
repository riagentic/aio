const { aio, cell } = await import(Deno.env.get("MOD"));
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const notes = cell("notes", {
  sync: true,
  version: 1,
  state: { items: [] },
  // An idempotency guard, as real apps write them: a replay that re-ran
  // this op on a state that already holds it would throw here.
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
    onAdd(s) {
      s.n++;
    },
  },
  listensTo: { onAdd: notes.add },
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
// A store-persisted listener with an onPersist SHAPE: its reaction is
// journalled as the stored shape and must come back as state.
const shaped = cell("shaped", {
  state: { n: 0 },
  onPersist: (s) => ({ saved: s.n }),
  onRestore: (s) => {
    if (typeof s.saved === "number") s.n = s.saved;
    delete s.saved;
  },
  methods: {
    onAdd(s) {
      s.n++;
    },
  },
  listensTo: { onAdd: notes.add },
});
const app = await aio.run({
  cells: [notes, tally, mirror, inbox, feed, shaped],
  appId: "sync-listener-journal-probe",
  client: "server-only",
  journal: true,
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
    inbox: s.inbox.posts,
    feed: s.feed.seen,
    shaped: s.shaped.n,
  };
};
if (PHASE === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  Deno.exit(0);
}
const trojan = async (type, arg) => {
  const res = await fetch(
    "http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ type, payload: { args: [arg] } }),
    },
  );
  const text = await res.text();
  if (res.status !== 200) throw new Error(res.status + " " + text);
};
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
/** One client sync op, acked. */
const op = async (cellName, action, arg) => {
  const id = "op-" + (++n);
  ws.send(JSON.stringify({
    v: 2,
    t: "op",
    d: {
      id,
      hlc: [Date.now(), n, "c1"],
      cell: cellName,
      action,
      payload: { args: [arg] },
    },
  }));
  while (!acks.has(id)) await sleep(2);
};
/** Notes ops (the listeners react), each followed now and then by a DIRECT
 *  op on the sync listener itself — acked, in the op-log only, and after the
 *  reaction: recovery must keep both, in that order. */
const ops = async (k) => {
  for (let i = 0; i < k; i++) {
    await op("notes", "add", "n" + (n + 1));
    if (i % 2 === 0) await op("mirror", "onAdd", "d" + (n + 1));
  }
};
const posts = async (k) => {
  for (let i = 0; i < k; i++) {
    await trojan("inbox:post", "p" + (++n));
    if (i % 2 === 0) await op("feed", "onPost", "d" + (n + 1));
  }
};
const done = () => {
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(snap()));
  Deno.kill(Deno.pid, "SIGKILL");
};
if (PHASE === "before-fold") {
  await ops(10);
  await posts(5);
  done();
} else if (PHASE === "after-fold") {
  await ops(8);
  await posts(4);
  await sleep(1500); // folded, persisted, the journal compacted
  await ops(6);
  await trojan("notes:add", "srv-" + (++n)); // a server write with reactions
  await posts(3);
  done();
} else if (PHASE === "fold-lags-persist") {
  // The persist lands while a listener's fold is held back (its own writes
  // keep re-arming the debounce, up to the 500 ms max wait): the KV action's
  // line is past the app-wide watermark while its reaction is in no snapshot.
  await posts(1);
  for (let i = 0; i < 12; i++) {
    await trojan("feed:onPost", "x" + (++n));
    await sleep(25);
  }
  done();
} else if (PHASE === "streaming") {
  // Kill at a random-ish point in a stream: persists and folds land on their
  // own clocks while writes keep coming, so the kill falls between them.
  for (let r = 0; r < 12; r++) {
    await ops(2);
    await posts(1);
    await sleep(35);
  }
  done();
}
