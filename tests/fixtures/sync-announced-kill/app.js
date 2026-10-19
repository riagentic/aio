// The app of tests/sync-announced-kill.test.ts: a sync cell (`notes`, its
// `validate` refuses "bad…"), a store cell that listens to it, compaction
// every few ops — and, with KILLAT=n, a process that ANNOUNCES the n-th sync
// write (a statement to a sync_* table, or a journal append of a sync record)
// by writing FLAG, then SIGKILLs itself before that write leaves. The client
// that drives it is the test.
const { aio, cell } = await import(Deno.env.get("MOD"));
const { SYNC_DEFAULTS } = await import(
  new URL("src/sync/types.ts", Deno.env.get("MOD")).href
);
SYNC_DEFAULTS.compactOps = Number(Deno.env.get("COMPACT") ?? "4");
const PHASE = Deno.env.get("PHASE");
const KILLAT = Number(Deno.env.get("KILLAT") ?? "0");
const FLAG = Deno.env.get("FLAG");
let seen = 0;
const window = (what) => {
  ++seen;
  if (Deno.env.get("TRACE")) console.log(`WINDOW ${seen} ${what.slice(0, 90)}`);
  if (KILLAT > 0 && seen === KILLAT) {
    Deno.writeTextFileSync(FLAG, what.slice(0, 400));
    Deno.kill(Deno.pid, "SIGKILL");
  }
};
if (KILLAT > 0 || Deno.env.get("TRACE")) {
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, ...rest) {
    let s = "";
    try {
      s = JSON.stringify(m);
    } catch { /* not a statement */ }
    if (/(INSERT|UPDATE|DELETE)[^"]*sync_/.test(s)) window(s);
    return post.call(this, m, ...rest);
  };
  const write = Deno.FsFile.prototype.writeSync;
  Deno.FsFile.prototype.writeSync = function (b) {
    const s = new TextDecoder().decode(b);
    if (s.includes("__aioSync")) window("journal " + s);
    return write.call(this, b);
  };
  const writeText = Deno.writeTextFileSync;
  Deno.writeTextFileSync = (p, s, ...rest) => {
    if (typeof s === "string" && s.includes("__aioSync")) {
      window("journal " + s);
    }
    return writeText(p, s, ...rest);
  };
}
const notes = cell("notes", {
  sync: { offline: { retention: "48h" } },
  state: { items: [] },
  validate: (s) => s.items.every((t) => !t.startsWith("bad")) || "no bad",
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
  appId: "sync-announced-kill-probe",
  client: "server-only",
  journal: true,
  port: Number(Deno.env.get("PORT")),
  appDir: Deno.env.get("DIR"),
});
if (PHASE === "read") {
  const s = app.getState();
  console.log(
    "RESULT " + JSON.stringify({ items: s.notes.items, n: s.tally.n }),
  );
  Deno.exit(0);
}
console.log("READY");
