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
  journal: Deno.env.get("JOURNAL") !== "0",
  ...(Deno.env.get("PERSIST") === "0" ? { persist: false } : {}),
  ...(Deno.env.get("PDM")
    ? { persistDebounceMs: Number(Deno.env.get("PDM")) }
    : {}),
  port: PORT,
  appDir: DIR,
});
// FOLDFAULT=1: every fold of the sync listener "mirror" fails (the test
// drops these triggers before the next boot).
if (Deno.env.get("FOLDFAULT") === "1") {
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(DIR + "/data/state.db");
  d.exec("PRAGMA busy_timeout = 5000");
  for (const op of ["INSERT", "UPDATE"]) {
    d.exec(
      `CREATE TRIGGER fold_fault_${op} BEFORE ${op} ON sync_snapshots ` +
        `WHEN NEW.cell = 'mirror' BEGIN SELECT RAISE(ABORT, 'fold fault'); END`,
    );
  }
  d.close();
}
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
if (PHASE === "readkill") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(snap()));
  await sleep(Number(Deno.env.get("KILLAT") ?? "0"));
  Deno.kill(Deno.pid, "SIGKILL");
}
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
let maxDrift = -1e9;
ws.onmessage = (e) => {
  try {
    const f = JSON.parse(e.data);
    if (f.t === "sync-ack") {
      acks.add(f.d.opId);
      if (typeof f.d.serverTs === "number") {
        maxDrift = Math.max(maxDrift, f.d.serverTs - Date.now());
      }
    }
  } catch { /* not a frame */ }
};
await new Promise((r) => (ws.onopen = r));
let n = Number(Deno.env.get("NBASE") ?? "0");
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
const CLEAN = Deno.env.get("CLEAN") === "1";
const KILLAT = Number(Deno.env.get("KILLAT") ?? "0");
const done = async () => {
  if (KILLAT) await sleep(KILLAT);
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(snap()));
  // PERSISTFAULT=1: from here on every store write fails — the stop's final
  // save is refused (the test drops these triggers before the next boot).
  if (Deno.env.get("PERSISTFAULT") === "1") {
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(DIR + "/data/state.db");
    d.exec("PRAGMA busy_timeout = 5000");
    for (const op of ["INSERT", "UPDATE"]) {
      d.exec(
        `CREATE TRIGGER persist_fault_${op} BEFORE ${op} ON aio_kv ` +
          `BEGIN SELECT RAISE(ABORT, 'persist fault'); END`,
      );
    }
    d.close();
  }
  if (CLEAN) {
    ws.close();
    await sleep(50);
    Deno.kill(Deno.pid, "SIGTERM");
    await sleep(20000);
  }
  Deno.kill(Deno.pid, "SIGKILL");
};
if (PHASE === "before-fold") {
  await ops(10);
  await posts(5);
  await done();
} else if (PHASE === "after-fold") {
  await ops(8);
  await posts(4);
  await sleep(1500); // folded, persisted, the journal compacted
  await ops(6);
  await trojan("notes:add", "srv-" + (++n)); // a server write with reactions
  await posts(3);
  await done();
} else if (PHASE === "fold-lags-persist") {
  // The persist lands while a listener's fold is held back (its own writes
  // keep re-arming the debounce, up to the 500 ms max wait): the KV action's
  // line is past the app-wide watermark while its reaction is in no snapshot.
  await posts(1);
  for (let i = 0; i < 12; i++) {
    await trojan("feed:onPost", "x" + (++n));
    await sleep(25);
  }
  await done();
} else if (PHASE === "burst") {
  const B = Number(Deno.env.get("BURST") ?? "600");
  if (Deno.env.get("PRE")) {
    await trojan("inbox:post", "pre" + (++n));
    await sleep(Number(Deno.env.get("PRE")));
  }
  await ops(2);
  const ids = [];
  const pendingOps = [];
  for (let i = 0; i < B; i++) {
    const id = "op-" + (++n);
    ids.push(id);
    pendingOps.push({
      id,
      hlc: [Date.now(), n, "c1"],
      cell: "notes",
      action: "add",
      payload: { args: ["b" + n] },
    });
  }
  ws.send(
    JSON.stringify({
      v: 2,
      t: "sync-req",
      d: { clientId: "c1", cells: {}, pendingOps },
    }),
  );
  while (!ids.every((id) => acks.has(id))) await sleep(2);
  console.log("MAXDRIFT", maxDrift);
  if (Deno.env.get("POSTPRE")) {
    await sleep(Number(Deno.env.get("POSTPRE")));
    await trojan("inbox:post", "p" + (++n));
  }
  await sleep(Number(Deno.env.get("AFTER") ?? "0"));
  await done();
} else if (PHASE === "drift") {
  // A burst of sync ops (server_ts runs ahead of the wall clock) with KV
  // posts streaming beside it, so a save + the next journal line land
  // inside the drift window.
  const B = Number(Deno.env.get("BURST") ?? "800");
  await ops(1);
  const ids = [];
  const pendingOps = [];
  for (let i = 0; i < B; i++) {
    const id = "op-" + (++n);
    ids.push(id);
    pendingOps.push({
      id,
      hlc: [Date.now(), n, "c1"],
      cell: "notes",
      action: "add",
      payload: { args: ["b" + n] },
    });
  }
  let stop = false;
  const poster = (async () => {
    while (!stop) {
      await trojan("inbox:post", "p" + (++n));
      await sleep(Number(Deno.env.get("PGAP") ?? "3"));
    }
  })();
  await sleep(Number(Deno.env.get("PRE") ?? "0"));
  ws.send(
    JSON.stringify({
      v: 2,
      t: "sync-req",
      d: { clientId: "c1", cells: {}, pendingOps },
    }),
  );
  while (!ids.every((id) => acks.has(id))) await sleep(2);
  console.log("MAXDRIFT", maxDrift);
  await sleep(Number(Deno.env.get("AFTER") ?? "0"));
  stop = true;
  await poster;
  await done();
} else if (PHASE === "synconly") {
  // Only client sync ops: the journal never gets a line.
  const K = Number(Deno.env.get("K") ?? "20");
  for (let i = 0; i < K; i++) {
    await op("notes", "add", "n" + (n + 1));
    await sleep(Number(Deno.env.get("OGAP") ?? "20"));
  }
  await done();
} else if (PHASE === "more") {
  await ops(3);
  await posts(2);
  await trojan("notes:add", "srv-" + (++n));
  await done();
} else if (PHASE === "big") {
  const B = Number(Deno.env.get("BURST") ?? "2000");
  for (let c = 0; c < B; c += 500) {
    const ids = [];
    const pendingOps = [];
    for (let i = 0; i < 500; i++) {
      const id = "op-" + (++n);
      ids.push(id);
      pendingOps.push({
        id,
        hlc: [Date.now(), n, "c1"],
        cell: "notes",
        action: "add",
        payload: { args: ["b" + n] },
      });
    }
    ws.send(
      JSON.stringify({
        v: 2,
        t: "sync-req",
        d: { clientId: "c1", cells: {}, pendingOps },
      }),
    );
    while (!ids.every((id) => acks.has(id))) await sleep(2);
  }
  await done();
} else if (PHASE === "mixed") {
  for (let r = 0; r < 6; r++) {
    await ops(2);
    await posts(1);
    await trojan("notes:add", "srv-" + (++n));
    await trojan("mirror:onAdd", "sm-" + (++n));
    await sleep(Number(Deno.env.get("GAP") ?? "60"));
  }
  await done();
} else if (PHASE === "rejdrift") {
  // Like drift, but every other op of the burst is a DUPLICATE text: its
  // reduce throws, v1.0.9 deletes the row after stamping it — an issued
  // server_ts no row, tombstone or snapshot version shows.
  const B = Number(Deno.env.get("BURST") ?? "800");
  await ops(1);
  const ids = [];
  const pendingOps = [];
  for (let i = 0; i < B; i++) {
    const id = "op-" + (++n);
    ids.push(id);
    const dupEvery = Number(Deno.env.get("DUPEVERY") ?? "2");
    const txt = (i % dupEvery === 1) ? "n1" : "b" + n;
    pendingOps.push({
      id,
      hlc: [Date.now(), n, "c1"],
      cell: "notes",
      action: "add",
      payload: { args: [txt] },
    });
  }
  let stop = false;
  const poster = (async () => {
    while (!stop) {
      await trojan("inbox:post", "p" + (++n));
      await sleep(Number(Deno.env.get("PGAP") ?? "3"));
    }
  })();
  await sleep(Number(Deno.env.get("PRE") ?? "0"));
  ws.send(
    JSON.stringify({
      v: 2,
      t: "sync-req",
      d: { clientId: "c1", cells: {}, pendingOps },
    }),
  );
  const t0 = Date.now();
  while (Date.now() - t0 < Number(Deno.env.get("WAITMS") ?? "3000")) {
    await sleep(5);
  }
  console.log("MAXDRIFT", maxDrift);
  stop = true;
  await poster;
  await done();
} else if (PHASE === "syncburst") {
  await trojan("inbox:post", "p" + (++n));
  await ops(1);
  await sleep(300);
  const B = Number(Deno.env.get("BURST") ?? "1500");
  const ids = [];
  const pendingOps = [];
  for (let i = 0; i < B; i++) {
    const id = "op-" + (++n);
    ids.push(id);
    pendingOps.push({
      id,
      hlc: [Date.now(), n, "c1"],
      cell: "notes",
      action: "add",
      payload: { args: ["b" + n] },
    });
  }
  ws.send(
    JSON.stringify({
      v: 2,
      t: "sync-req",
      d: { clientId: "c1", cells: {}, pendingOps },
    }),
  );
  const t0 = Date.now();
  while (Date.now() - t0 < Number(Deno.env.get("WAITMS") ?? "3000")) {
    await sleep(1);
  }
  Deno.kill(Deno.pid, "SIGKILL");
} else if (PHASE === "seqops") {
  await trojan("inbox:post", "p" + (++n));
  await sleep(200);
  setTimeout(
    () => Deno.kill(Deno.pid, "SIGKILL"),
    Number(Deno.env.get("WAITMS") ?? "500"),
  );
  // pipelined: keep a few ops in flight, never a burst
  const inflight = Number(Deno.env.get("INFL") ?? "1");
  const go = async () => {
    for (;;) await op("notes", "add", "q" + (n + 1));
  };
  for (let i = 0; i < inflight; i++) go();
  await sleep(1e9);
} else if (PHASE === "stalebase") {
  await trojan("inbox:post", "p" + (++n));
  await sleep(400);
  if (Deno.env.get("BLOCKBASE") === "1") {
    Deno.mkdirSync(DIR + "/data/journal.base.tmp");
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 800) {
    await op("notes", "add", "q" + (n + 1));
    await sleep(5);
  }
  await sleep(300);
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(snap()));
  Deno.kill(Deno.pid, "SIGKILL");
} else if (PHASE === "streaming") {
  // Kill at a random-ish point in a stream: persists and folds land on their
  // own clocks while writes keep coming, so the kill falls between them.
  for (let r = 0; r < 12; r++) {
    await ops(2);
    await posts(1);
    await sleep(35);
  }
  await done();
}
